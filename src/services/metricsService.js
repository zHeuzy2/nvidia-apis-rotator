/**
 * Serviço de Métricas
 * Rastreia tokens, uso de API, performance e estatísticas detalhadas
 */

const apiConfig = require('../config/apiConfig');

class MetricsService {
  constructor() {
    this.globalMetrics = {
      startTime: new Date().toISOString(),
      totalRequests: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalTokens: 0,
      requestsPerModel: {},
      tokensPerModel: {},
      requestsPerHour: {},
      errorsCount: 0,
      averageResponseTime: 0,
      requestHistory: []
    };
    this.maxHistorySize = 5000;
  }

  /**
   * Registra uma requisição completa
   */
  recordRequest(data) {
    const {
      apiId,
      model,
      inputTokens = 0,
      outputTokens = 0,
      responseTime = 0,
      success = true,
      error = null,
      requestId = null
    } = data;

    const now = new Date();
    const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH

    // Atualiza métricas globais
    this.globalMetrics.totalRequests++;
    this.globalMetrics.totalTokensInput += inputTokens;
    this.globalMetrics.totalTokensOutput += outputTokens;
    this.globalMetrics.totalTokens += inputTokens + outputTokens;

    // Atualiza métricas por modelo
    if (model) {
      if (!this.globalMetrics.requestsPerModel[model]) {
        this.globalMetrics.requestsPerModel[model] = 0;
        this.globalMetrics.tokensPerModel[model] = { input: 0, output: 0, total: 0 };
      }
      this.globalMetrics.requestsPerModel[model]++;
      this.globalMetrics.tokensPerModel[model].input += inputTokens;
      this.globalMetrics.tokensPerModel[model].output += outputTokens;
      this.globalMetrics.tokensPerModel[model].total += inputTokens + outputTokens;
    }

    // Atualiza requisições por hora
    if (!this.globalMetrics.requestsPerHour[hourKey]) {
      this.globalMetrics.requestsPerHour[hourKey] = 0;
    }
    this.globalMetrics.requestsPerHour[hourKey]++;

    // Atualiza média de tempo de resposta
    if (success && responseTime > 0) {
      const totalSuccess = this.globalMetrics.totalRequests - this.globalMetrics.errorsCount;
      this.globalMetrics.averageResponseTime = 
        ((this.globalMetrics.averageResponseTime * (totalSuccess - 1)) + responseTime) / totalSuccess;
    }

    // Registra erros
    if (!success) {
      this.globalMetrics.errorsCount++;
    }

    // Adiciona ao histórico
    this.globalMetrics.requestHistory.push({
      requestId,
      timestamp: now.toISOString(),
      apiId,
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      responseTime,
      success,
      error: error ? (error.message || error) : null
    });

    // Limpa histórico antigo
    if (this.globalMetrics.requestHistory.length > this.maxHistorySize) {
      this.globalMetrics.requestHistory = this.globalMetrics.requestHistory.slice(-this.maxHistorySize);
    }

    // Limpa dados de horas antigas (mantém últimas 168 horas = 7 dias)
    this.cleanOldHourlyData();

    // Atualiza métricas da API específica
    if (apiId) {
      apiConfig.recordTokens(apiId, inputTokens, outputTokens);
      if (success) {
        apiConfig.recordSuccess(apiId, responseTime);
      } else {
        apiConfig.recordFailure(apiId, error);
      }
    }
  }

  /**
   * Extrai informações de tokens da resposta NVIDIA
   */
  extractTokensFromResponse(response) {
    try {
      // Formato padrão da NVIDIA NIM API
      if (response?.usage) {
        return {
          inputTokens: response.usage.prompt_tokens || 0,
          outputTokens: response.usage.completion_tokens || 0,
          totalTokens: response.usage.total_tokens || 0
        };
      }
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    } catch (e) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
  }

  /**
   * Remove dados de horas antigas
   */
  cleanOldHourlyData() {
    const hoursToKeep = 168; // 7 dias
    const keys = Object.keys(this.globalMetrics.requestsPerHour).sort();
    if (keys.length > hoursToKeep) {
      const keysToRemove = keys.slice(0, keys.length - hoursToKeep);
      keysToRemove.forEach(key => {
        delete this.globalMetrics.requestsPerHour[key];
      });
    }
  }

  /**
   * Retorna resumo das métricas globais
   */
  getGlobalSummary() {
    const apiStats = apiConfig.getGlobalStats();
    const uptime = this.getUptime();

    return {
      uptime,
      startTime: this.globalMetrics.startTime,
      totalRequests: this.globalMetrics.totalRequests,
      successRate: this.globalMetrics.totalRequests > 0 
        ? (((this.globalMetrics.totalRequests - this.globalMetrics.errorsCount) / this.globalMetrics.totalRequests) * 100).toFixed(2) + '%'
        : '100%',
      tokens: {
        input: this.globalMetrics.totalTokensInput,
        output: this.globalMetrics.totalTokensOutput,
        total: this.globalMetrics.totalTokens
      },
      averageResponseTime: Math.round(this.globalMetrics.averageResponseTime) + 'ms',
      errorsCount: this.globalMetrics.errorsCount,
      apis: apiStats
    };
  }

  /**
   * Retorna métricas detalhadas
   */
  getDetailedMetrics() {
    return {
      global: this.getGlobalSummary(),
      perModel: this.globalMetrics.tokensPerModel,
      requestsPerModel: this.globalMetrics.requestsPerModel,
      apis: apiConfig.getDetailedMetrics(),
      hourlyTrend: this.getHourlyTrend()
    };
  }

  /**
   * Retorna tendência por hora (últimas 24 horas)
   */
  getHourlyTrend() {
    const now = new Date();
    const trend = [];
    
    for (let i = 23; i >= 0; i--) {
      const date = new Date(now);
      date.setHours(date.getHours() - i);
      const hourKey = date.toISOString().slice(0, 13);
      trend.push({
        hour: hourKey,
        requests: this.globalMetrics.requestsPerHour[hourKey] || 0
      });
    }

    return trend;
  }

  /**
   * Retorna histórico de requisições
   */
  getRequestHistory(limit = 100, offset = 0) {
    const history = this.globalMetrics.requestHistory.slice().reverse();
    return {
      total: history.length,
      limit,
      offset,
      data: history.slice(offset, offset + limit)
    };
  }

  /**
   * Retorna uptime do serviço
   */
  getUptime() {
    const start = new Date(this.globalMetrics.startTime);
    const now = new Date();
    const diffMs = now - start;
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

    return {
      days,
      hours,
      minutes,
      seconds,
      formatted: `${days}d ${hours}h ${minutes}m ${seconds}s`,
      totalSeconds: Math.floor(diffMs / 1000)
    };
  }

  /**
   * Reseta todas as métricas
   */
  resetMetrics() {
    this.globalMetrics = {
      startTime: new Date().toISOString(),
      totalRequests: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalTokens: 0,
      requestsPerModel: {},
      tokensPerModel: {},
      requestsPerHour: {},
      errorsCount: 0,
      averageResponseTime: 0,
      requestHistory: []
    };
  }

  /**
   * Exporta métricas para JSON
   */
  exportMetrics() {
    return {
      exportedAt: new Date().toISOString(),
      global: this.globalMetrics,
      apis: apiConfig.getDetailedMetrics()
    };
  }
}

module.exports = new MetricsService();
