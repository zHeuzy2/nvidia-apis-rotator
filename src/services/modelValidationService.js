

const modelsConfig = require('../config/modelsConfig');

class ModelValidationService {
  
  validateRequest(body) {
    const warnings = [];
    const errors = [];
    
    if (!body || typeof body !== 'object') {
      errors.push('Request body must be a valid object');
      return { validatedBody: {}, warnings, errors };
    }

    
    const validatedBody = structuredClone(body);

    
    const { modelId, modelConfig, modelWarning } = this.resolveAndValidateModel(validatedBody.model);
    validatedBody.model = modelId;
    
    if (modelWarning) warnings.push(modelWarning);

    
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

    if (validatedBody.top_p === undefined || validatedBody.top_p === null) {
      if (modelConfig.defaultTopP !== undefined) {
        validatedBody.top_p = modelConfig.defaultTopP;
      }
    }

    
    const otherWarnings = this.validateOtherParams(validatedBody, modelConfig);
    warnings.push(...otherWarnings);

    return { validatedBody, warnings, errors };
  }

  
  resolveAndValidateModel(modelName) {
    
    if (!modelName) {
      const defaultModel = modelsConfig.defaultModel;
      const modelConfig = modelsConfig.getModel(defaultModel);
      return {
        modelId: defaultModel,
        modelConfig,
        warning: `No model specified, using default: ${defaultModel}`
      };
    }

    
    const resolvedId = modelsConfig.resolveModelId(modelName);
    
    
    const modelConfig = modelsConfig.getModel(resolvedId);

    if (!modelConfig) {
      return {
        modelId: resolvedId,
        modelConfig: null,
        warning: null
      };
    }

    
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

  
  validateMaxTokens(body, modelConfig) {
    const { maxOutputTokens } = modelConfig;
    
    
    if (body.max_tokens === undefined || body.max_tokens === null) {
      body.max_tokens = maxOutputTokens;
      return null;
    }

    
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

  
  validateTemperature(body, modelConfig) {
    const warnings = [];
    const { defaultTemperature, temperatureRange } = modelConfig;

    
    if (body.temperature === undefined || body.temperature === null) {
      body.temperature = defaultTemperature;
      return warnings;
    }

    
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

  
  validateThinkingParams(body, modelConfig) {
    const warnings = [];
    
    
    if (!modelConfig.supportsThinking) {
      if (body.thinking) {
        warnings.push(`Model ${modelConfig.id} does not support thinking parameter, ignoring`);
      }
      return warnings;
    }

    
    if (!body.thinking) {
      
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
    
    
    // ============================================
    if (modelConfig.id === 'moonshotai/kimi-k2.5' && body.tools && body.tools.length > 0) {
      if (thinking.type !== 'disabled') {
         
         warnings.push(`Model ${modelConfig.id} with Tools + Thinking enabled. Ensure client can handle potential hallucinations in reasoning.`);
      }
    }

    
    if (modelConfig.thinkingFormat === 'interleaved' && modelConfig.preserveThinking) {
      if (!body.preserve_thinking) {
        warnings.push(`Model ${modelConfig.id} uses interleaved thinking, recommended to preserve_thinking=true for context`);
      }
    }

    return warnings;
  }

  
  validateVisionParams(body, modelConfig) {
    
    if (!modelConfig.supportsVision) {
      
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
