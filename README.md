# NVIDIA API Rotator

NVIDIA NIM API load balancing and rotation system with detailed metrics and performance optimizations.

## Supported Models

| Model | Context | Max Output | Thinking | Instant Mode | Vision |
|--------|---------|------------|----------|--------------|--------|
| `moonshotai/kimi-k2.6` ⭐ | 256K | 32K | ✅ | ✅ | ✅ |
| `deepseek-ai/deepseek-v4-pro` | 1M | 64K | ✅ | ✅ | ❌ |
| `z-ai/glm-5.1` | 512K | 128K | ✅ | ✅ | ❌ |
| `minimaxai/minimax-m2.7` | 256K | 128K | ✅ | ❌ | ❌ |
| `minimaxai/minimax-m3` | 1M | 128K | ✅ | ❌ | ✅ |

### Available Aliases

| Alias | Real Model |
|-------|-------------|
| `kimi`, `kimi-k2`, `kimi-k2.5`, `kimi-k2.6` | `moonshotai/kimi-k2.6` |
| `deepseek`, `deepseek-pro`, `ds-pro`, `deepseek-v4`, `deepseek-v4-pro` | `deepseek-ai/deepseek-v4-pro` |
| `glm`, `glm-5`, `glm-5.1`, `glm5`, `glm5.1` | `z-ai/glm-5.1` |
| `minimax`, `minimax-m2`, `minimax-m2.7`, `m2`, `m2.7`, `m27` | `minimaxai/minimax-m2.7` |
| `minimax-m3`, `minimax3`, `m3` | `minimaxai/minimax-m3` |
| `kimi-thinking`, `kimi-instruct` | `moonshotai/kimi-k2.6` |

### Automatic Validation

The rotator automatically validates and normalizes the following parameters:
- **max_tokens**: capped to the model's maximum limit.
- **temperature**: adjusted based on model constraints (e.g., fixed at 1.0 for thinking models).
- **thinking parameters**: validated according to the format supported by each specific model.

Validation warnings are returned in response headers (`X-Validation-Warnings`).

## Features

- **Weighted Rotation**: Distributes requests across healthy APIs with weights based on response speeds.
- **Circuit Breaker**: Detects consecutive failures and temporarily suspends keys with issues.
- **Automatic Failover**: Seamlessly routes the request to the next healthy key in case of rate-limiting (429) or network errors.
- **Detailed Metrics**: Tracks tokens, response times, and model usage internally.
- **Health Check Monitor**: Continuously monitors the health and latency of the configured APIs.
- **OpenAI Compatible**: Fully compatible with the official OpenAI API format for all supported models.

## Performance Optimizations

The system includes multiple optimizations to minimize response times and maximize throughput:

1. **HTTP Keep-Alive & Connection Pooling**: Reuses HTTP connections with Undici pools optimized per API.
2. **Async Logging with Batching**: Logs in batches with periodic flushes to minimize I/O overhead in production.
3. **Response Caching**: Caches static endpoints like `/models` with a 60-second TTL.
4. **Optimized Streaming**: Enhances throughput for streaming requests with smart handling of tool calls and technical tokens.
5. **DNS Cache Optimization**: Accelerates name resolution via `cacheable-lookup`.
6. **Optimized Timeout**: Low latency thresholds to ensure fast failure detection and failover.
7. **RotatorService Cache**: Caches healthy APIs list with a short TTL to prevent redundant status checks.
8. **Notification Pattern**: Invalidates API cache immediately when an API state changes.

### Optimization Priority

Optimizations are prioritized to reduce latency to the NVIDIA API:

- **High Priority**: Connection pooling, optimized timeout, rotator cache.
- **Medium Priority**: Optimized async logging, DNS cache.
- **Low Priority**: Documentation and configuration.

## Configuration

### 1. Copy the example file

```bash
cp .env.example .env
```

### 2. Configure your NVIDIA APIs

In your `.env` file, add your API keys:

```env
NVIDIA_API_KEY_1=nvapi-your-key-1
NVIDIA_API_KEY_2=nvapi-your-key-2
NVIDIA_API_KEY_3=nvapi-your-key-3
```

### 3. Configure the default model (optional)

Set the default model to use when not specified in the request:

```env
DEFAULT_MODEL=moonshotai/kimi-k2.6
```

### 4. Configure security (optional)

```env
PROXY_API_KEY=key-for-clients
```

## Endpoints

### Proxy (OpenAI-compatible)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/chat/completions` | Chat completions |
| POST | `/v1/completions` | Completions |
| POST | `/v1/embeddings` | Embeddings |
| GET | `/v1/models` | List models |

### System Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Rotator server metadata and configuration status |
| GET | `/health` | Health status and healthy APIs overview |

## Example Request

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-proxy-key" \
  -d '{
    "model": "moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Available Metrics

- Total request count
- Input/output tokens
- Success rate
- Average response time
- Usage per model

## License

MIT
