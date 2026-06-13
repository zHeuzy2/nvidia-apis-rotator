

const { Pool } = require('undici');
const dns = require('dns');

const rotatorService = require('./rotatorService');
const metricsService = require('./metricsService');
const apiConfig = require('../config/apiConfig');
const modelValidationService = require('./modelValidationService');
const modelsConfig = require('../config/modelsConfig');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/asyncLogger');
const { parseKimiToolCalls, hasKimiToolCalls, removeKimiTokens } = require('../utils/streamingUtils');

// ============================================

// ============================================
let cacheableLookup = null;
try {
  const CacheableLookupModule = require('cacheable-lookup');
  const CacheableLookup = CacheableLookupModule.default || CacheableLookupModule;
  cacheableLookup = new CacheableLookup({
    maxTtl: 3600,
    fallbackDuration: 300,
    errorTtl: 5
  });
} catch (e) {
  logger.warn('cacheable-lookup not available, DNS caching disabled');
}

dns.setDefaultResultOrder('ipv4first');

// ============================================
// PER-API CONNECTION POOLS (undici)

// ============================================
class ApiPoolManager {
  constructor() {
    this.pools = new Map();  // apiId → Pool
  }

  
  getPool(api) {
    if (this.pools.has(api.id)) {
      return this.pools.get(api.id);
    }

    const url = new URL(api.baseUrl);
    
    
    const poolOptions = {
      connections: 16,              
      pipelining: 1,
      allowH2: false,               
      keepAliveTimeout: 10000,      // 10s keep-alive
      keepAliveMaxTimeout: 30000,   
      bodyTimeout: 0,               
      headersTimeout: 30000,        
      connectTimeout: 10000,        
    };

    
    if (cacheableLookup) {
      try {
        cacheableLookup.install(poolOptions);
      } catch (e) {
        
      }
    }

    const pool = new Pool(url.origin, poolOptions);
    this.pools.set(api.id, pool);
    return pool;
  }

  
  destroyPool(apiId) {
    const pool = this.pools.get(apiId);
    if (pool) {
      try { pool.destroy(); } catch (e) { /* ignore */ }
      this.pools.delete(apiId);
    }
  }

  
  destroyAll() {
    for (const [id, pool] of this.pools) {
      try { pool.destroy(); } catch (e) { /* ignore */ }
    }
    this.pools.clear();
  }
}

const poolManager = new ApiPoolManager();

// ============================================

// ============================================
function normalizeUndiciError(error) {
  if (!error) {
    return { message: 'Erro desconhecido (null)', code: 'NULL_ERROR', response: null };
  }
  
  const errMessage = typeof error.message === 'string' ? error.message : String(error);
  
  const normalized = {
    message: errMessage || 'Erro desconhecido',
    code: error.code || 'UNKNOWN',
    response: null,
  };

  
  if (error.statusCode) {
    let errorData = null;
    if (error.body) {
      if (typeof error.body === 'string') {
        try { errorData = JSON.parse(error.body); } catch { errorData = { error: { message: error.body } }; }
      } else {
        errorData = error.body;
      }
    }
    normalized.response = {
      status: error.statusCode,
      data: errorData
    };
  }

  return normalized;
}

// ============================================

// ============================================
async function readResponseBody(response) {
  try {
    const text = await response.body.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ============================================
// PROXY SERVICE
// ============================================
class ProxyService {
  constructor() {
    this.maxRetries = 5;
    this.retryDelay = 1000;
    this.maxRetryDelay = 5000;

    
    this.modelTimeouts = {
      'moonshotai/kimi-k2.6': { base: 15000, perToken: 8 },
      'deepseek-ai/deepseek-v4-pro': { base: 30000, perToken: 10 },
      'z-ai/glm-5.1': { base: 25000, perToken: 9 },
      'minimaxai/minimax-m2.7': { base: 25000, perToken: 9 },
      'default': { base: 10000, perToken: 5 }
    };
  }

  
  calculateTimeout(body) {
    const model = body?.model || 'default';
    const config = this.modelTimeouts[model] || this.modelTimeouts.default;
    const maxTokens = body?.max_tokens || 2000;
    return Math.min(300000, config.base + (maxTokens * config.perToken));
  }

  
  calculateBackoff(attempt) {
    const base = this.retryDelay;
    const max = this.maxRetryDelay;
    const exponential = Math.min(base * Math.pow(2, attempt - 1), max);
    const jitter = Math.random() * 200;
    return exponential + jitter;
  }

  
  normalizeToolCalls(toolCalls, requestId) {
    if (!Array.isArray(toolCalls)) return toolCalls;
    
    const normalized = toolCalls.map((tc, idx) => {
      let toolCall = tc;
      
      if (typeof tc === 'string') {
        const match = tc.match(/^functions\.([a-zA-Z0-9_]+):(\d+)$/);
        if (match) {
          const [, name] = match;
          toolCall = {
            id: String(`call_${requestId.substring(0, 8)}_${idx}`),
            type: 'function',
            function: { name: String(name || ''), arguments: '{}' }
          };
        }
      }
      
      if (!toolCall.function) {
        toolCall = {
          id: String(toolCall.id || `call_${requestId.substring(0, 8)}_${idx}`),
          type: String(toolCall.type || 'function'),
          function: { name: '', arguments: '{}' }
        };
      }
      
      const func = toolCall.function;
      let args = {};
      if (func.arguments) {
        if (typeof func.arguments === 'string') {
          try { args = JSON.parse(func.arguments); } catch (e) { args = { raw: func.arguments }; }
        } else if (typeof func.arguments === 'object') {
          args = func.arguments;
        }
      }
      
      const cleanArgs = {};
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== null) {
          cleanArgs[key] = value;
        }
      }
      
      const normalizedToolCall = {
        id: String(toolCall.id || `call_${requestId.substring(0, 8)}_${idx}`),
        type: String(toolCall.type || 'function'),
        function: {
          name: String(func.name || ''),
          arguments: JSON.stringify(cleanArgs)
        }
      };
      
      return normalizedToolCall;
    });
    
    return normalized;
  }

  
  processMultimodalMessages(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map(msg => {
      if (!msg.content || !Array.isArray(msg.content)) return msg;

      const processedContent = msg.content.map(item => {
        if (item.type === 'image_url' && item.image_url) {
          const imageUrl = item.image_url.url || item.image_url;
          if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) return item;
          if (typeof imageUrl === 'string' && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) return item;
          if (typeof imageUrl === 'string') {
            item.image_url = { url: `data:image/png;base64,${imageUrl}` };
            return item;
          }
        }
        if (item.type === 'video_url' && item.video_url) {
          const videoUrl = item.video_url.url || item.video_url;
          if (typeof videoUrl === 'string' && videoUrl.startsWith('data:')) return item;
          if (typeof videoUrl === 'string' && (videoUrl.startsWith('http://') || videoUrl.startsWith('https://'))) return item;
          if (typeof videoUrl === 'string') {
            item.video_url = { url: `data:video/mp4;base64,${videoUrl}` };
            return item;
          }
        }
        return item;
      });

      return { ...msg, content: processedContent };
    });
  }

  
  async proxyRequest(endpoint, method, body, headers = {}) {
    const requestId = uuidv4();
    const startTime = Date.now();
    let lastError = null;
    let attempts = 0;
    let usedApi = null;

    const timeout = this.calculateTimeout(body);

    while (attempts < this.maxRetries) {
      try {
        const api = await rotatorService.getNextApi();
        usedApi = api;

        const requestHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${api.apiKey}`,
          ...headers
        };
        delete requestHeaders['authorization'];

        
        const pool = poolManager.getPool(api);

        
        const baseUrlObj = new URL(api.baseUrl);
        const basePath = baseUrlObj.pathname.replace(/\/$/, ''); // ex: '/v1'
        const fullPath = basePath + endpoint; // ex: '/v1/chat/completions'

        
        const response = await pool.request({
          method: method.toUpperCase(),
          path: fullPath,
          headers: requestHeaders,
          body: body ? JSON.stringify(body) : null,
          signal: AbortSignal.timeout(timeout),
        });

        
        
        if (response.statusCode === 429) {
          logger.info(`[${requestId}] Rate limit (429) em ${api.id}, tentando próxima API...`);
          
          try { await response.body.text(); } catch {}
          if (usedApi) rotatorService.recordFailure(usedApi.id);
          continue;
        }

        const responseTime = Date.now() - startTime;

        
        const responseData = await readResponseBody(response);

        
        rotatorService.recordLatency(api.id, responseTime);
        rotatorService.recordSuccess(api.id);

        
        const tokens = metricsService.extractTokensFromResponse(responseData);

        
        metricsService.recordRequest({
          requestId,
          apiId: api.id,
          model: body?.model || 'unknown',
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          responseTime,
          success: response.statusCode < 400,
          error: response.statusCode >= 400 ? responseData : null
        });

        // ============================================
        
        // ============================================
        if (responseData && typeof responseData === 'object') {
          responseData.id = (typeof responseData.id === 'string' && responseData.id.length > 0)
            ? responseData.id
            : `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`;
          responseData.model = String(responseData.model || body?.model || 'unknown');
          
          if (!responseData.object) {
            responseData.object = endpoint.includes('chat') ? 'chat.completion' :
                                  (endpoint.includes('embeddings') ? 'list' : 'text_completion');
          }
          responseData.object = String(responseData.object);

          if (!responseData.created) {
            responseData.created = Math.floor(Date.now() / 1000);
          } else {
            responseData.created = Number(responseData.created);
          }

          responseData.system_fingerprint = responseData.system_fingerprint || `fp_${uuidv4().substring(0, 12)}`;

          responseData.choices = Array.isArray(responseData.choices) ? responseData.choices : [];
          if (responseData.choices.length > 0) {
            responseData.choices = responseData.choices.map((choice, idx) => {
              choice.index = typeof choice.index === 'number' ? choice.index : idx;
              
              if (choice.finish_reason !== undefined) {
                choice.finish_reason = choice.finish_reason ? String(choice.finish_reason) : 'stop';
              } else {
                choice.finish_reason = 'stop';
              }

              if (choice.message) {
                choice.message.role = String(choice.message.role || 'assistant');
                
                if (choice.message.content !== null && choice.message.content !== undefined) {
                  choice.message.content = String(choice.message.content);
                } else if (!choice.message.tool_calls) {
                  choice.message.content = "";
                }

                const toolCalls = choice.message?.tool_calls;
                if (Array.isArray(toolCalls)) {
                  choice.message.tool_calls = this.normalizeToolCalls(toolCalls, requestId);
                } else {
                  // Check for Kimi-style tool calls embedded in content (|tool_call_begin|...|tool_call_end|)
                  const content = choice.message?.content;
                  if (content && hasKimiToolCalls(content)) {
                    const parsedKimi = parseKimiToolCalls(content);
                    if (parsedKimi.length > 0) {
                      choice.message.tool_calls = parsedKimi.map((tc, idx) => ({
                        id: `call_kimi_${idx}_${Date.now()}`,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.arguments }
                      }));
                      choice.message.content = removeKimiTokens(content);
                    } else {
                      choice.message.tool_calls = [];
                    }
                  } else {
                    choice.message.tool_calls = [];
                  }
                }

                const modelConfig = modelsConfig.getModel(body?.model);
                const thinkingField = modelConfig?.thinkingField;
                if (thinkingField && choice.message?.[thinkingField]) {
                  choice.message[thinkingField] = String(choice.message[thinkingField] || '');
                }

                const thinkingTags = modelConfig?.thinkingTags || modelConfig?.thinkingConfig?.thinkingTags;
                if (thinkingTags && choice.message?.content) {
                  const { open, close } = thinkingTags;
                  const openEscaped = open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const closeEscaped = close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const thinkingRegex = new RegExp(`${openEscaped}([\\s\\S]*?)${closeEscaped}`, 'g');
                  const thinkingMatch = choice.message.content?.match(thinkingRegex);

                  if (thinkingMatch) {
                    const thinkingContent = thinkingMatch.map(t => {
                      return t.replace(new RegExp(`^${openEscaped}`), '').replace(new RegExp(`${closeEscaped}$`), '');
                    }).join('').trim();

                    if (thinkingContent && thinkingField) {
                      choice.message[thinkingField] = thinkingContent;
                    }

                    choice.message.content = choice.message.content.replace(thinkingRegex, '').trim();
                  }
                }

                // ============================================
                
                
                
                
                
                // ============================================
              }

              return choice;
            });
          }

          const usage = responseData.usage || {};
          responseData.usage = {
            prompt_tokens: Number(usage.prompt_tokens || usage.prompt_tokens_details?.cached_tokens || 0),
            completion_tokens: Number(usage.completion_tokens || 0),
            total_tokens: Number(usage.total_tokens || 0)
          };
          
          if (responseData.usage.total_tokens === 0) {
            responseData.usage.total_tokens = responseData.usage.prompt_tokens + responseData.usage.completion_tokens;
          }
        }

        return {
          success: response.statusCode < 400,
          status: response.statusCode,
          data: responseData,
          meta: {
            requestId,
            apiUsed: api.id,
            responseTime,
            tokens,
            attempt: attempts + 1
          }
        };

      } catch (error) {
        lastError = error;
        attempts++;

        const responseTime = Date.now() - startTime;
        const normalized = normalizeUndiciError(error);
        const errMsg = (error && error.message) ? error.message : String(error);

        
        if (normalized.response?.status === 429) {
          logger.info(`[${requestId}] Rate limit atingido em ${usedApi?.id || '?'}, tentando próxima API...`);
          continue;
        }

        
        try {
          if (usedApi) {
            rotatorService.recordFailure(usedApi.id);
            metricsService.recordRequest({
              requestId,
              apiId: usedApi.id,
              model: body?.model || 'unknown',
              inputTokens: 0,
              outputTokens: 0,
              responseTime,
              success: false,
              error: errMsg
            });
          }
        } catch (innerErr) {
          console.error(`[${requestId}] Erro interno ao registrar falha:`, innerErr.message);
        }

        
        if (normalized.response?.status && normalized.response.status >= 500) {
          logger.warn(`[${requestId}] Erro de servidor (${normalized.response.status}), tentativa ${attempts}/${this.maxRetries}`);
          await this.sleep(this.calculateBackoff(attempts));
          continue;
        }

        
        
        if (normalized.response?.status && normalized.response.status >= 400 && normalized.response.status < 500) {
          if (normalized.response.status === 404) {
            
            logger.warn(`[${requestId}] Modelo não encontrado na API ${usedApi?.id}, tentando próxima...`);
            continue;
          }
          
          const errorData = normalized.response.data || {};
          if (typeof errorData === 'object' && !Array.isArray(errorData)) {
            errorData.id = String(errorData.id || requestId);
          }
          
          return {
            success: false,
            status: normalized.response.status,
            data: errorData,
            meta: {
              requestId,
              apiUsed: usedApi?.id,
              responseTime,
              tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              attempt: attempts
            }
          };
        }

        
        logger.warn(`[${requestId}] Erro (${error?.code || 'UNKNOWN'}): ${errMsg}, tentativa ${attempts}/${this.maxRetries}`);
        await this.sleep(this.calculateBackoff(attempts));
      }
    }

    // Todas as tentativas falharam
    return {
      success: false,
      status: 503,
      data: {
        id: `err-${requestId}`,
        error: {
          message: `Todas as ${this.maxRetries} tentativas falharam`,
          lastError: (lastError && lastError.message) ? lastError.message : 'Erro desconhecido'
        }
      },
      meta: {
        requestId,
        apiUsed: usedApi?.id,
        responseTime: Date.now() - startTime,
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        attempt: attempts
      }
    };
  }

  
  async chatCompletions(body, headers = {}) {
    const validation = modelValidationService.validateRequest(body);

    if (validation.warnings.length > 0) {
      logger.warn(`[Model Validation] Warnings: ${validation.warnings.join('; ')}`);
    }
    if (validation.errors.length > 0) {
      logger.error(`[Model Validation] Errors: ${validation.errors.join('; ')}`);
    }

    const validatedBody = validation.validatedBody;

    
    const modelInfo = modelsConfig.getModel(validatedBody.model);
    if (modelInfo?.recommendedMinTokens && (!validatedBody.max_tokens || validatedBody.max_tokens < modelInfo.recommendedMinTokens)) {
      const original = validatedBody.max_tokens || 0;
      validatedBody.max_tokens = modelInfo.recommendedMinTokens;
      logger.debug(`[TokenBump] ${validatedBody.model}: max_tokens ${original} → ${modelInfo.recommendedMinTokens}`);
    }

    if (validatedBody.messages && Array.isArray(validatedBody.messages)) {
      const hasMultimodal = validatedBody.messages.some(msg =>
        msg.content && Array.isArray(msg.content) &&
        msg.content.some(item => item.type === 'image_url' || item.type === 'video_url')
      );
      if (hasMultimodal) {
        logger.info(`[Multimodal] Detected image/video content for model ${validatedBody.model}`);
      }
      validatedBody.messages = this.processMultimodalMessages(validatedBody.messages);
    }

    const result = await this.proxyRequest('/chat/completions', 'POST', validatedBody, headers);

    if (result.meta) {
      result.meta.validationWarnings = validation.warnings;
      result.meta.validationErrors = validation.errors;
    }

    return result;
  }

  
  async completions(body, headers = {}) {
    return this.proxyRequest('/completions', 'POST', body, headers);
  }

  
  async embeddings(body, headers = {}) {
    return this.proxyRequest('/embeddings', 'POST', body, headers);
  }

  
  async genericProxy(endpoint, method, body, headers = {}) {
    return this.proxyRequest(endpoint, method, body, headers);
  }

  
  async proxyStreamRequest(endpoint, method, body, headers = {}, onData, excludeApis = []) {
    const requestId = uuidv4();
    const startTime = Date.now();
    let attempts = 0;
    let lastError = null;
    const currentExcludeList = [...excludeApis];

    while (attempts < this.maxRetries) {
      let api = null;
      let apiStartTime = Date.now();
      try {
        api = await rotatorService.getNextApi(null, currentExcludeList);
        
        const requestHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${api.apiKey}`,
          'Accept': 'text/event-stream',
          ...headers
        };
        delete requestHeaders['authorization'];

        const pool = poolManager.getPool(api);
        
        const baseUrlObj = new URL(api.baseUrl);
        const basePath = baseUrlObj.pathname.replace(/\/$/, '');
        const fullPath = basePath + endpoint;
        
        apiStartTime = Date.now();
        const response = await pool.request({
          method: method.toUpperCase(),
          path: fullPath,
          headers: requestHeaders,
          body: JSON.stringify({ ...body, stream: true }),
          signal: AbortSignal.timeout(300000), 
        });

        
        if (response.statusCode === 429 || response.statusCode === 404) {
          logger.info(`[Streaming] Status ${response.statusCode} em ${api.id}, tentando próxima API...`);
          try { await response.body.text(); } catch {}
          rotatorService.recordFailure(api.id);
          if (!currentExcludeList.includes(api.id)) currentExcludeList.push(api.id);
          attempts++;
          continue;
        }

        
        if (response.statusCode >= 400) {
          const bodyText = await response.body.text();
          logger.warn(`[Streaming] Erro HTTP ${response.statusCode} em ${api.id}: ${bodyText.substring(0, 200)}`);
          rotatorService.recordFailure(api.id);
          if (!currentExcludeList.includes(api.id)) currentExcludeList.push(api.id);
          attempts++;
          continue;
        }

        
        const stream = response.body;
        const finalApiId = api.id;
        const finalApiStartTime = apiStartTime;

        return {
          stream,
          requestId,
          apiUsed: finalApiId,
          cancelSource: null,
          onComplete: (tokens) => {
            const responseTime = Date.now() - finalApiStartTime;
            metricsService.recordRequest({
              requestId,
              apiId: finalApiId,
              model: body?.model || 'unknown',
              inputTokens: tokens?.inputTokens || 0,
              outputTokens: tokens?.outputTokens || 0,
              responseTime,
              success: true
            });
          }
        };

      } catch (error) {
        lastError = error;
        attempts++;
        const responseTime = Date.now() - apiStartTime;
        
        if (api) {
          logger.warn(`[Streaming Error] Falha inicial na API ${api.id} (tentativa ${attempts}/${this.maxRetries}): ${error.message}`);
          rotatorService.recordFailure(api.id);
          if (!currentExcludeList.includes(api.id)) currentExcludeList.push(api.id);
          
          metricsService.recordRequest({
            requestId,
            apiId: api.id,
            model: body?.model || 'unknown',
            inputTokens: 0,
            outputTokens: 0,
            responseTime,
            success: false,
            error: error.message
          });
        } else {
          logger.error(`[Streaming Error] Erro ao obter API da fila: ${error.message}`);
        }
        
        await this.sleep(200); // Backoff leve
      }
    }

    throw new Error(`Todas as ${this.maxRetries} chaves de API falharam ao iniciar o stream. Último erro: ${lastError ? lastError.message : 'desconhecido'}`);
  }

  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new ProxyService();
