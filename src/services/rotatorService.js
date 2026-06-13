

const apiConfig = require('../config/apiConfig');
const logger = require('../utils/asyncLogger');

class RotatorService {
  constructor() {
    this.currentIndex = 0;
    this.rotationHistory = [];
    this.maxHistorySize = 1000;
    
    
    this.cachedHealthyApis = [];
    this.lastCacheUpdate = 0;
    this.cacheTTL = 10000; // 10 segundos
    
    
    this.apiLatencies = new Map();  // apiId → { avg, samples }
    this.latencyWindow = 20;
    
    
    this.circuitBreakers = new Map(); // apiId → { failures, state, lastFailure }
    this.circuitThreshold = 5;
    this.circuitTimeout = 60000; // 60s
    
    // ============================================
    // v3.0: SPEED RANKING (weighted selection)
    // ============================================
    this.speedRanking = new Map();   
    this.useWeightedSelection = true;

    
    apiConfig.addChangeListener(() => this.invalidateCache());
    this._poolCache = { pool: [], totalWeight: 0, lastBuilt: 0, ttl: 100 };
  }

  // ============================================
  
  // ============================================
  updateSpeedRanking(ranking) {
    if (ranking && ranking instanceof Map) {
      this.speedRanking = ranking;
    }
  }

  
  async getNextApi(preferredModel = null, excludeApis = []) {
    const now = Date.now();
    
    
    if (now - this.lastCacheUpdate > this.cacheTTL) {
      this.cachedHealthyApis = apiConfig.getHealthyApis();
      this.lastCacheUpdate = now;
    }
    
    let apis = this.cachedHealthyApis;
    
    if (apis.length === 0) {
      this.cachedHealthyApis = apiConfig.getHealthyApis();
      this.lastCacheUpdate = now;
      apis = this.cachedHealthyApis;
      if (apis.length === 0) {
        throw new Error('Nenhuma API NVIDIA disponível');
      }
    }

    
    const excludeSet = new Set(excludeApis);
    if (excludeSet.size > 0) {
      apis = apis.filter(api => !excludeSet.has(api.id));
      if (apis.length === 0) {
        throw new Error('Nenhuma API NVIDIA disponível (todas excluídas)');
      }
    }

    
    apis = apis.filter(api => !this.isCircuitBreakerOpen(api.id));
    if (apis.length === 0) {
      
      apis = this.cachedHealthyApis;
    }

    // ============================================
    // v3.0: WEIGHTED RANDOM SELECTION
    // ============================================
    if (this.useWeightedSelection && this.speedRanking.size > 0) {
      return this.weightedSelection(apis);
    }

    
    return this.latencyBasedSelection(apis);
  }

  
  weightedSelection(apis) {
    const now = Date.now();

    // Rebuild pool cache if expired
    if (this._poolCache.pool.length === 0 || (now - this._poolCache.lastBuilt) >= this._poolCache.ttl) {
      const pool = [];
      let totalWeight = 0;

      for (const api of apis) {
        if (!apiConfig.canMakeRequest(api.id)) continue;

        const ranking = this.speedRanking.get(api.id);
        let weight;

        if (ranking && ranking.weight > 0) {
          weight = ranking.weight;
        } else if (ranking && ranking.avgSpeed > 0 && ranking.avgSpeed < 999999) {
          const speed = Math.max(ranking.avgSpeed, 100);
          weight = 1000 / speed;
        } else {
          weight = 0.02;
        }

        pool.push({ api, weight });
        totalWeight += weight;
      }

      if (pool.length === 0) {
        throw new Error('Nenhuma API NVIDIA com capacidade disponível');
      }

      this._poolCache.pool = pool;
      this._poolCache.totalWeight = totalWeight;
      this._poolCache.lastBuilt = now;
    }

    // Weighted random from cache
    let random = Math.random() * this._poolCache.totalWeight;
    let selected = this._poolCache.pool[0].api;

    for (const { api, weight } of this._poolCache.pool) {
      random -= weight;
      if (random <= 0) {
        selected = api;
        break;
      }
    }

    apiConfig.recordRequest(selected.id);
    this.logRotation(selected.id, 'weighted-selection');

    return selected;
  }

  
  latencyBasedSelection(apis) {
    const now = Date.now();

    
    const sortedApis = apis
      .map(api => {
        const latData = this.apiLatencies.get(api.id);
        const avgLatency = latData ? latData.avg : 999999;
        return { api, avgLatency };
      })
      .sort((a, b) => a.avgLatency - b.avgLatency);

    
    for (const { api } of sortedApis) {
      if (apiConfig.canMakeRequest(api.id)) {
        apiConfig.recordRequest(api.id);
        this.logRotation(api.id, 'latency-based');
        return api;
      }
    }

    
    if (this.currentIndex >= apis.length) {
      this.currentIndex = 0;
    }
    const selected = apis[this.currentIndex];
    this.currentIndex++;
    apiConfig.recordRequest(selected.id);
    this.logRotation(selected.id, 'round-robin-fallback');

    return selected;
  }

  
  isCircuitBreakerOpen(apiId) {
    const breaker = this.circuitBreakers.get(apiId);
    if (!breaker) return false;

    const now = Date.now();

    if (breaker.state === 'open') {
      
      if (now - breaker.lastFailure > this.circuitTimeout) {
        breaker.state = 'half-open';
        return false;
      }
      return true;
    }

    return false;
  }

  
  recordSuccess(apiId) {
    const breaker = this.circuitBreakers.get(apiId);
    if (breaker) {
      breaker.failures = 0;
      breaker.state = 'closed';
    }
  }

  
  recordFailure(apiId) {
    if (!this.circuitBreakers.has(apiId)) {
      this.circuitBreakers.set(apiId, {
        failures: 0,
        state: 'closed',
        lastFailure: 0
      });
    }

    const breaker = this.circuitBreakers.get(apiId);
    breaker.failures++;
    breaker.lastFailure = Date.now();

    if (breaker.failures >= this.circuitThreshold) {
      breaker.state = 'open';
    }
  }

  
  recordLatency(apiId, responseTime) {
    if (!this.apiLatencies.has(apiId)) {
      this.apiLatencies.set(apiId, { avg: responseTime, samples: 1 });
      return;
    }

    const latData = this.apiLatencies.get(apiId);
    const totalSamples = latData.samples + 1;
    
    
    if (totalSamples <= this.latencyWindow) {
      latData.avg = ((latData.avg * latData.samples) + responseTime) / totalSamples;
      latData.samples = totalSamples;
    } else {
      
      const alpha = 2 / (this.latencyWindow + 1);
      latData.avg = (alpha * responseTime) + ((1 - alpha) * latData.avg);
    }
  }

  /**
   * Retorna status dos circuit breakers
   */
  getCircuitBreakerStatus() {
    const status = [];
    for (const [apiId, breaker] of this.circuitBreakers) {
      status.push({
        apiId,
        failures: breaker.failures,
        state: breaker.state,
        lastFailure: breaker.lastFailure ? new Date(breaker.lastFailure).toISOString() : null
      });
    }
    return status;
  }

  
  resetRotation() {
    this.currentIndex = 0;
    this.cachedHealthyApis = [];
    this.lastCacheUpdate = 0;
    logger.info('[Rotator] Rotation index reset');
  }

  
  invalidateCache() {
    this.cachedHealthyApis = [];
    this.lastCacheUpdate = 0;
    this._poolCache.lastBuilt = 0;
  }

  
  logRotation(apiId, strategy) {
    this.rotationHistory.push({
      timestamp: new Date().toISOString(),
      apiId,
      strategy
    });

    if (this.rotationHistory.length > this.maxHistorySize) {
      this.rotationHistory = this.rotationHistory.slice(-this.maxHistorySize);
    }
  }

  
  getRotationStats() {
    const apis = apiConfig.getAllApis();
    return {
      totalApis: apis.length,
      strategy: this.useWeightedSelection ? 'weighted-random' : 'latency-based',
      totalRotations: this.rotationHistory.length,
      recentRotations: this.rotationHistory.slice(-10),
      circuitBreakerCount: this.circuitBreakers.size,
      speedRankingSize: this.speedRanking.size,
      currentIndex: this.currentIndex
    };
  }

  
  getRateLimitedApis() {
    const apis = apiConfig.getAllApis();
    const rateLimited = [];

    for (const api of apis) {
      if (!apiConfig.canMakeRequest(api.id)) {
        rateLimited.push({
          id: api.id,
          name: api.name,
          maxRpm: api.rateLimit || 40
        });
      }
    }

    return {
      count: rateLimited.length,
      apis: rateLimited
    };
  }

  
  getRotationHistory(limit = 100) {
    return this.rotationHistory.slice(-limit);
  }
}

module.exports = new RotatorService();
