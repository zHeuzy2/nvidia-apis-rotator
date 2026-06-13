

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

    
    this.globalMetrics.totalRequests++;
    this.globalMetrics.totalTokensInput += inputTokens;
    this.globalMetrics.totalTokensOutput += outputTokens;
    this.globalMetrics.totalTokens += inputTokens + outputTokens;

    
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

    
    if (!this.globalMetrics.requestsPerHour[hourKey]) {
      this.globalMetrics.requestsPerHour[hourKey] = 0;
    }
    this.globalMetrics.requestsPerHour[hourKey]++;

    
    if (success && responseTime > 0) {
      const totalSuccess = this.globalMetrics.totalRequests - this.globalMetrics.errorsCount;
      this.globalMetrics.averageResponseTime = 
        ((this.globalMetrics.averageResponseTime * (totalSuccess - 1)) + responseTime) / totalSuccess;
    }

    // Registra erros
    if (!success) {
      this.globalMetrics.errorsCount++;
    }

    
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

    
    if (this.globalMetrics.requestHistory.length > this.maxHistorySize) {
      this.globalMetrics.requestHistory = this.globalMetrics.requestHistory.slice(-this.maxHistorySize);
    }

    
    this.cleanOldHourlyData();

    
    if (apiId) {
      apiConfig.recordTokens(apiId, inputTokens, outputTokens);
      if (success) {
        apiConfig.recordSuccess(apiId, responseTime);
      } else {
        apiConfig.recordFailure(apiId, error);
      }
    }
  }

  
  extractTokensFromResponse(response) {
    try {
      
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

  
  getDetailedMetrics() {
    return {
      global: this.getGlobalSummary(),
      perModel: this.globalMetrics.tokensPerModel,
      requestsPerModel: this.globalMetrics.requestsPerModel,
      apis: apiConfig.getDetailedMetrics(),
      hourlyTrend: this.getHourlyTrend()
    };
  }

  
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

  
  getRequestHistory(limit = 100, offset = 0) {
    const history = this.globalMetrics.requestHistory.slice().reverse();
    return {
      total: history.length,
      limit,
      offset,
      data: history.slice(offset, offset + limit)
    };
  }

  
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

  
  exportMetrics() {
    return {
      exportedAt: new Date().toISOString(),
      global: this.globalMetrics,
      apis: apiConfig.getDetailedMetrics()
    };
  }
}

module.exports = new MetricsService();
