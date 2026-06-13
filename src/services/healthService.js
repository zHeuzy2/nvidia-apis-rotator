

const { Pool } = require('undici');
const dns = require('dns');
const apiConfig = require('../config/apiConfig');
const rotatorService = require('./rotatorService');

// ============================================
// DNS CACHING
// ============================================
let cacheableLookup = null;
try {
  const CacheableLookupModule = require('cacheable-lookup');
  const CacheableLookup = CacheableLookupModule.default || CacheableLookupModule;
  cacheableLookup = new CacheableLookup({
    maxTtl: 3600,
    fallbackDuration: 300
  });
} catch (e) {
  // Fallback
}

dns.setDefaultResultOrder('ipv4first');

class HealthService {
  constructor() {
    this.checkInterval = 30000;         // Health check simples: 30s
    this.benchmarkInterval = 60000;     // Speed benchmark: 60s (staggered)
    this.warmupInterval = 15000;        // Pre-warm: 15s
    this.intervalId = null;
    this.benchmarkIntervalId = null;
    this.warmupIntervalId = null;
    this.healthHistory = [];
    this.maxHistorySize = 1000;

    // ============================================
    // SPEED RANKING SYSTEM
    // ============================================
    this.speedRanking = new Map();       // apiId → { samples, avgSpeed, weight, rank }
    this.rankingWindow = 8;              
    this.benchmarkTimeout = 30000;       // Timeout duro: 30s
    this.slowThreshold = 8000;           
    this.unhealthyThreshold = 30000;     // APIs > 30s = unhealthy

    
    this.pools = new Map(); // apiId → Pool
  }

  
  getPool(api) {
    if (this.pools.has(api.id)) {
      return this.pools.get(api.id);
    }
    
    const url = new URL(api.baseUrl);
    const poolOptions = {
      connections: 4,
      allowH2: false,
      keepAliveTimeout: 10000,
      keepAliveMaxTimeout: 30000,
      bodyTimeout: 35000,
      headersTimeout: 10000,
      connectTimeout: 8000,
    };

    if (cacheableLookup) {
      try { cacheableLookup.install(poolOptions); } catch (e) { /* ignore */ }
    }

    const pool = new Pool(url.origin, poolOptions);
    this.pools.set(api.id, pool);
    return pool;
  }

  
  start() {
    if (this.intervalId) {
      console.log('Health check já está rodando');
      return;
    }

    console.log('Iniciando health check monitor + speed ranking...');
    
    // Pre-warm inicial
    this.warmupConnections();
    
    // Faz check inicial
    this.checkAll();
    
    
    
    this.benchmarkAll().then(() => {
      console.log('[SpeedRank] Ranking inicial construído');
    });

    
    this.intervalId = setInterval(() => {
      this.checkAll();
    }, this.checkInterval);

    // Agenda speed benchmarks (chat completion real: mede velocidade)
    this.benchmarkIntervalId = setInterval(() => {
      this.benchmarkAll();
    }, this.benchmarkInterval);

    
    this.warmupIntervalId = setInterval(() => {
      this.warmupConnections();
    }, this.warmupInterval);

    // Log inicial
    console.log(`  Health check: a cada ${this.checkInterval / 1000}s`);
    console.log(`  Speed benchmark: a cada ${this.benchmarkInterval / 1000}s`);
    console.log(`  Ranking window: ${this.rankingWindow} amostras`);
    console.log(`  Slow threshold: ${this.slowThreshold / 1000}s`);
  }

  
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.benchmarkIntervalId) {
      clearInterval(this.benchmarkIntervalId);
      this.benchmarkIntervalId = null;
    }
    if (this.warmupIntervalId) {
      clearInterval(this.warmupIntervalId);
      this.warmupIntervalId = null;
    }
    console.log('Health check monitor parado');
  }

  
  async warmupConnections() {
    const apis = apiConfig.getHealthyApis();
    
    const warmupPromises = apis.map(async (api) => {
      try {
        const pool = this.getPool(api);
        const baseUrlObj = new URL(api.baseUrl);
        const basePath = baseUrlObj.pathname.replace(/\/$/, '');
        await pool.request({
          method: 'HEAD',
          path: basePath + '/models',
          headers: { 'Authorization': `Bearer ${api.apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        
      } catch (e) {
        
      }
    });

    await Promise.allSettled(warmupPromises);
  }

  
  async checkAll() {
    const apis = apiConfig.getAllApis();
    
    const checkPromises = apis.map(api => this.checkApi(api));
    const checkResults = await Promise.allSettled(checkPromises);
    
    const results = [];
    for (const result of checkResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      }
    }

    this.healthHistory.push({
      timestamp: new Date().toISOString(),
      results
    });

    if (this.healthHistory.length > this.maxHistorySize) {
      this.healthHistory = this.healthHistory.slice(-this.maxHistorySize);
    }

    return results;
  }

  
  async checkApi(api) {
    const startTime = Date.now();
    
    try {
      const pool = this.getPool(api);
      const baseUrlObj = new URL(api.baseUrl);
      const basePath = baseUrlObj.pathname.replace(/\/$/, '');
      const response = await pool.request({
        method: 'GET',
        path: basePath + '/models',
        headers: {
          'Authorization': `Bearer ${api.apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(10000),
      });

      const responseTime = Date.now() - startTime;
      const healthy = response.statusCode >= 200 && response.statusCode < 300;

      rotatorService.recordLatency(api.id, responseTime);
      rotatorService.recordSuccess(api.id);

      apiConfig.updateApi(api.id, { 
        healthy,
        lastHealthCheck: new Date().toISOString(),
        lastHealthCheckResponseTime: responseTime
      });

      return {
        apiId: api.id,
        name: api.name,
        healthy,
        responseTime,
        status: response.statusCode,
        checkedAt: new Date().toISOString()
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      // Rate limit → ainda healthy
      if (error.statusCode === 429) {
        apiConfig.updateApi(api.id, { 
          healthy: true,
          lastHealthCheck: new Date().toISOString(),
          lastHealthCheckResponseTime: responseTime,
          rateLimited: true
        });

        return {
          apiId: api.id,
          name: api.name,
          healthy: true,
          rateLimited: true,
          responseTime,
          status: 429,
          checkedAt: new Date().toISOString()
        };
      }

      rotatorService.recordFailure(api.id);

      apiConfig.updateApi(api.id, { 
        healthy: false,
        lastHealthCheck: new Date().toISOString(),
        lastHealthCheckResponseTime: responseTime,
        lastError: error.message
      });

      return {
        apiId: api.id,
        name: api.name,
        healthy: false,
        responseTime,
        status: error.statusCode || 0,
        error: error.message,
        checkedAt: new Date().toISOString()
      };
    }
  }

  // ============================================
  // SPEED BENCHMARK SYSTEM
  // ============================================

  
  async benchmarkApiSpeed(api) {
    const testBody = JSON.stringify({
      model: 'moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
      max_tokens: 10,
      temperature: 0,
      stream: false
    });

    const startTime = Date.now();
    
    try {
      const pool = this.getPool(api);
      const baseUrlObj = new URL(api.baseUrl);
      const basePath = baseUrlObj.pathname.replace(/\/$/, '');
      const response = await pool.request({
        method: 'POST',
        path: basePath + '/chat/completions',
        headers: {
          'Authorization': `Bearer ${api.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: testBody,
        signal: AbortSignal.timeout(this.benchmarkTimeout),
      });

      const elapsed = Date.now() - startTime;

      if (response.statusCode >= 200 && response.statusCode < 300) {
        
        try { await response.body.text(); } catch (e) { /* ignore */ }
        
        return { 
          healthy: true, 
          responseTime: elapsed, 
          timedOut: false,
          status: response.statusCode
        };
      }
      
      return { 
        healthy: false, 
        responseTime: elapsed, 
        timedOut: false, 
        status: response.statusCode 
      };

    } catch (error) {
      const elapsed = Date.now() - startTime;
      const timedOut = error.code === 'UND_ERR_HEADERS_TIMEOUT' || 
                       error.code === 'UND_ERR_BODY_TIMEOUT' ||
                       error.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                       error.name === 'TimeoutError' ||
                       error.name === 'AbortError';
      
      return { 
        healthy: false, 
        responseTime: elapsed, 
        timedOut, 
        error: error.message 
      };
    }
  }

  
  async benchmarkAll() {
    const apis = apiConfig.getAllApis().filter(a => a.enabled);
    if (apis.length === 0) return;

    
    
    const results = [];
    for (const api of apis) {
      const r = await this.benchmarkApiSpeed(api).catch(e => ({ healthy: false, responseTime: 0, timedOut: true, error: e.message }));
      results.push({ status: 'fulfilled', value: r });
      await this.sleep(300);
    }

    let updatedCount = 0;
    let timeoutCount = 0;
    let slowCount = 0;

    for (let i = 0; i < apis.length; i++) {
      const result = results[i];
      const api = apis[i];

      if (result.status !== 'fulfilled') {
        apiConfig.updateApi(api.id, { healthy: false });
        this.updateRanking(api.id, null);
        continue;
      }

      const { healthy, responseTime, timedOut, status } = result.value;

      if (timedOut) {
        // Timeout = unhealthy
        apiConfig.updateApi(api.id, { healthy: false });
        this.updateRanking(api.id, null);
        timeoutCount++;
        continue;
      }

      if (!healthy && status && status >= 500) {
        
        apiConfig.updateApi(api.id, { healthy: false });
        this.updateRanking(api.id, null);
        continue;
      }

      
      apiConfig.updateApi(api.id, { healthy: true });
      this.updateRanking(api.id, responseTime);
      updatedCount++;

      if (responseTime > this.slowThreshold) {
        slowCount++;
      }
    }

    
    this.computeWeights();

    
    rotatorService.updateSpeedRanking(this.speedRanking);

    // Log resumido
    const rankedList = [...this.speedRanking.entries()]
      .filter(([_, r]) => r.rank > 0 && r.rank < 999)
      .sort((a, b) => a[1].rank - b[1].rank);

    if (rankedList.length > 0) {
      const top3 = rankedList.slice(0, 3)
        .map(([id, r]) => `${id}(${r.avgSpeed.toFixed(0)}ms/w${r.weight.toFixed(3)})`)
        .join(' ');
      const bottom3 = rankedList.slice(-3)
        .map(([id, r]) => `${id}(${r.avgSpeed.toFixed(0)}ms)`).join(' ');
      
      console.log(`[SpeedRank] ${updatedCount} OK, ${timeoutCount} timeout, ${slowCount} slow | Top: ${top3} | Bottom: ${bottom3}`);
    }
  }

  
  updateRanking(apiId, responseTime) {
    if (!this.speedRanking.has(apiId)) {
      this.speedRanking.set(apiId, { 
        samples: [], 
        avgSpeed: 0, 
        weight: 0.01,  
        rank: 0 
      });
    }

    const ranking = this.speedRanking.get(apiId);

    if (responseTime === null) {
      
      ranking.avgSpeed = 999999;
      ranking.weight = 0.001;  // Quase zero
      ranking.rank = 999;
      ranking.samples = [];
      return;
    }

    
    ranking.samples.push(responseTime);
    if (ranking.samples.length > this.rankingWindow) {
      ranking.samples.shift();
    }

    
    ranking.avgSpeed = ranking.samples.reduce((a, b) => a + b, 0) / ranking.samples.length;
  }

  
  computeWeights() {
    const entries = [...this.speedRanking.entries()]
      .filter(([_, r]) => r.avgSpeed > 0 && r.avgSpeed < 999999);

    if (entries.length === 0) return;
    if (entries.length === 1) {
      const [apiId, r] = entries[0];
      r.weight = 1.0;
      r.rank = 1;
      return;
    }

    
    entries.sort((a, b) => a[1].avgSpeed - b[1].avgSpeed);

    // Atribui ranks
    entries.forEach(([_, r], i) => { r.rank = i + 1; });

    
    const totalWeight = entries.reduce((sum, [_, r]) => {
      const speed = Math.max(r.avgSpeed, 100); 
      
      if (r.avgSpeed > this.slowThreshold) {
        // APIs muito lentas: penalidade 50x
        return sum + (100 / speed) * 0.02;
      } else if (r.avgSpeed > 5000) {
        // APIs lentas (>5s): penalidade 10x
        return sum + (100 / speed) * 0.1;
      } else if (r.avgSpeed > 2000) {
        
        return sum + (500 / speed);
      } else {
        
        return sum + (1000 / speed);
      }
    }, 0);

    if (totalWeight === 0) {
      // Fallback: pesos iguais
      const equalWeight = 1.0 / entries.length;
      entries.forEach(([_, r]) => { r.weight = equalWeight; });
      return;
    }

    
    for (const [_, r] of entries) {
      const speed = Math.max(r.avgSpeed, 100);
      
      let rawWeight;
      if (r.avgSpeed > this.slowThreshold) {
        rawWeight = (100 / speed) * 0.02;
      } else if (r.avgSpeed > 5000) {
        rawWeight = (100 / speed) * 0.1;
      } else if (r.avgSpeed > 2000) {
        rawWeight = 500 / speed;
      } else {
        rawWeight = 1000 / speed;
      }
      
      r.weight = rawWeight / totalWeight;
    }
  }

  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  
  getSpeedRanking() {
    const result = [];
    for (const [apiId, ranking] of this.speedRanking) {
      const api = apiConfig.getApi(apiId);
      result.push({
        apiId,
        name: api?.name || apiId,
        healthy: api?.healthy || false,
        avgSpeed: Math.round(ranking.avgSpeed),
        weight: Number(ranking.weight.toFixed(4)),
        rank: ranking.rank,
        samples: ranking.samples.length
      });
    }

    
    result.sort((a, b) => a.rank - b.rank);
    return result;
  }

  
  getStatus() {
    const apis = apiConfig.getAllApis();
    const ranking = this.getSpeedRanking();
    
    return {
      timestamp: new Date().toISOString(),
      monitoring: !!this.intervalId,
      checkInterval: this.checkInterval,
      benchmarkInterval: this.benchmarkInterval,
      warmupInterval: this.warmupInterval,
      circuitBreakers: rotatorService.getCircuitBreakerStatus(),
      speedRanking: ranking,
      apis: apis.map(api => {
        const rank = this.speedRanking.get(api.id);
        return {
          id: api.id,
          name: api.name,
          healthy: api.healthy,
          enabled: api.enabled,
          lastHealthCheck: api.lastHealthCheck || null,
          lastResponseTime: api.lastHealthCheckResponseTime || null,
          currentRpm: api.requestWindow?.length || 0,
          maxRpm: api.rateLimit,
          speedRank: rank?.rank || null,
          speedAvg: rank?.avgSpeed ? Math.round(rank.avgSpeed) : null,
          speedWeight: rank?.weight ? Number(rank.weight.toFixed(4)) : null
        };
      })
    };
  }

  
  getHistory(limit = 100) {
    return this.healthHistory.slice(-limit);
  }

  
  async forceCheck() {
    await this.checkAll();
    await this.benchmarkAll();
    return this.getStatus();
  }

  
  setInterval(ms) {
    this.checkInterval = ms;
    if (this.intervalId) {
      this.stop();
      this.start();
    }
  }
}

module.exports = new HealthService();
