#!/usr/bin/env node

/**
 * Benchmark Script para NVIDIA API Rotator
 * 
 * Testa:
 * - Latência inicial (TTFT - Time to First Token)
 * - Throughput de streaming
 * - Cache hit/miss
 * - Throughput total
 * - Conexões paralelas
 * 
 * Uso:
 *   node scripts/benchmark.js [url] [options]
 * 
 * Exemplos:
 *   node scripts/benchmark.js http://localhost:3000
 *   node scripts/benchmark.js http://localhost:3000 --requests 20
 *   node scripts/benchmark.js http://localhost:3000 --streaming
 */

const http = require('http');
const https = require('https');

// ============================================
// PARSING DE ARGUMENTOS (corrigido)
// ============================================
function parseArgs() {
  const args = process.argv.slice(2);
  
  // Encontra a URL (argumento que começa com http:// ou https://)
  const urlArg = args.find(a => a.startsWith('http://') || a.startsWith('https://'));
  
  // Encontra valores de opções
  const getOption = (name, defaultValue) => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : defaultValue;
  };
  
  return {
    baseUrl: urlArg || 'http://localhost:80',
    apiKey: process.env.PROXY_API_KEY || process.env.BENCHMARK_API_KEY || 'test-key',
    requests: parseInt(getOption('requests', '10')),
    parallel: parseInt(getOption('parallel', '3')),
    streaming: args.includes('--streaming'),
    verbose: args.includes('--verbose'),
    model: getOption('model', 'moonshotai/kimi-k2.6')
  };
}

const config = parseArgs();

// Cores para output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

function c(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

// ============================================
// UTILIDADES
// ============================================
function formatMs(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  const avg = average(arr);
  const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
  return Math.sqrt(average(squareDiffs));
}

// ============================================
// REQUESTS
// ============================================
async function makeRequest(endpoint, body, stream = false) {
  const url = new URL(endpoint, config.baseUrl);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    }
  };

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let firstByteTime = null;
    let responseData = '';
    let bytesReceived = 0;
    let tokensReceived = 0;

    const req = lib.request(options, (res) => {
      res.on('data', (chunk) => {
        if (!firstByteTime) {
          firstByteTime = Date.now();
        }
        responseData += chunk.toString();
        bytesReceived += chunk.length;

        // Conta tokens em streaming
        if (stream) {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.choices?.[0]?.delta?.content) {
                  tokensReceived++;
                }
              } catch (e) {}
            }
          }
        }
      });

      res.on('end', () => {
        const endTime = Date.now();
        const totalTime = endTime - startTime;
        const ttft = firstByteTime ? firstByteTime - startTime : totalTime;

        // Extrai tokens da resposta não-streaming
        if (!stream) {
          try {
            const json = JSON.parse(responseData);
            tokensReceived = json.usage?.completion_tokens || 0;
          } catch (e) {}
        }

        resolve({
          success: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          totalTime,
          ttft,
          bytesReceived,
          tokensReceived,
          fromCache: res.headers['x-from-cache'] === 'true',
          apiUsed: res.headers['x-api-used'],
          responseTime: parseInt(res.headers['x-response-time']) || totalTime
        });
      });
    });

    req.on('error', (error) => {
      resolve({
        success: false,
        error: error.message,
        totalTime: Date.now() - startTime,
        ttft: 0,
        bytesReceived: 0,
        tokensReceived: 0
      });
    });

    req.write(JSON.stringify(body));
    req.end();
  });
}

// ============================================
// TESTES
// ============================================

async function testLatency() {
  console.log(c('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(c('bright', '  📊 TESTE DE LATÊNCIA (TTFT)'));
  console.log(c('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

  const results = [];
  const prompt = 'Responda apenas: OK';

  console.log(`\n  Modelo: ${c('yellow', config.model)}`);
  console.log(`  Requests: ${config.requests}`);
  console.log(`  Prompt: "${prompt}"\n`);

  for (let i = 0; i < config.requests; i++) {
    process.stdout.write(`  Request ${i + 1}/${config.requests}... `);
    
    const result = await makeRequest('/v1/chat/completions', {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      temperature: 0
    });

    results.push(result);

    if (result.success) {
      console.log(c('green', `✓ ${formatMs(result.ttft)} TTFT, ${formatMs(result.totalTime)} total`));
    } else {
      console.log(c('red', `✗ ${result.error || result.statusCode}`));
    }
  }

  // Estatísticas
  const successful = results.filter(r => r.success);
  if (successful.length > 0) {
    const ttfts = successful.map(r => r.ttft);
    const totals = successful.map(r => r.totalTime);

    console.log(c('cyan', '\n  ┌─────────────────────────────────────────────────┐'));
    console.log(c('cyan', '  │') + c('bright', '  RESULTADOS DE LATÊNCIA                        ') + c('cyan', '│'));
    console.log(c('cyan', '  ├─────────────────────────────────────────────────┤'));
    console.log(c('cyan', '  │') + `  Sucesso: ${c('green', successful.length)}/${results.length}                              ` + c('cyan', '│'));
    console.log(c('cyan', '  │') + `  TTFT Médio: ${c('yellow', formatMs(average(ttfts)).padEnd(10))}                      ` + c('cyan', '│'));
    console.log(c('cyan', '  │') + `  TTFT P50:   ${c('yellow', formatMs(percentile(ttfts, 50)).padEnd(10))}                      ` + c('cyan', '│'));
    console.log(c('cyan', '  │') + `  TTFT P95:   ${c('yellow', formatMs(percentile(ttfts, 95)).padEnd(10))}                      ` + c('cyan', '│'));
    console.log(c('cyan', '  │') + `  TTFT P99:   ${c('yellow', formatMs(percentile(ttfts, 99)).padEnd(10))}                      ` + c('cyan', '│'));
    console.log(c('cyan', '  │') + `  Total Médio: ${c('yellow', formatMs(average(totals)).padEnd(10))}                     ` + c('cyan', '│'));
    console.log(c('cyan', '  │') + `  Std Dev:     ${c('yellow', formatMs(stdDev(ttfts)).padEnd(10))}                     ` + c('cyan', '│'));
    console.log(c('cyan', '  └─────────────────────────────────────────────────┘'));
  }

  return results;
}

async function testStreaming() {
  console.log(c('magenta', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(c('bright', '  🌊 TESTE DE STREAMING'));
  console.log(c('magenta', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

  const results = [];
  const prompt = 'Conte de 1 a 10, um número por linha.';

  console.log(`\n  Modelo: ${c('yellow', config.model)}`);
  console.log(`  Requests: ${config.requests}`);
  console.log(`  Streaming: ${c('green', 'ATIVADO')}\n`);

  for (let i = 0; i < config.requests; i++) {
    process.stdout.write(`  Stream ${i + 1}/${config.requests}... `);
    
    const result = await makeRequest('/v1/chat/completions', {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0,
      stream: true
    }, true);

    results.push(result);

    if (result.success) {
      const tokensPerSec = result.tokensReceived / (result.totalTime / 1000);
      console.log(c('green', `✓ TTFT: ${formatMs(result.ttft)}, ${result.tokensReceived} tokens, ${tokensPerSec.toFixed(1)} tok/s`));
    } else {
      console.log(c('red', `✗ ${result.error || result.statusCode}`));
    }
  }

  // Estatísticas
  const successful = results.filter(r => r.success);
  if (successful.length > 0) {
    const ttfts = successful.map(r => r.ttft);
    const tokensPerSec = successful.map(r => r.tokensReceived / (r.totalTime / 1000));

    console.log(c('magenta', '\n  ┌─────────────────────────────────────────────────┐'));
    console.log(c('magenta', '  │') + c('bright', '  RESULTADOS DE STREAMING                       ') + c('magenta', '│'));
    console.log(c('magenta', '  ├─────────────────────────────────────────────────┤'));
    console.log(c('magenta', '  │') + `  Sucesso: ${c('green', successful.length)}/${results.length}                              ` + c('magenta', '│'));
    console.log(c('magenta', '  │') + `  TTFT Médio: ${c('yellow', formatMs(average(ttfts)).padEnd(10))}                      ` + c('magenta', '│'));
    console.log(c('magenta', '  │') + `  TTFT P95:   ${c('yellow', formatMs(percentile(ttfts, 95)).padEnd(10))}                      ` + c('magenta', '│'));
    console.log(c('magenta', '  │') + `  Tokens/s:   ${c('yellow', average(tokensPerSec).toFixed(1).padEnd(10))}                      ` + c('magenta', '│'));
    console.log(c('magenta', '  └─────────────────────────────────────────────────┘'));
  }

  return results;
}

async function testCache() {
  console.log(c('blue', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(c('bright', '  💾 TESTE DE CACHE'));
  console.log(c('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

  const prompt = 'Qual é a capital do Brasil?';
  console.log(`\n  Prompt: "${prompt}"`);
  console.log(`  Temperature: 0 (para habilitar cache)\n`);

  // Primeira requisição (cache miss)
  console.log('  1. Primeira requisição (cache miss esperado)...');
  const first = await makeRequest('/v1/chat/completions', {
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 50,
    temperature: 0
  });

  if (first.success) {
    console.log(c('yellow', `     → ${formatMs(first.totalTime)} - Cache: ${first.fromCache ? 'HIT' : 'MISS'}`));
  } else {
    console.log(c('red', `     → Erro: ${first.error || first.statusCode}`));
  }

  // Segunda requisição (cache hit esperado)
  console.log('\n  2. Segunda requisição (cache hit esperado)...');
  const second = await makeRequest('/v1/chat/completions', {
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 50,
    temperature: 0
  });

  if (second.success) {
    console.log(c('green', `     → ${formatMs(second.totalTime)} - Cache: ${second.fromCache ? 'HIT' : 'MISS'}`));
  } else {
    console.log(c('red', `     → Erro: ${second.error || second.statusCode}`));
  }

  // Terceira requisição diferente (cache miss)
  console.log('\n  3. Requisição diferente (cache miss esperado)...');
  const third = await makeRequest('/v1/chat/completions', {
    model: config.model,
    messages: [{ role: 'user', content: 'Qual é a capital da Argentina?' }],
    max_tokens: 50,
    temperature: 0
  });

  if (third.success) {
    console.log(c('yellow', `     → ${formatMs(third.totalTime)} - Cache: ${third.fromCache ? 'HIT' : 'MISS'}`));
  } else {
    console.log(c('red', `     → Erro: ${third.error || third.statusCode}`));
  }

  // Resumo
  const speedup = first.totalTime / Math.max(1, second.totalTime);
  console.log(c('blue', '\n  ┌─────────────────────────────────────────────────┐'));
  console.log(c('blue', '  │') + c('bright', '  RESULTADOS DE CACHE                           ') + c('blue', '│'));
  console.log(c('blue', '  ├─────────────────────────────────────────────────┤'));
  console.log(c('blue', '  │') + `  Tempo sem cache:  ${c('yellow', formatMs(first.totalTime).padEnd(10))}                  ` + c('blue', '│'));
  console.log(c('blue', '  │') + `  Tempo com cache:  ${c('green', formatMs(second.totalTime).padEnd(10))}                  ` + c('blue', '│'));
  console.log(c('blue', '  │') + `  Speedup:          ${c('green', (speedup.toFixed(1) + 'x').padEnd(10))}                  ` + c('blue', '│'));
  console.log(c('blue', '  └─────────────────────────────────────────────────┘'));

  return { first, second, third, speedup };
}

async function testParallel() {
  console.log(c('yellow', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(c('bright', '  ⚡ TESTE DE REQUISIÇÕES PARALELAS'));
  console.log(c('yellow', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

  console.log(`\n  Parallelismo: ${config.parallel} requisições simultâneas`);
  console.log(`  Total: ${config.requests} requisições\n`);

  const allResults = [];
  const startTime = Date.now();

  for (let batch = 0; batch < Math.ceil(config.requests / config.parallel); batch++) {
    const batchSize = Math.min(config.parallel, config.requests - batch * config.parallel);
    process.stdout.write(`  Batch ${batch + 1} (${batchSize} paralelas)... `);

    const promises = [];
    for (let i = 0; i < batchSize; i++) {
      promises.push(makeRequest('/v1/chat/completions', {
        model: config.model,
        messages: [{ role: 'user', content: `Diga apenas: ${batch * config.parallel + i + 1}` }],
        max_tokens: 10,
        temperature: 0.1
      }));
    }

    const results = await Promise.all(promises);
    allResults.push(...results);

    const successful = results.filter(r => r.success).length;
    const avgTime = average(results.map(r => r.totalTime));
    console.log(c('green', `✓ ${successful}/${batchSize} OK, avg: ${formatMs(avgTime)}`));
  }

  const totalTime = Date.now() - startTime;
  const successful = allResults.filter(r => r.success);
  const rps = (successful.length / totalTime) * 1000;

  console.log(c('yellow', '\n  ┌─────────────────────────────────────────────────┐'));
  console.log(c('yellow', '  │') + c('bright', '  RESULTADOS PARALELOS                          ') + c('yellow', '│'));
  console.log(c('yellow', '  ├─────────────────────────────────────────────────┤'));
  console.log(c('yellow', '  │') + `  Total: ${successful.length}/${allResults.length} sucesso                         ` + c('yellow', '│'));
  console.log(c('yellow', '  │') + `  Tempo total: ${c('green', formatMs(totalTime).padEnd(10))}                     ` + c('yellow', '│'));
  console.log(c('yellow', '  │') + `  RPS: ${c('green', rps.toFixed(2).padEnd(10))} req/s                     ` + c('yellow', '│'));
  console.log(c('yellow', '  │') + `  Latência média: ${c('green', formatMs(average(successful.map(r => r.totalTime))).padEnd(10))}                ` + c('yellow', '│'));
  console.log(c('yellow', '  └─────────────────────────────────────────────────┘'));

  return { allResults, totalTime, rps };
}

async function testHealth() {
  console.log(c('green', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(c('bright', '  🏥 STATUS DO SERVIDOR'));
  console.log(c('green', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

  try {
    const url = new URL('/health', config.baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const result = await new Promise((resolve, reject) => {
      const req = lib.get({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        headers: { 'Authorization': `Bearer ${config.apiKey}` }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });
      req.on('error', reject);
    });

    console.log(`\n  Status: ${c('green', result.status)}`);
    console.log(`  Uptime: ${result.uptime}`);
    console.log(`  Version: ${result.version}`);
    console.log(`\n  APIs:`);
    console.log(`    Total: ${result.apis?.total || 0}`);
    console.log(`    Healthy: ${c('green', result.apis?.healthy || 0)}`);
    console.log(`    Enabled: ${result.apis?.enabled || 0}`);
    
    if (result.cache) {
      console.log(`\n  Cache:`);
      console.log(`    Hits: ${c('green', result.cache.hits || 0)}`);
      console.log(`    Misses: ${result.cache.misses || 0}`);
      console.log(`    Hit Rate: ${c('yellow', result.cache.hitRate || '0%')}`);
    }

    if (result.circuitBreakers && Object.keys(result.circuitBreakers).length > 0) {
      console.log(`\n  Circuit Breakers:`);
      for (const [id, breaker] of Object.entries(result.circuitBreakers)) {
        const stateColor = breaker.state === 'CLOSED' ? 'green' : breaker.state === 'OPEN' ? 'red' : 'yellow';
        console.log(`    ${id}: ${c(stateColor, breaker.state)} (${breaker.failures} failures)`);
      }
    }

    return result;
  } catch (error) {
    console.log(c('red', `\n  Erro ao obter status: ${error.message}`));
    console.log(c('yellow', '  (Certifique-se que o servidor está rodando e a API key está correta)'));
    return null;
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log(c('bright', '\n╔═══════════════════════════════════════════════════════╗'));
  console.log(c('bright', '║   🚀 NVIDIA API ROTATOR - BENCHMARK v2.0              ║'));
  console.log(c('bright', '╚═══════════════════════════════════════════════════════╝'));

  console.log(`\n  URL: ${c('cyan', config.baseUrl)}`);
  console.log(`  Modelo: ${c('cyan', config.model)}`);
  console.log(`  Requests: ${config.requests}`);
  console.log(`  Parallelismo: ${config.parallel}`);

  // Testa conexão primeiro
  await testHealth();

  // Roda os benchmarks
  const latencyResults = await testLatency();
  
  if (config.streaming) {
    await testStreaming();
  }

  await testCache();
  await testParallel();

  // Resumo final
  console.log(c('bright', '\n╔═══════════════════════════════════════════════════════╗'));
  console.log(c('bright', '║   📋 RESUMO FINAL                                     ║'));
  console.log(c('bright', '╚═══════════════════════════════════════════════════════╝'));

  const successful = latencyResults.filter(r => r.success);
  if (successful.length > 0) {
    const ttfts = successful.map(r => r.ttft);
    console.log(`\n  TTFT Médio: ${c('green', formatMs(average(ttfts)))}`);
    console.log(`  TTFT P95:   ${c('yellow', formatMs(percentile(ttfts, 95)))}`);
    console.log(`  Taxa de Sucesso: ${c('green', ((successful.length / latencyResults.length) * 100).toFixed(1) + '%')}`);
  }

  console.log(c('bright', '\n  Benchmark concluído! ✨\n'));
}

// Ajuda
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
  Uso: node scripts/benchmark.js [url] [options]

  Opções:
    --requests=N     Número de requisições por teste (default: 10)
    --parallel=N     Requisições paralelas (default: 3)
    --streaming      Inclui teste de streaming
    --model=MODEL    Modelo a usar (default: deepseek-ai/deepseek-r1)
    --verbose        Output detalhado
    --help, -h       Mostra esta ajuda

  Variáveis de ambiente:
    BENCHMARK_API_KEY   API key para autenticação

  Exemplos:
    node scripts/benchmark.js http://localhost:3000
    node scripts/benchmark.js http://api.example.com --requests=50 --streaming
    node scripts/benchmark.js http://localhost:3000 --model=nvidia/nemotron-3-nano-30b-a3b
  `);
  process.exit(0);
}

main().catch(error => {
  console.error(c('red', `\nErro fatal: ${error.message}`));
  process.exit(1);
});
