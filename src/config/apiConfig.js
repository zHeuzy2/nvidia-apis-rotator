

class ApiConfig {
  constructor() {
    this.apis = new Map();
    this.lastCleanupTime = Date.now();
    this.cleanupInterval = 5000; // Clean up every 5 seconds instead of on every request
    this.changeListeners = [];
    this.loadFromEnvironment();
    this.startCleanupScheduler();
  }

  
  addChangeListener(listener) {
    this.changeListeners.push(listener);
  }

  
  notifyChange() {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        // Ignore errors in listeners
      }
    }
  }

  startCleanupScheduler() {
    setInterval(() => {
      this.cleanupAllRequestWindows();
    }, this.cleanupInterval);
  }

  cleanupAllRequestWindows() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    this.apis.forEach((api, id) => {
      if (api.requestWindow.length > 0) {
        api.requestWindow = api.requestWindow.filter(timestamp => timestamp > oneMinuteAgo);
      }
    });
    
    this.lastCleanupTime = now;
  }

  loadFromEnvironment() {
    
    // Formato: NVIDIA_API_KEY_1, NVIDIA_API_KEY_2, etc.
    let index = 1;
    while (process.env[`NVIDIA_API_KEY_${index}`]) {
      const apiKey = process.env[`NVIDIA_API_KEY_${index}`];
      const baseUrl = process.env[`NVIDIA_API_URL_${index}`] || 'https://integrate.api.nvidia.com/v1';
      const name = process.env[`NVIDIA_API_NAME_${index}`] || `NVIDIA API ${index}`;
      
      this.addApi({
        id: `nvidia-${index}`,
        name: name,
        baseUrl: baseUrl,
        apiKey: apiKey,
        rateLimit: 40, 
        currentRequests: 0,
        requestWindow: new Array(0), // Pre-allocated array for better performance
        healthy: true,
        priority: index,
        enabled: true,
        metrics: {
          totalRequests: 0,
          successfulRequests: 0,
          failedRequests: 0,
          totalTokensInput: 0,
          totalTokensOutput: 0,
          totalTokens: 0,
          averageResponseTime: 0,
          lastUsed: null,
          errors: []
        }
      });
      
      index++;
    }

    
    if (this.apis.size === 0) {
      console.warn('⚠️  Nenhuma API NVIDIA configurada. Configure as variáveis de ambiente NVIDIA_API_KEY_*');
    }
  }

  addApi(config) {
    this.apis.set(config.id, {
      ...config,
      createdAt: new Date().toISOString()
    });
    this.notifyChange();
    return config.id;
  }

  removeApi(id) {
    const result = this.apis.delete(id);
    this.notifyChange();
    return result;
  }

  updateApi(id, updates) {
    const api = this.apis.get(id);
    if (api) {
      this.apis.set(id, { ...api, ...updates });
      this.notifyChange();
      return true;
    }
    return false;
  }

  getApi(id) {
    return this.apis.get(id);
  }

  getAllApis() {
    return Array.from(this.apis.values());
  }

  getEnabledApis() {
    return this.getAllApis().filter(api => api.enabled && api.healthy);
  }

  getHealthyApis() {
    return this.getAllApis().filter(api => api.healthy && api.enabled);
  }

  updateMetrics(id, metrics) {
    const api = this.apis.get(id);
    if (api) {
      api.metrics = { ...api.metrics, ...metrics };
      this.apis.set(id, api);
    }
  }

  
  canMakeRequest(id) {
    const api = this.apis.get(id);
    if (!api || !api.enabled || !api.healthy) return false;

    // Only clean up if window is getting full (better performance)
    if (api.requestWindow.length >= api.rateLimit * 0.8) {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      api.requestWindow = api.requestWindow.filter(timestamp => timestamp > oneMinuteAgo);
    } else if (api.requestWindow.length > 0) {
      // Only check the first element for expiry (O(1) instead of O(n))
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      if (api.requestWindow[0] <= oneMinuteAgo) {
        // Batch clean only when we know there's expired items
        api.requestWindow = api.requestWindow.filter(timestamp => timestamp > oneMinuteAgo);
      }
    }
    
    return api.requestWindow.length < api.rateLimit;
  }

  
  recordRequest(id) {
    const api = this.apis.get(id);
    if (api) {
      api.requestWindow.push(Date.now());
      api.metrics.totalRequests++;
      api.metrics.lastUsed = new Date().toISOString();
    }
  }

  
  recordTokens(id, inputTokens, outputTokens) {
    const api = this.apis.get(id);
    if (api) {
      api.metrics.totalTokensInput += inputTokens || 0;
      api.metrics.totalTokensOutput += outputTokens || 0;
      api.metrics.totalTokens += (inputTokens || 0) + (outputTokens || 0);
    }
  }

  
  recordSuccess(id, responseTime) {
    const api = this.apis.get(id);
    if (api) {
      api.metrics.successfulRequests++;
      
      const totalSuccess = api.metrics.successfulRequests;
      api.metrics.averageResponseTime = 
        ((api.metrics.averageResponseTime * (totalSuccess - 1)) + responseTime) / totalSuccess;
    }
  }

  recordFailure(id, error) {
    const api = this.apis.get(id);
    if (api) {
      api.metrics.failedRequests++;
      api.metrics.errors.push({
        timestamp: new Date().toISOString(),
        error: (error && error.message) ? error.message : (error || 'Erro desconhecido')
      });
      
      if (api.metrics.errors.length > 100) {
        api.metrics.errors = api.metrics.errors.slice(-100);
      }
    }
  }

  
  getGlobalStats() {
    const apis = this.getAllApis();
    return {
      totalApis: apis.length,
      healthyApis: apis.filter(a => a.healthy).length,
      enabledApis: apis.filter(a => a.enabled).length,
      totalRequests: apis.reduce((sum, api) => sum + api.metrics.totalRequests, 0),
      totalTokensInput: apis.reduce((sum, api) => sum + api.metrics.totalTokensInput, 0),
      totalTokensOutput: apis.reduce((sum, api) => sum + api.metrics.totalTokensOutput, 0),
      totalTokens: apis.reduce((sum, api) => sum + api.metrics.totalTokens, 0),
      totalSuccessful: apis.reduce((sum, api) => sum + api.metrics.successfulRequests, 0),
      totalFailed: apis.reduce((sum, api) => sum + api.metrics.failedRequests, 0)
    };
  }

  
  getDetailedMetrics() {
    return this.getAllApis().map(api => ({
      id: api.id,
      name: api.name,
      healthy: api.healthy,
      enabled: api.enabled,
      currentRpm: api.requestWindow.length,
      maxRpm: api.rateLimit,
      metrics: api.metrics
    }));
  }
}

module.exports = new ApiConfig();
