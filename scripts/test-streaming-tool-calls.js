

const http = require('http');
const readline = require('readline');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3000';
const API_KEY = process.env.PROXY_API_KEY || process.env.TEST_API_KEY || 'test-key';
const MODEL = process.env.TEST_MODEL || 'moonshotai/kimi-k2.5';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testStreamingWithToolCalls() {
  log('\n🧪 Testando Streaming com Tool Calls\n', 'cyan');
  log('='.repeat(60), 'cyan');

  const testResults = {
    textStreaming: false,
    toolCallsReceived: false,
    noDuplication: true,
    validJSON: true,
    noUndefined: true,
    errors: [],
  };

  const requestBody = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: 'Leia o arquivo /test/readme.txt e depois liste os arquivos do diretório',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Lê um arquivo',
          parameters: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
            required: ['filePath'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'ls',
          description: 'Lista diretório',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      },
    ],
    stream: true,
  };

  return new Promise((resolve, reject) => {
    const url = new URL(`${PROXY_URL}/v1/chat/completions`);
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'text/event-stream',
      },
    };

    let receivedText = '';
    let receivedToolCalls = [];
    let textStarted = false;
    let textChunks = 0;
    let toolCallFragments = [];

    log('⏳ Enviando requisição...\n', 'yellow');

    const req = http.request(options, (res) => {
      log(`📡 Status: ${res.statusCode}`, 'blue');
      log(`📡 Content-Type: ${res.headers['content-type']}\n`, 'blue');

      if (res.statusCode !== 200) {
        testResults.errors.push(`HTTP ${res.statusCode}`);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const rl = readline.createInterface({
        input: res,
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        if (!line.startsWith('data: ')) return;

        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          log('\n✅ Stream finalizado\n', 'green');
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) return;

          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          // Verifica texto progressivo
          if (delta?.content) {
            textStarted = true;
            textChunks++;
            receivedText += delta.content;
            process.stdout.write(colors.cyan + delta.content + colors.reset);
            
            
            if (textChunks > 1) {
              testResults.textStreaming = true;
            }
          }

          
          if (delta?.tool_calls) {
            toolCallFragments.push({
              timestamp: Date.now(),
              toolCalls: JSON.parse(JSON.stringify(delta.tool_calls)),
            });

            delta.tool_calls.forEach((tc, idx) => {
              if (!receivedToolCalls[idx]) {
                receivedToolCalls[idx] = {
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                  fragments: [],
                };
              }

              // Acumula arguments
              if (tc.function?.arguments) {
                receivedToolCalls[idx].arguments += tc.function.arguments;
                receivedToolCalls[idx].fragments.push(tc.function.arguments);
              }

              
              if (tc.function?.name) {
                receivedToolCalls[idx].name = tc.function.name;
              }

              
              if (tc.id) {
                receivedToolCalls[idx].id = tc.id;
              }
            });
          }

          // Quando recebe finish_reason tool_calls
          if (finishReason === 'tool_calls') {
            log('\n\n📦 Tool Calls recebidas!\n', 'green');
            testResults.toolCallsReceived = true;

            
            receivedToolCalls.forEach((tc, idx) => {
              log(`\n🔧 Tool Call ${idx + 1}:`, 'yellow');
              log(`   ID: ${tc.id}`, 'reset');
              log(`   Name: ${tc.name}`, 'reset');
              log(`   Arguments: ${tc.arguments.substring(0, 100)}...`, 'reset');
              log(`   Fragments: ${tc.fragments.length}`, 'reset');

              try {
                const parsedArgs = JSON.parse(tc.arguments);
                log(`   ✅ JSON válido`, 'green');

                // Verifica undefined
                const hasUndefined = JSON.stringify(parsedArgs).includes('undefined');
                if (hasUndefined) {
                  testResults.noUndefined = false;
                  testResults.errors.push(`Tool call ${idx} contém undefined`);
                  log(`   ❌ Contém undefined`, 'red');
                }

                
                const totalFragments = tc.fragments.join('');
                if (tc.arguments !== totalFragments) {
                  
                  if (!totalFragments.includes(tc.arguments)) {
                    testResults.noDuplication = false;
                    testResults.errors.push(`Tool call ${idx} pode estar duplicada`);
                    log(`   ⚠️  Possível duplicação detectada`, 'yellow');
                  }
                }
              } catch (e) {
                testResults.validJSON = false;
                testResults.errors.push(`Tool call ${idx} JSON inválido: ${e.message}`);
                log(`   ❌ JSON inválido: ${e.message}`, 'red');
              }
            });
          }

        } catch (e) {
          testResults.errors.push(`Parse error: ${e.message}`);
        }
      });

      rl.on('close', () => {
        log('\n' + '='.repeat(60), 'cyan');
        log('\n📊 RESULTADOS\n', 'cyan');
        log('='.repeat(60), 'cyan');

        log(`\n📝 Texto recebido: ${receivedText.length} caracteres em ${textChunks} chunks`, 'reset');
        log(`   Streaming real: ${testResults.textStreaming ? '✅ SIM' : '❌ NÃO'}`, 
          testResults.textStreaming ? 'green' : 'red');

        log(`\n🔧 Tool calls recebidas: ${receivedToolCalls.length}`, 'reset');
        log(`   Recebidas corretamente: ${testResults.toolCallsReceived ? '✅ SIM' : '❌ NÃO'}`, 
          testResults.toolCallsReceived ? 'green' : 'red');

        log(`\n📋 JSON válido: ${testResults.validJSON ? '✅ SIM' : '❌ NÃO'}`, 
          testResults.validJSON ? 'green' : 'red');

        log(`📋 Sem undefined: ${testResults.noUndefined ? '✅ SIM' : '❌ NÃO'}`, 
          testResults.noUndefined ? 'green' : 'red');

        log(`📋 Sem duplicação: ${testResults.noDuplication ? '✅ SIM' : '❌ NÃO'}`, 
          testResults.noDuplication ? 'green' : 'red');

        if (testResults.errors.length > 0) {
          log(`\n❌ Erros encontrados (${testResults.errors.length}):`, 'red');
          testResults.errors.forEach((err, idx) => {
            log(`   ${idx + 1}. ${err}`, 'red');
          });
        } else {
          log('\n✅ Nenhum erro encontrado!', 'green');
        }

        const allPassed = testResults.textStreaming && 
                         testResults.toolCallsReceived && 
                         testResults.validJSON && 
                         testResults.noUndefined && 
                         testResults.noDuplication;

        log(`\n${'='.repeat(60)}`, 'cyan');
        if (allPassed) {
          log('✅ TODOS OS TESTES PASSARAM!', 'green');
        } else {
          log('❌ ALGUNS TESTES FALHARAM', 'red');
        }
        log(`${'='.repeat(60)}\n`, 'cyan');

        resolve(testResults);
      });

      rl.on('error', (err) => {
        testResults.errors.push(`Stream error: ${err.message}`);
        reject(err);
      });
    });

    req.on('error', (err) => {
      testResults.errors.push(`Request error: ${err.message}`);
      log(`\n❌ Erro na requisição: ${err.message}\n`, 'red');
      reject(err);
    });

    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

async function checkProxy() {
  return new Promise((resolve) => {
    const url = new URL(PROXY_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: '/health',
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Main
async function main() {
  log('\n🚀 Teste de Streaming com Tool Calls\n', 'cyan');
  log(`Proxy: ${PROXY_URL}`, 'blue');
  log(`Model: ${MODEL}\n`, 'blue');

  log('⏳ Verificando se o proxy está rodando...', 'yellow');
  const isRunning = await checkProxy();

  if (!isRunning) {
    log('\n❌ Proxy não está respondendo!', 'red');
    log('   Certifique-se de que o servidor está rodando:', 'reset');
    log('   npm start', 'cyan');
    log('\n   Ou defina a URL do proxy:');
    log('   PROXY_URL=http://seu-proxy:3000 node scripts/test-streaming-tool-calls.js\n', 'cyan');
    process.exit(1);
  }

  log('✅ Proxy está rodando!\n', 'green');

  try {
    await testStreamingWithToolCalls();
    process.exit(0);
  } catch (err) {
    log(`\n❌ Erro durante o teste: ${err.message}\n`, 'red');
    process.exit(1);
  }
}

main();
