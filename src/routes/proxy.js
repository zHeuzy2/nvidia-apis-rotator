/**
 * Rotas de Proxy para NVIDIA NIM API
 * Compatível com OpenAI API format
 */

const express = require('express');
const router = express.Router();
const proxyService = require('../services/proxyService');
const { proxyAuthMiddleware } = require('../middleware/auth');
const modelsConfig = require('../config/modelsConfig');
const rotatorService = require('../services/rotatorService');
const modelValidationService = require('../services/modelValidationService');
const {
  ToolCallBuffer,
  formatSSE,
  formatDone,
  logToolCall
} = require('../utils/streamingUtils');
const logger = require('../utils/asyncLogger');

// Cache for models endpoint (static data)
let modelsCache = null;
let modelsCacheTimestamp = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute
const MAX_STALL_RETRIES = 1;

function getModelsFromCache() {
  const now = Date.now();
  if (!modelsCache || now - modelsCacheTimestamp > MODELS_CACHE_TTL) {
    modelsCache = modelsConfig.getModelsListResponse();
    modelsCacheTimestamp = now;
  }
  return modelsCache;
}

// Aplica autenticação em todas as rotas de proxy
router.use(proxyAuthMiddleware);

/**
 * POST /v1/chat/completions
 */
router.post('/chat/completions', async (req, res) => {
  try {
    const body = req.body;
    if (body.stream === true) {
      const validation = modelValidationService.validateRequest(body);
      return handleStreamRequest(req, res, '/chat/completions', validation.validatedBody, validation.warnings);
    }
    const result = await proxyService.chatCompletions(body);
    res.set('X-Request-Id', result.meta.requestId);
    res.set('X-Api-Used', result.meta.apiUsed);
    res.set('X-Response-Time', `${result.meta.responseTime}ms`);
    res.set('X-Validation-Warnings', JSON.stringify(result.meta.validationWarnings || []));
    res.status(result.status).json(result.data);
  } catch (error) {
    logger.error('Erro em chat/completions:', error.message);
    res.status(500).json({ error: { message: error.message, type: 'proxy_error' } });
  }
});

/**
 * POST /v1/completions
 */
router.post('/completions', async (req, res) => {
  try {
    const body = req.body;
    if (body.stream === true) {
      return handleStreamRequest(req, res, '/completions', body);
    }
    const result = await proxyService.completions(body);
    res.set('X-Request-Id', result.meta.requestId);
    res.set('X-Api-Used', result.meta.apiUsed);
    res.set('X-Response-Time', `${result.meta.responseTime}ms`);
    res.status(result.status).json(result.data);
  } catch (error) {
    logger.error('Erro em completions:', error.message);
    res.status(500).json({ error: { message: error.message, type: 'proxy_error' } });
  }
});

/**
 * POST /v1/embeddings
 */
router.post('/embeddings', async (req, res) => {
  try {
    const result = await proxyService.embeddings(req.body);
    res.set('X-Request-Id', result.meta.requestId);
    res.set('X-Api-Used', result.meta.apiUsed);
    res.set('X-Response-Time', `${result.meta.responseTime}ms`);
    res.status(result.status).json(result.data);
  } catch (error) {
    logger.error('Erro em embeddings:', error.message);
    res.status(500).json({ error: { message: error.message, type: 'proxy_error' } });
  }
});

/**
 * GET /v1/models
 */
router.get('/models', async (req, res) => {
  try {
    res.status(200).json(getModelsFromCache());
  } catch (error) {
    logger.error('Erro em models:', error.message);
    res.status(500).json({ error: { message: error.message, type: 'proxy_error' } });
  }
});

/**
 * Catch-all para outros endpoints
 */
router.all('/*', async (req, res) => {
  try {
    const endpoint = req.path;
    const method = req.method;
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? req.body : null;
    const result = await proxyService.genericProxy(endpoint, method, body);
    res.set('X-Request-Id', result.meta.requestId);
    res.set('X-Api-Used', result.meta.apiUsed);
    res.status(result.status).json(result.data);
  } catch (error) {
    logger.error('Erro em proxy genérico:', error.message);
    res.status(500).json({ error: { message: error.message, type: 'proxy_error' } });
  }
});

/**
 * Handler para requisições com streaming
 *
 * ESTRATÉGIA v5.0:
 * - TEXTO: Streaming real com flush imediato
 * - TOOL CALLS: Buffer inteligente com tratamento de JSON duplicado
 * - KIMI: Parsing de tokens técnicos no content
 */
async function handleStreamRequest(req, res, endpoint, body, warnings = []) {
  const startTime = Date.now();

  const modelConfig = modelsConfig.getModel(body?.model);
  const thinkingField = modelConfig?.thinkingField || 'reasoning_content';

  // Auto-bump max_tokens para modelos thinking
  if (modelConfig?.recommendedMinTokens && (!body.max_tokens || body.max_tokens < modelConfig.recommendedMinTokens)) {
    body.max_tokens = modelConfig.recommendedMinTokens;
  }

  // Inject thinking parameter for models that support separate_field reasoning
  if (modelConfig?.supportsThinking && !body.thinking) {
    if (modelConfig.thinkingFormat === 'separate_field') {
      body.thinking = { type: modelConfig.thinkingConfig?.enabledType || 'enabled' };
      logger.debug(`[Thinking] Enabled ${modelConfig.thinkingFormat} thinking for ${body.model}`);
    }
  }

  // Extract allowed tool names from client request
  const allowedToolNames = new Set(
    (body?.tools || [])
      .map(t => t?.function?.name)
      .filter(Boolean)
  );

  function validateToolCalls(toolCalls) {
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) return [];
    if (allowedToolNames.size === 0) {
      logger.warn('[ToolValidation] No tools in request - blocking all tool calls');
      return [];
    }
    const validToolCalls = [];
    let invalidCount = 0;
    for (const toolCall of toolCalls) {
      const toolName = toolCall?.function?.name;
      if (!toolName) { invalidCount++; continue; }
      if (!allowedToolNames.has(toolName)) {
        invalidCount++;
        logger.warn(`[ToolValidation] Invalid tool call: "${toolName}" - not in client request`);
        continue;
      }
      const argsStr = toolCall?.function?.arguments;
      if (argsStr !== undefined && argsStr !== null && typeof argsStr !== 'string') {
        invalidCount++;
        continue;
      }
      if (argsStr && argsStr.trim() !== '') {
        try { JSON.parse(argsStr); } catch (e) { invalidCount++; continue; }
      }
      validToolCalls.push(toolCall);
    }
    if (invalidCount > 0) {
      logger.warn(`[ToolValidation] Filtered ${invalidCount} invalid, ${validToolCalls.length} valid`);
    }
    return validToolCalls;
  }

  try {
    const excludedApis = [];
    let currentStreamResult = null;
    let stallRetryCount = 0;
    let contentChunksSent = 0;
    let reasoningChunksSent = 0;

    let inputTokens = 0;
    let outputTokens = 0;
    let lineBuffer = '';
    let pendingDone = false;
    let pendingToolCallFinish = false;
    let originalFinishReason = null;
    let chunkCount = 0;
    let sseEventCount = 0;
    let toolCallBuffer = new ToolCallBuffer();
    let baseChunk = null;
    let isInsideThinkingBlock = false;
    let partialTagBuffer = '';
    let firstEventTime = null;
    let stallTimer = null;
    let connectionClosed = false;

    const thinkingTags = modelConfig?.thinkingTags || modelConfig?.thinkingConfig?.thinkingTags;
    const thinkingOpen = thinkingTags?.open || null;
    const thinkingClose = thinkingTags?.close || null;
    const isThinkingModel = !!(thinkingOpen || modelConfig?.supportsThinking);
    const stallTimeoutMs = isThinkingModel ? 45000 : 25000;

    function resetStreamingState() {
      inputTokens = 0;
      outputTokens = 0;
      lineBuffer = '';
      pendingDone = false;
      pendingToolCallFinish = false;
      chunkCount = 0;
      sseEventCount = 0;
      toolCallBuffer = new ToolCallBuffer();
      baseChunk = null;
      isInsideThinkingBlock = false;
      partialTagBuffer = '';
      firstEventTime = null;
      reasoningChunksSent = 0;
      originalFinishReason = null;
    }

    function detachStream(streamResult) {
      if (!streamResult) return;
      const s = streamResult.stream;
      s.removeAllListeners('data');
      s.removeAllListeners('end');
      s.removeAllListeners('error');
      // Adiciona listener dummy para engolir erros assíncronos pós-destruição (ex: RequestAbortedError)
      s.on('error', () => {});
      if (!s.destroyed) s.destroy();
    }

    async function attemptStallRetry() {
      if (stallRetryCount >= MAX_STALL_RETRIES) {
        logger.warn(`[Streaming] Stall retry limit reached (${MAX_STALL_RETRIES}), not retrying`);
        return false;
      }
      if (contentChunksSent > 0) return false;

      const stalledApiId = currentStreamResult?.apiUsed;
      if (stalledApiId) {
        rotatorService.recordFailure(stalledApiId);
        if (!excludedApis.includes(stalledApiId)) excludedApis.push(stalledApiId);
      }
      stallRetryCount++;

      try {
        if (currentStreamResult?.cancelSource) {
          currentStreamResult.cancelSource.cancel('Stall detected, retrying');
        } else if (currentStreamResult?.stream) {
          currentStreamResult.stream.destroy();
        }
      } catch (abortErr) { /* non-critical */ }

      detachStream(currentStreamResult);

      let newStreamResult;
      try {
        newStreamResult = await proxyService.proxyStreamRequest(endpoint, 'POST', body, {}, undefined, excludedApis);
      } catch (retryErr) {
        logger.warn(`[Streaming] Stall retry failed - no APIs available: ${retryErr.message}`);
        return false;
      }

      logger.info(`[Streaming] Stall retry - switching from ${stalledApiId} to ${newStreamResult.apiUsed}`);
      resetStreamingState();
      currentStreamResult = newStreamResult;
      wireStreamHandlers(newStreamResult);
      resetStallTimer();
      return true;
    }

    function resetStallTimer() {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(async () => {
        logger.warn(`[Streaming] Stall detected after ${stallTimeoutMs}ms (retry ${stallRetryCount}/${MAX_STALL_RETRIES})`);
        const retried = await attemptStallRetry();
        if (retried) return;

        logger.warn(`[Streaming] Stall abort`);
        if (toolCallBuffer.hasPending() && baseChunk) {
          let toolCalls = toolCallBuffer.getCompleteToolCalls();
          toolCalls = validateToolCalls(toolCalls);
          if (toolCalls.length > 0) {
            safeWriteSSE(formatSSE({ ...baseChunk, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolCalls }, finish_reason: null }] }));
            safeWriteSSE(formatSSE({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
          }
        }
        safeWriteSSE(formatDone());
        safeEndConnection();
        if (currentStreamResult) {
          detachStream(currentStreamResult);
        }
      }, stallTimeoutMs);
    }

    function safeEndConnection() {
      if (connectionClosed || res.writableEnded) return;
      connectionClosed = true;
      try { res.end(); } catch (e) { /* ignore */ }
    }

    function safeWriteSSE(data) {
      if (connectionClosed || res.writableEnded) {
        if (!connectionClosed) connectionClosed = true;
        return false;
      }
      if (firstEventTime === null) {
        firstEventTime = Date.now();
        logger.info(`[Streaming] TTFB: ${firstEventTime - startTime}ms (model=${body?.model || 'unknown'})`);
      }
      sseEventCount++;
      res.write(data);
      return true;
    }

    function wireStreamHandlers(streamResult) {

      streamResult.stream.on('data', (chunk) => {
        chunkCount++;
        resetStallTimer();
        lineBuffer += chunk.toString();

        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            if (line.trim() === '') res.write('\n');
            continue;
          }

          const data = line.slice(6).trim();

          if (data === '[DONE]') { pendingDone = true; continue; }

          const idMatch = data.match(/"id"\s*:\s*(\d{16,})/);
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            safeWriteSSE(line + '\n\n');
            continue;
          }

          // Normalize IDs to strings
          if (idMatch && typeof parsed.id === 'number') {
            parsed.id = idMatch[1];
          } else if (parsed.id !== undefined) {
            parsed.id = String(parsed.id);
          }

          if (parsed.choices) {
            for (const choice of parsed.choices) {
              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  if (tc.id !== undefined && tc.id !== null) tc.id = String(tc.id);
                }
              }
            }
          }

          if (!baseChunk) {
            baseChunk = {
              id: String(parsed.id || `chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`),
              object: String(parsed.object || 'chat.completion.chunk'),
              created: Number(parsed.created || Math.floor(Date.now() / 1000)),
              model: String(parsed.model || 'unknown'),
            };
          }

          const choice = parsed.choices?.[0];
          if (!choice) {
            safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
            continue;
          }

          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          // ─── TOOL CALLS: accumulate first ───
          if (delta?.tool_calls) {
            toolCallBuffer.accumulate(delta);
            if (delta.content == null && !delta[thinkingField] && !delta.role) continue;
            delete delta.tool_calls;
          }

          // ─── INTERLEAVED THINKING (MiniMax, GLM) ───
          if (thinkingOpen && thinkingClose && delta?.content != null) {
            let content = partialTagBuffer + delta.content;
            partialTagBuffer = '';

            const tagToCheck = isInsideThinkingBlock ? thinkingClose : thinkingOpen;
            if (tagToCheck && !content.includes(tagToCheck)) {
              for (let prefixLen = Math.min(tagToCheck.length - 1, content.length); prefixLen >= 3; prefixLen--) {
                if (content.endsWith(tagToCheck.substring(0, prefixLen))) {
                  partialTagBuffer = content.substring(content.length - prefixLen);
                  content = content.substring(0, content.length - prefixLen);
                  break;
                }
              }
            }

            if (!content && partialTagBuffer) continue;

            if (isInsideThinkingBlock) {
              if (content.includes(thinkingClose)) {
                const closeIdx = content.indexOf(thinkingClose);
                const thinkContent = content.substring(0, closeIdx);
                const afterClose = content.substring(closeIdx + thinkingClose.length);
                isInsideThinkingBlock = false;
                if (thinkContent) {
                  parsed.choices[0].delta = { [thinkingField]: thinkContent };
                  reasoningChunksSent++;
                  safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
                }
                if (afterClose) {
                  contentChunksSent++;
                  parsed.choices[0].delta = { content: afterClose };
                  safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
                }
              } else {
                parsed.choices[0].delta = { [thinkingField]: content };
                reasoningChunksSent++;
                safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
              }
              continue;
            }

            if (content.includes(thinkingOpen)) {
              isInsideThinkingBlock = true;
              const openIdx = content.indexOf(thinkingOpen);
              const beforeThink = content.substring(0, openIdx);
              const afterOpen = content.substring(openIdx + thinkingOpen.length);
              if (beforeThink) {
                contentChunksSent++;
                parsed.choices[0].delta = { content: beforeThink };
                safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
              }
              if (afterOpen.includes(thinkingClose)) {
                const closeIdx = afterOpen.indexOf(thinkingClose);
                const thinkContent = afterOpen.substring(0, closeIdx);
                const afterClose = afterOpen.substring(closeIdx + thinkingClose.length);
                isInsideThinkingBlock = false;
                if (thinkContent) {
                  parsed.choices[0].delta = { [thinkingField]: thinkContent };
                  reasoningChunksSent++;
                  safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
                }
                if (afterClose) {
                  contentChunksSent++;
                  parsed.choices[0].delta = { content: afterClose };
                  safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
                }
              } else if (afterOpen) {
                parsed.choices[0].delta = { [thinkingField]: afterOpen };
                reasoningChunksSent++;
                safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
              }
              continue;
            }

            delta.content = content;
          }

          // ─── TEXTO ───
          if (delta?.content != null) {
            const { cleanContent, foundToolCalls } = toolCallBuffer.bufferKimiContent(delta.content);
            if (foundToolCalls) logger.info(`[KimiParser] Tool calls detectadas via content buffering`);
            if (cleanContent) {
              contentChunksSent++;
              delta.content = cleanContent;
              safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
              continue;
            }
            if (foundToolCalls || toolCallBuffer.kimiContentBuffering) continue;
          }

          // ─── REASONING (Kimi/DeepSeek separate_field) ───
          if (delta?.[thinkingField] !== undefined) {
            reasoningChunksSent++;
            safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
            continue;
          }

          // ─── ROLE sem conteúdo ───
          if (delta?.role && !delta?.tool_calls && delta?.content == null) {
            safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
            continue;
          }

          // ─── FINISH: stop ───
          if (finishReason === 'stop') {
            if (toolCallBuffer.hasPending()) {
              pendingToolCallFinish = true;
              originalFinishReason = finishReason;
              continue;
            }
            safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
            continue;
          }

          // ─── FINISH: tool_calls ───
          if (finishReason === 'tool_calls') {
            pendingToolCallFinish = true;
            originalFinishReason = finishReason;
            continue;
          }

          safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
        }
      });

      streamResult.stream.on('end', () => {
        if (stallTimer) clearTimeout(stallTimer);
        const duration = Date.now() - startTime;
        logger.info(`[Streaming] Completo em ${duration}ms (${chunkCount} chunks, ${sseEventCount} SSE events, retries=${stallRetryCount})`);

        if (stallRetryCount > 0) {
          const workingApiId = currentStreamResult?.apiUsed;
          if (workingApiId) {
            rotatorService.recordSuccess(workingApiId);
            rotatorService.recordLatency(workingApiId, duration);
          }
          excludedApis.length = 0;
        }

        // Flush Kimi content buffer
        const kimiFlush = toolCallBuffer.flushKimiBuffer();
        if (kimiFlush.cleanContent && baseChunk) {
          safeWriteSSE(formatSSE({ ...baseChunk, choices: [{ index: 0, delta: { content: kimiFlush.cleanContent }, finish_reason: null }] }));
        }

        // Flush partial thinking tag buffer
        if (partialTagBuffer && baseChunk) {
          const field = isInsideThinkingBlock ? thinkingField : 'content';
          if (isInsideThinkingBlock) reasoningChunksSent++;
          safeWriteSSE(formatSSE({ ...baseChunk, choices: [{ index: 0, delta: { [field]: partialTagBuffer }, finish_reason: null }] }));
          partialTagBuffer = '';
        }

        // Process remaining lineBuffer
        if (lineBuffer.trim()) {
          const remainingLine = lineBuffer.trim();
          if (remainingLine.startsWith('data: ')) {
            const data = remainingLine.slice(6).trim();
            if (data === '[DONE]') {
              pendingDone = true;
            } else if (data) {
              try {
                const endIdMatch = data.match(/"id"\s*:\s*(\d{16,})/);
                const parsed = JSON.parse(data);
                if (endIdMatch && typeof parsed.id === 'number') parsed.id = endIdMatch[1];
                else if (parsed.id !== undefined) parsed.id = String(parsed.id);

                const choice = parsed.choices?.[0];
                if (choice?.delta?.tool_calls) {
                  toolCallBuffer.accumulate(choice.delta);
                } else if (choice?.delta?.content != null) {
                  const { cleanContent, foundToolCalls } = toolCallBuffer.bufferKimiContent(choice.delta.content);
                  if (foundToolCalls && cleanContent) {
                    choice.delta.content = cleanContent;
                    safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
                  } else if (!foundToolCalls) {
                    safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
                  }
                  const postFlush = toolCallBuffer.flushKimiBuffer();
                  if (postFlush.cleanContent && baseChunk) {
                    safeWriteSSE(formatSSE({ ...baseChunk, choices: [{ index: 0, delta: { content: postFlush.cleanContent }, finish_reason: null }] }));
                  }
                } else {
                  safeWriteSSE(`data: ${JSON.stringify(parsed)}\n\n`);
                }
                if (parsed.usage) {
                  inputTokens = Number(parsed.usage.prompt_tokens) || 0;
                  outputTokens = Number(parsed.usage.completion_tokens) || 0;
                }
              } catch (e) {
                safeWriteSSE(remainingLine + '\n\n');
              }
            }
          }
        }

        // Emit pending tool calls
        if (toolCallBuffer.hasPending()) {
          logger.info(`[Streaming] Emitindo ${toolCallBuffer.getStats().count} tool calls pendentes`);
          let toolCalls = toolCallBuffer.getCompleteToolCalls();
          toolCalls = validateToolCalls(toolCalls);
          if (toolCalls.length > 0 && baseChunk) {
            safeWriteSSE(formatSSE({ ...baseChunk, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolCalls }, finish_reason: null }] }));
            safeWriteSSE(formatSSE({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: originalFinishReason || 'tool_calls' }] }));
            logToolCall('batch', 'emitidas (deferred)', toolCalls.length);
          }
        }

        if (pendingDone) safeWriteSSE(formatDone());
        safeEndConnection();
        streamResult.onComplete({ inputTokens, outputTokens });
      });

      streamResult.stream.on('error', (error) => {
        if (stallTimer) clearTimeout(stallTimer);
        logger.error('Erro no stream:', error.message);
        safeWriteSSE(formatSSE({ id: `err-${streamResult.requestId}`, error: { message: error.message } }));
        safeEndConnection();
      });

    } // end wireStreamHandlers

    // ─── INITIAL STREAM SETUP ───
    const streamResult = await proxyService.proxyStreamRequest(endpoint, 'POST', body);
    currentStreamResult = streamResult;

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Transfer-Encoding': 'chunked',
      'X-Request-Id': streamResult.requestId,
      'X-Api-Used': streamResult.apiUsed,
      'X-Validation-Warnings': JSON.stringify(warnings)
    });
    res.flushHeaders();

    if (res.socket) {
      try {
        res.socket.setNoDelay(true);
        res.socket.setKeepAlive(true, 10000);
      } catch (socketErr) {
        logger.warn(`[Streaming] Erro ao configurar socket: ${socketErr.message}`);
      }
    }

    res.on('close', () => {
      connectionClosed = true;
      if (stallTimer) clearTimeout(stallTimer);
      if (currentStreamResult) {
        detachStream(currentStreamResult);
      }
    });

    wireStreamHandlers(streamResult);
    resetStallTimer();

  } catch (error) {
    logger.error('Erro ao iniciar stream:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message, type: 'stream_error' } });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
        res.end();
      } catch (e) { /* ignore */ }
    }
  }
}

module.exports = router;
