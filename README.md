# NVIDIA API Rotator

Sistema de rotação e balanceamento de APIs NVIDIA NIM com métricas detalhadas e otimizações de performance.

## Modelos Suportados

| Modelo | Context | Max Output | Thinking | Instant Mode | Vision |
|--------|---------|------------|----------|--------------|--------|
| `moonshotai/kimi-k2.6` ⭐ | 256K | 32K | ✅ | ✅ | ✅ |
| `deepseek-ai/deepseek-v4-pro` | 1M | 64K | ✅ | ✅ | ❌ |
| `z-ai/glm-5.1` | 512K | 128K | ✅ | ✅ | ❌ |
| `minimaxai/minimax-m2.7` | 256K | 128K | ✅ | ❌ | ❌ |
| `minimaxai/minimax-m3` | 1M | 128K | ✅ | ❌ | ✅ |

### Aliases Disponíveis

| Alias | Modelo Real |
|-------|-------------|
| `kimi`, `kimi-k2`, `kimi-k2.5`, `kimi-k2.6` | `moonshotai/kimi-k2.6` |
| `deepseek`, `deepseek-pro`, `ds-pro`, `deepseek-v4`, `deepseek-v4-pro` | `deepseek-ai/deepseek-v4-pro` |
| `glm`, `glm-5`, `glm-5.1`, `glm5`, `glm5.1` | `z-ai/glm-5.1` |
| `minimax`, `minimax-m2`, `minimax-m2.7`, `m2`, `m2.7`, `m27` | `minimaxai/minimax-m2.7` |
| `minimax-m3`, `minimax3`, `m3` | `minimaxai/minimax-m3` |
| `kimi-thinking`, `kimi-instruct` | `moonshotai/kimi-k2.6` |

### Validação Automática

O rotator valida e ajusta automaticamente os parâmetros:
- **max_tokens**: limitado ao máximo do modelo
- **temperature**: ajustado conforme limites do modelo (ex: fixo em 1.0 para thinking)
- **thinking parameters**: validados conforme o formato suportado pelo modelo

Warnings de validação são retornados nos headers da resposta (`X-Validation-Warnings`).

## Funcionalidades

- **Weighted Rotation**: Distribui requisições entre APIs saudáveis com pesos baseados em velocidade de resposta
- **Circuit Breaker**: Detecta falhas seguidas e suspende temporariamente chaves com problemas
- **Failover Automático**: Passa a requisição para a próxima chave saudável em caso de erro de rate limit ou rede
- **Métricas Detalhadas**: Tracking interno de tokens, tempos de resposta e uso de modelos
- **Health Check Monitor**: Monitoramento contínuo da integridade e velocidade das APIs
- **Compatível com OpenAI**: Substitui perfeitamente o endpoint oficial para os modelos suportados

## Otimizações de Performance

O sistema inclui várias otimizações para reduzir o tempo de resposta e maximizar o throughput:

1. **HTTP Keep-Alive & Connection Pooling**: Reutiliza conexões HTTP com Undici pools otimizados por API.
2. **Async Logging com Batch Optimizado**: Logs em batch com flush periódico para reduzir overhead de I/O em produção.
3. **Response Caching**: Cache para endpoints estáticos como `/models` com TTL de 60 segundos.
4. **Optimized Streaming**: Melhor throughput para respostas com streaming com tratamento inteligente de tool calls e tokens técnicos.
5. **DNS Cache Optimization**: Resolução DNS mais rápida e otimizada via `cacheable-lookup`.
6. **Timeout Otimizado**: Reduzido para detecção de falhas e failover rápidos.
7. **RotatorService Cache**: Cache de APIs saudáveis com TTL curto para evitar verificações desnecessárias de estado.
8. **Notification Pattern**: Invalidação de cache eficiente quando estado da API muda.

### Prioridade de Otimização

As otimizações estão priorizadas para reduzir o tempo de resposta da API NVIDIA:

- **Alta prioridade**: Connection pooling, timeout otimizado, rotator cache
- **Média prioridade**: Async logging otimizado, DNS cache
- **Baixa prioridade**: Documentação e configurações

## Configuração

### 1. Copie o arquivo de exemplo

```bash
cp .env.example .env
```

### 2. Configure suas APIs NVIDIA

No arquivo `.env`, adicione suas chaves:

```env
NVIDIA_API_KEY_1=nvapi-sua-chave-1
NVIDIA_API_KEY_2=nvapi-sua-chave-2
NVIDIA_API_KEY_3=nvapi-sua-chave-3
```

### 3. Configure o modelo padrão (opcional)

Define o modelo usado quando não especificado na requisição:

```env
DEFAULT_MODEL=moonshotai/kimi-k2.6
```

### 4. Configure segurança (opcional)

```env
PROXY_API_KEY=chave-para-clientes
```


## Endpoints

### Proxy (compatível com OpenAI)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/v1/chat/completions` | Chat completions |
| POST | `/v1/completions` | Completions |
| POST | `/v1/embeddings` | Embeddings |
| GET | `/v1/models` | Lista modelos |

## Exemplo de Requisição

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-proxy-key" \
  -d '{
    "model": "moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Métricas Disponíveis

- Total de requisições
- Tokens de entrada/saída
- Taxa de sucesso
- Tempo médio de resposta
- Uso por modelo

## Licença

MIT
