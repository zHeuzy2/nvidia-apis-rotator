/**
 * Serviço de Validação de Modelos
 * Valida e normaliza parâmetros baseado nas especificações de cada modelo
 */

const modelsConfig = require('../config/modelsConfig');

class ModelValidationService {
  /**
   * Valida e normaliza uma requisição de chat completions
   * @param {object} body - Corpo da requisição
   * @returns {object} - { validatedBody, warnings[], errors[] }
   */
  validateRequest(body) {
    const warnings = [];
    const errors = [];
    
    if (!body || typeof body !== 'object') {
      errors.push('Request body must be a valid object');
      return { validatedBody: {}, warnings, errors };
    }

// Clona o body profundamente para não modificar o original
    // Isso é crucial para mensagens multimodais com imagens
    const validatedBody = structuredClone(body);

    // 1. Resolve e valida o modelo
    const { modelId, modelConfig, modelWarning } = this.resolveAndValidateModel(validatedBody.model);
    validatedBody.model = modelId;
    
    if (modelWarning) warnings.push(modelWarning);

    // Se o modelo não for suportado, não podemos validar outros parâmetros
    if (!modelConfig) {
      warnings.push(`Unknown model: ${modelId}. Skipping parameter validation.`);
      return { validatedBody, warnings, errors };
    }

    // 2. Valida e ajusta max_tokens
    const maxTokensWarning = this.validateMaxTokens(validatedBody, modelConfig);
    if (maxTokensWarning) warnings.push(maxTokensWarning);

    // 3. Valida e ajusta temperature
    const tempWarnings = this.validateTemperature(validatedBody, modelConfig);
    warnings.push(...tempWarnings);

    // 4. Valida thinking parameters
    const thinkingWarnings = this.validateThinkingParams(validatedBody, modelConfig);
    warnings.push(...thinkingWarnings);

    // 5. Valida vision parameters
    const visionWarning = this.validateVisionParams(validatedBody, modelConfig);
    if (visionWarning) warnings.push(visionWarning);

// 6. Aplica top_p padrão do modelo se não especificado
    if (validatedBody.top_p === undefined || validatedBody.top_p === null) {
      if (modelConfig.defaultTopP !== undefined) {
        validatedBody.top_p = modelConfig.defaultTopP;
      }
    }

    // 7. Valida top_p e outros parâmetros
    const otherWarnings = this.validateOtherParams(validatedBody, modelConfig);
    warnings.push(...otherWarnings);

    return { validatedBody, warnings, errors };
  }

  /**
   * Resolve o modelo (alias -> full name -> default)
   * @param {string} modelName - Nome do modelo ou alias
   * @returns {object} - { modelId, modelConfig, warning }
   */
  resolveAndValidateModel(modelName) {
    // Se nenhum modelo especificado, usa o default
    if (!modelName) {
      const defaultModel = modelsConfig.defaultModel;
      const modelConfig = modelsConfig.getModel(defaultModel);
      return {
        modelId: defaultModel,
        modelConfig,
        warning: `No model specified, using default: ${defaultModel}`
      };
    }

    // Resolve o ID do modelo (alias -> full name)
    const resolvedId = modelsConfig.resolveModelId(modelName);
    
    // Verifica se é um modelo suportado
    const modelConfig = modelsConfig.getModel(resolvedId);

    if (!modelConfig) {
      return {
        modelId: resolvedId,
        modelConfig: null,
        warning: null
      };
    }

    // Se houve alias, menciona no warning
    if (resolvedId !== modelName) {
      return {
        modelId: resolvedId,
        modelConfig,
        warning: `Model alias '${modelName}' resolved to '${resolvedId}'`
      };
    }

    return {
      modelId: resolvedId,
      modelConfig,
      warning: null
    };
  }

  /**
   * Valida e ajusta max_tokens baseado no modelo
   * @param {object} body - Corpo da requisição (será modificado)
   * @param {object} modelConfig - Configuração do modelo
   * @returns {string|null} - Warning message se necessário
   */
  validateMaxTokens(body, modelConfig) {
    const { maxOutputTokens } = modelConfig;
    
    // Se não especificado, usa o default do modelo
    if (body.max_tokens === undefined || body.max_tokens === null) {
      body.max_tokens = maxOutputTokens;
      return null;
    }

    // Valida se está dentro do limite
    const requestedTokens = body.max_tokens;
    
    if (requestedTokens <= 0) {
      body.max_tokens = maxOutputTokens;
      return `max_tokens must be positive, set to ${maxOutputTokens}`;
    }

    if (requestedTokens > maxOutputTokens) {
      body.max_tokens = maxOutputTokens;
      return `max_tokens (${requestedTokens}) exceeds model limit (${maxOutputTokens}), set to ${maxOutputTokens}`;
    }

    return null;
  }

  /**
   * Valida e ajusta temperature baseado no modelo
   * @param {object} body - Corpo da requisição (será modificado)
   * @param {object} modelConfig - Configuração do modelo
   * @returns {array} - Array de warnings
   */
  validateTemperature(body, modelConfig) {
    const warnings = [];
    const { defaultTemperature, temperatureRange } = modelConfig;

    // Se não especificado, usa o default do modelo
    if (body.temperature === undefined || body.temperature === null) {
      body.temperature = defaultTemperature;
      return warnings;
    }

    // Verifica se é um modelo com temperatura fixa
    if (temperatureRange.min === temperatureRange.max) {
      if (body.temperature !== temperatureRange.min) {
        const original = body.temperature;
        body.temperature = temperatureRange.min;
        warnings.push(`Model ${modelConfig.id} requires temperature=${temperatureRange.min} (was ${original}), value adjusted`);
      }
      return warnings;
    }

    // Valida range
    const requestedTemp = body.temperature;
    
    if (requestedTemp < temperatureRange.min) {
      body.temperature = temperatureRange.min;
      warnings.push(`temperature (${requestedTemp}) below minimum (${temperatureRange.min}), set to ${temperatureRange.min}`);
    } else if (requestedTemp > temperatureRange.max) {
      body.temperature = temperatureRange.max;
      warnings.push(`temperature (${requestedTemp}) above maximum (${temperatureRange.max}), set to ${temperatureRange.max}`);
    }

    // Ajusta temperatura para instant mode se aplicável
    if (modelConfig.supportsInstantMode && body.thinking && body.thinking.type === 'disabled') {
      if (modelConfig.instantTemperature !== undefined) {
        if (body.temperature !== modelConfig.instantTemperature) {
          const original = body.temperature;
          body.temperature = modelConfig.instantTemperature;
          warnings.push(`Instant mode detected: temperature adjusted from ${original} to ${modelConfig.instantTemperature}`);
        }
      }
    }

    return warnings;
  }

  /**
   * Valida parâmetros de thinking
   * @param {object} body - Corpo da requisição
   * @param {object} modelConfig - Configuração do modelo
   * @returns {array} - Array de warnings
   */
  validateThinkingParams(body, modelConfig) {
    const warnings = [];
    
    // Se o modelo não suporta thinking
    if (!modelConfig.supportsThinking) {
      if (body.thinking) {
        warnings.push(`Model ${modelConfig.id} does not support thinking parameter, ignoring`);
      }
      return warnings;
    }

    // Se não há thinking parameter, está OK
    if (!body.thinking) {
      // Para modelos que suportam thinking, pode deixar como default
      return warnings;
    }

    // Valida thinking object
    const thinking = body.thinking;
    
    if (typeof thinking !== 'object') {
      warnings.push(`thinking parameter must be an object, ignoring`);
      delete body.thinking;
      return warnings;
    }

    // Valida type
    if (thinking.type) {
      const validTypes = modelConfig.thinkingConfig ? 
        [modelConfig.thinkingConfig.enabledType, modelConfig.thinkingConfig.disabledType] :
        ['enabled'];
      
      if (!validTypes.includes(thinking.type)) {
        warnings.push(`Invalid thinking type: ${thinking.type}. Valid types: ${validTypes.join(', ')}`);
      }
    }

    // Valida thinking budget_tokens se suportado
    if (thinking.budget_tokens !== undefined && modelConfig.thinkingConfig) {
      const budget = thinking.budget_tokens;
      if (budget < 0) {
        warnings.push(`thinking.budget_tokens must be non-negative, ignoring`);
      } else if (budget > modelConfig.maxOutputTokens) {
        warnings.push(`thinking.budget_tokens (${budget}) exceeds max_output_tokens (${modelConfig.maxOutputTokens})`);
      }
    }

    // ============================================
    // FIX: Kimi 2.5 + Tools Conflict
    // O modelo tende a alucinar tool calls dentro do thinking block
    // Solução: Permitir, mas adicionar aviso. O parser no proxy lidará com a robustez.
    // ============================================
    if (modelConfig.id === 'moonshotai/kimi-k2.5' && body.tools && body.tools.length > 0) {
      if (thinking.type !== 'disabled') {
         // Não forçamos mais disabled, apenas avisamos
         warnings.push(`Model ${modelConfig.id} with Tools + Thinking enabled. Ensure client can handle potential hallucinations in reasoning.`);
      }
    }

    // Para modelos interleaved, avisa sobre preservação
    if (modelConfig.thinkingFormat === 'interleaved' && modelConfig.preserveThinking) {
      if (!body.preserve_thinking) {
        warnings.push(`Model ${modelConfig.id} uses interleaved thinking, recommended to preserve_thinking=true for context`);
      }
    }

    return warnings;
  }

  /**
   * Valida parâmetros de visão (imagens, vídeo, PDF)
   * @param {object} body - Corpo da requisição
   * @param {object} modelConfig - Configuração do modelo
   * @returns {string|null} - Warning message se necessário
   */
  validateVisionParams(body, modelConfig) {
    // Se o modelo não suporta visão
    if (!modelConfig.supportsVision) {
      // Verifica se há conteúdo de imagem nas mensagens
      if (body.messages) {
        const hasImage = body.messages.some(msg => {
          if (msg.content && Array.isArray(msg.content)) {
            return msg.content.some(item => item.type === 'image_url');
          }
          return false;
        });
        
        if (hasImage) {
          return `Model ${modelConfig.id} does not support vision/image content, images will be ignored`;
        }
      }
    }

    return null;
  }

  /**
   * Valida outros parâmetros comuns
   * @param {object} body - Corpo da requisição
   * @param {object} modelConfig - Configuração do modelo
   * @returns {array} - Array de warnings
   */
  validateOtherParams(body, modelConfig) {
    const warnings = [];

    // Valida top_p
    if (body.top_p !== undefined) {
      if (body.top_p < 0 || body.top_p > 1) {
        warnings.push(`top_p must be between 0 and 1 (was ${body.top_p}), ignoring`);
      }
    }

    // Valida presence_penalty
    if (body.presence_penalty !== undefined) {
      if (body.presence_penalty < -2 || body.presence_penalty > 2) {
        warnings.push(`presence_penalty must be between -2 and 2 (was ${body.presence_penalty}), ignoring`);
      }
    }

    // Valida frequency_penalty
    if (body.frequency_penalty !== undefined) {
      if (body.frequency_penalty < -2 || body.frequency_penalty > 2) {
        warnings.push(`frequency_penalty must be between -2 and 2 (was ${body.frequency_penalty}), ignoring`);
      }
    }

    // Valida messages
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      warnings.push(`messages must be a non-empty array`);
    }

    return warnings;
  }

  /**
   * Retorna informações sobre um modelo
   * @param {string} modelId - ID do modelo ou alias
   * @returns {object|null} - Informações do modelo ou null
   */
  getModelInfo(modelId) {
    const resolvedId = modelsConfig.resolveModelId(modelId);
    const modelConfig = modelsConfig.getModel(resolvedId);
    
    if (!modelConfig) return null;

    return {
      id: modelConfig.id,
      name: modelConfig.name,
      owned_by: modelConfig.ownedBy,
      description: modelConfig.description,
      contextWindow: modelConfig.contextWindow,
      maxOutputTokens: modelConfig.maxOutputTokens,
      defaultTemperature: modelConfig.defaultTemperature,
      supportsThinking: modelConfig.supportsThinking,
      supportsInstantMode: modelConfig.supportsInstantMode,
      supportsVision: modelConfig.supportsVision,
      supportsTools: modelConfig.supportsTools,
      thinkingFormat: modelConfig.thinkingFormat
    };
  }

  /**
   * Lista todos os modelos suportados
   * @returns {array} - Array de informações dos modelos
   */
  listAllModels() {
    return modelsConfig.getAllModels().map(model => ({
      id: model.id,
      name: model.name,
      owned_by: model.ownedBy,
      description: model.description,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens
    }));
  }
}

module.exports = new ModelValidationService();
