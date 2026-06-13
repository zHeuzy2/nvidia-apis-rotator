/**
 * Configuração dos Modelos NVIDIA NIM para Coding
 * 
 * v3.2 - 5 modelos principais
 * - moonshotai/kimi-k2.6 (default) — 256K context, 32K output, vision, agent swarm
 * - deepseek-ai/deepseek-v4-pro — 1M context, reasoning avançado
 * - z-ai/glm-5.1 — 512K context, thinking interleaved
 * - minimaxai/minimax-m2.7 — 256K context, coding SOTA
 * - minimaxai/minimax-m3 — 1M context, multimodal MoE SOTA
 */

const modelsConfig = {
  // Modelo padrão
  defaultModel: process.env.DEFAULT_MODEL || 'moonshotai/kimi-k2.6',

  // System prompts NÃO são mais injetados — o cliente gerencia os seus.
  // Mantido apenas para referência histórica.
  systemPrompts: {},

  models: {
    // ============================================
    // Kimi K2.6 — DEFAULT (RECOMENDADO)
    // ============================================
    'moonshotai/kimi-k2.6': {
      id: 'moonshotai/kimi-k2.6',
      name: 'Kimi K2.6',
      ownedBy: 'moonshotai',
      isMoE: true,
      totalParams: 1000000000000,
      activeParams: 32000000000,
      contextWindow: 262144,        // 256K tokens
      maxOutputTokens: 32768,       // 32K tokens
      defaultTemperature: 1.0,
      instantTemperature: 0.6,
      defaultTopP: 0.95,
      temperatureRange: { min: 0, max: 1 },
      supportsThinking: true,
      supportsInstantMode: true,
      supportsVision: true,
      supportsTools: true,
      supportsAgentSwarm: true,
      thinkingFormat: 'separate_field',
      thinkingField: 'reasoning_content',
      preserveThinking: false,
      thinkingConfig: {
        enabledType: 'enabled',
        disabledType: 'true',
        budgetTokensParam: 'budget_tokens'
      },
      benchmarks: {
        hleFullSet: '50.2%',
        browseComp: '74.9%',
        mmmuPro: '78.5%',
        videoMmmu: '86.6%',
        sweBenchVerified: '76.8%',
        agentSwarmMaxSubAgents: 100,
        agentSwarmMaxToolCalls: 1500,
        agentSwarmSpeedupFactor: 4.5
      },
      inference: {
        efficientMode: true,
        speculativeDecoding: true,
        contextCaching: true,
        cacheHitPricing: true
      },
      recommendations: {
        codeBenchmarks: { maxTokens: 262144 },
        reasoningBenchmarks: { maxTokens: 131072, minQuestions: 500 },
        agenticMultiHop: { maxTokens: 262144 },
        agenticOther: { maxTokens: 16384 }
      },
      description: 'Kimi K2.6 SOTA — MoE 1T/32B. Context 256K, output 32K. Vision, reasoning, agent swarm.'
    },

    // ============================================
    // DeepSeek V4 Pro — 1M tokens context
    // ============================================
    'deepseek-ai/deepseek-v4-pro': {
      id: 'deepseek-ai/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      ownedBy: 'deepseek-ai',
      isMoE: true,
      totalParams: 685000000000,    // ~685B (estimado, baseado na família DeepSeek)
      activeParams: 37000000000,    // ~37B ativos (MoE)
      contextWindow: 1048576,       // 1M tokens
      maxOutputTokens: 65536,       // 64K tokens (estimado)
      defaultTemperature: 0.7,
      temperatureRange: { min: 0, max: 1 },
      supportsThinking: true,
      supportsInstantMode: true,
      supportsVision: false,
      supportsTools: true,
      thinkingFormat: 'separate_field',
      thinkingField: 'reasoning_content',
      preserveThinking: false,
      thinkingConfig: {
        enabledType: 'enabled',
        disabledType: 'true',
        budgetTokensParam: 'budget_tokens'
      },
      description: 'DeepSeek V4 Pro — 1M context, reasoning avançado, sparse attention, tool use. Modelo de alta capacidade para tarefas complexas.'
    },

    // ============================================
    // GLM-5.1 — 512K context, thinking interleaved
    // ============================================
    'z-ai/glm-5.1': {
      id: 'z-ai/glm-5.1',
      name: 'GLM-5.1',
      ownedBy: 'z-ai',
      isMoE: false,
      totalParams: 500000000000,    // ~500B (estimado, baseado no GLM-5)
      contextWindow: 524288,        // 512K tokens (baseado no GLM-5)
      maxOutputTokens: 131072,      // 128K tokens
      defaultTemperature: 0.7,
      temperatureRange: { min: 0, max: 1 },
      supportsThinking: true,
      supportsInstantMode: true,
      supportsVision: false,
      supportsTools: true,
      thinkingFormat: 'interleaved',
      thinkingTags: { open: '<thinking>', close: '</thinking>' },
      preserveThinking: true,
      thinkingModes: ['interleaved', 'preserved', 'turn-level'],
      description: 'GLM-5.1 — 512K context, 128K output. Thinking interleaved com tags <thinking>. Sucessor do GLM-5 com reasoning avançado.'
    },

    // ============================================
    // MiniMax M2.7 — Coding SOTA, thinking interleaved
    // ============================================
    'minimaxai/minimax-m2.7': {
      id: 'minimaxai/minimax-m2.7',
      name: 'MiniMax M2.7',
      ownedBy: 'minimaxai',
      isMoE: true,
      totalParams: 230000000000,    // ~230B (estimado, baseado no M2.5)
      contextWindow: 262144,        // 256K tokens
      maxOutputTokens: 131072,      // 128K tokens
      defaultTemperature: 0.7,
      temperatureRange: { min: 0, max: 1 },
      supportsThinking: true,
      supportsInstantMode: false,   // MiniMax não suporta desabilitar thinking
      supportsVision: false,
      supportsTools: true,
      thinkingFormat: 'interleaved',
      thinkingField: 'reasoning_content',
      thinkingTags: { open: '<think>', close: '</think>' },
      preserveThinking: true,
      // MiniMax M2.7 thinking mode — SEMPRE ativo, não desabilitável
      thinkingConfig: {
        enabledType: 'enabled',
        budgetTokensParam: 'budget_tokens'
      },
      // MiniMax M2.7 gasta muitos tokens em thinking.
      // Recomendação: usar pelo menos 200-500 max_tokens para ter output visível
      recommendedMinTokens: 200,
      description: 'MiniMax M2.7 — 256K context, 128K output. MoE agentic coding. Thinking interleaved (sempre ativo). Use max_tokens >= 200.'
    },

    // ============================================
    // MiniMax M3 — Multimodal MoE, 1M context, thinking interleaved
    // ============================================
    'minimaxai/minimax-m3': {
      id: 'minimaxai/minimax-m3',
      name: 'MiniMax M3',
      ownedBy: 'minimaxai',
      isMoE: true,
      totalParams: 428000000000,    // 428B total
      activeParams: 22000000000,    // 22B active
      contextWindow: 1048576,       // 1M context window
      maxOutputTokens: 131072,      // 128K max output
      defaultTemperature: 0.7,
      temperatureRange: { min: 0, max: 1 },
      supportsThinking: true,
      supportsInstantMode: false,   // Thinking interleaved sempre ativo
      supportsVision: true,
      supportsTools: true,
      thinkingFormat: 'interleaved',
      thinkingField: 'reasoning_content',
      thinkingTags: { open: '<think>', close: '</think>' },
      preserveThinking: true,
      thinkingConfig: {
        enabledType: 'enabled',
        budgetTokensParam: 'budget_tokens'
      },
      recommendedMinTokens: 200,
      description: 'MiniMax M3 — 1M context, 128K output. Multimodal MoE SOTA para coding, agentic workflows e raciocínio.'
    }
  },

  /**
   * Aliases
   */
  aliases: {
    // Kimi aliases (default)
    'kimi': 'moonshotai/kimi-k2.6',
    'kimi-k2': 'moonshotai/kimi-k2.6',
    'kimi-k2.5': 'moonshotai/kimi-k2.6',
    'kimi-k2.6': 'moonshotai/kimi-k2.6',
    'kimi-thinking': 'moonshotai/kimi-k2.6',
    'kimi-instruct': 'moonshotai/kimi-k2.6',

    // DeepSeek aliases
    'deepseek': 'deepseek-ai/deepseek-v4-pro',
    'deepseek-pro': 'deepseek-ai/deepseek-v4-pro',
    'deepseek-v4': 'deepseek-ai/deepseek-v4-pro',
    'deepseek-v4-pro': 'deepseek-ai/deepseek-v4-pro',
    'ds-pro': 'deepseek-ai/deepseek-v4-pro',

    // GLM aliases
    'glm': 'z-ai/glm-5.1',
    'glm-5': 'z-ai/glm-5.1',
    'glm5': 'z-ai/glm-5.1',
    'glm-5.1': 'z-ai/glm-5.1',
    'glm5.1': 'z-ai/glm-5.1',

    // MiniMax aliases
    'minimax': 'minimaxai/minimax-m3',
    'minimax-m2': 'minimaxai/minimax-m2.7',
    'minimax-m2.7': 'minimaxai/minimax-m2.7',
    'minimax-m3': 'minimaxai/minimax-m3',
    'minimax3': 'minimaxai/minimax-m3',
    'm2': 'minimaxai/minimax-m2.7',
    'm2.7': 'minimaxai/minimax-m2.7',
    'm27': 'minimaxai/minimax-m2.7',
    'm3': 'minimaxai/minimax-m3',
  },

  /**
   * Retorna a configuração de um modelo pelo ID ou alias
   */
  getModel(modelId) {
    if (!modelId) return null;
    if (this.models[modelId]) return this.models[modelId];
    const resolvedId = this.aliases[modelId.toLowerCase()];
    if (resolvedId && this.models[resolvedId]) return this.models[resolvedId];
    return null;
  },

  /**
   * Resolve um nome de modelo para o ID completo
   */
  resolveModelId(modelId) {
    if (!modelId) return this.defaultModel;
    if (this.models[modelId]) return modelId;
    const resolvedId = this.aliases[modelId.toLowerCase()];
    if (resolvedId) return resolvedId;
    return modelId;
  },

  /**
   * Retorna lista de todos os modelos suportados
   */
  getAllModels() {
    return Object.values(this.models);
  },

  /**
   * Retorna lista de modelos no formato OpenAI /models
   */
  getModelsListResponse() {
    const models = this.getAllModels().map(model => ({
      id: model.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: model.ownedBy,
      permission: [],
      root: model.id,
      parent: null
    }));

    return {
      object: 'list',
      data: models
    };
  },

  /**
   * Verifica se um modelo é conhecido/suportado
   */
  isKnownModel(modelId) {
    return this.getModel(modelId) !== null;
  },

  /**
   * Retorna o system prompt para um modelo
   */
  getSystemPrompt(modelId) {
    const resolvedId = this.resolveModelId(modelId);
    return this.systemPrompts[resolvedId] || null;
  }
};

module.exports = modelsConfig;
