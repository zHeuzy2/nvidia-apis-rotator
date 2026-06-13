

const logger = require('./asyncLogger');

// Function name capture group allows dots, colons, and digits for refs like "functions.read:5"
// The name is cleaned up later (lines 144-147 strip "functions." prefix and ":N" suffix)

const KIMI_TOOL_PATTERN = /\|tool_call_begin\|\s*([a-zA-Z_][a-zA-Z0-9_.:-]*)\s*\|tool_call_argument_begin\|(\{[\s\S]*?\})/gs;

const KIMI_TOOL_PATTERN_FLEXIBLE = /\|tool_call_begin\|\s*([a-zA-Z_][a-zA-Z0-9_.:-]*)\s*\|tool_call_argument_begin\|(\{[\s\S]*?\})/gs;

const KIMI_TOOL_PATTERN_SIMPLE = /tool_call_begin\s+([a-zA-Z_][a-zA-Z0-9_.:-]*)[\s\S]*?(\{[\s\S]*?\})/gs;

const KIMI_TOOL_PATTERN_TAGGED_JSON = /<\|tool_call_begin\|>(\{[\s\S]*?\})<\|tool_call_end\|>/gs;
const KIMI_SECTION_END_PATTERN = /<?!?\|tool_calls_section_end\|>/g;
const KIMI_ANY_TOKEN_PATTERN = /<?!?\|[^|]+\|>/g;

function extractValidJSON(str) {
  if (!str || typeof str !== 'string') return null;
  
  const trimmed = str.trim();
  
  if (trimmed.length === 0) return null;
  
  // Tenta o string completo primeiro
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    
  }
  
  
  
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar !== '}') {
    // JSON incompleto - ainda recebendo fragments
    return null;
  }
  
  
  
  let lastValid = null;
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escapeNext = false;
  
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"' && !inString) {
      inString = true;
      continue;
    }
    
    if (char === '"' && inString) {
      inString = false;
      continue;
    }
    
    if (inString) continue;
    
    
    if (char === '{') {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        const candidate = trimmed.substring(startIdx, i + 1);
        try {
          lastValid = JSON.parse(candidate);
        } catch (e) {
          
        }
      }
    }
  }
  
  return lastValid;
}

function repairTruncatedJSON(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return null;

  const str = jsonStr.trim();

  
  if (str.length < 2) return null;

  
  try {
    return JSON.parse(str);
  } catch (e) {
    // Continua
  }

  // Abordagem simplificada (fallback regex):
  // Extrai todos os pares chave-valor completos
  const pairs = {};
  let found = false;

  // 1. Encontra strings: "chave": "valor"
  const stringRegex = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = stringRegex.exec(str)) !== null) {
    try {
      // Usa JSON.parse pra resolver escapes corretamente
      pairs[match[1]] = JSON.parse(`"${match[2]}"`);
      found = true;
    } catch(e) {
      pairs[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      found = true;
    }
  }

  // 2. Encontra primitivos: "chave": true|false|null|numero
  const primitiveRegex = /"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[,} \n\r]|$)/g;
  while ((match = primitiveRegex.exec(str)) !== null) {
    const key = match[1];
    const valStr = match[2];
    let val;
    if (valStr === 'true') val = true;
    else if (valStr === 'false') val = false;
    else if (valStr === 'null') val = null;
    else val = Number(valStr);
    
    pairs[key] = val;
    found = true;
  }

  return found ? pairs : null;
}

function parseKimiToolCalls(content) {
  // DEBUG: Log first 200 chars of content to see what we're parsing
  logger.debug(`[KimiParser] Input content (first 200): ${content?.substring?.(0, 200) || content}`);

  if (!content || typeof content !== 'string') return [];

  const toolCalls = [];
  const patterns = [
    { regex: KIMI_TOOL_PATTERN, name: 'strict' },
    { regex: KIMI_TOOL_PATTERN_FLEXIBLE, name: 'flexible' },
    { regex: KIMI_TOOL_PATTERN_SIMPLE, name: 'simple' },
    { regex: KIMI_TOOL_PATTERN_TAGGED_JSON, name: 'tagged_json' }
  ];

  for (const { regex, name } of patterns) {
    regex.lastIndex = 0;
    let match;

    while ((match = regex.exec(content)) !== null) {
      let functionRef, argsJson;

      if (name === 'tagged_json') {
        // Formato Kimi K2.6: <|tool_call_begin|>{"name":"func","arguments":{...}}<|tool_call_end|>
        
        try {
          const parsed = JSON.parse(match[1]);
          functionRef = parsed.name;
          argsJson = typeof parsed.arguments === 'object' ? JSON.stringify(parsed.arguments) : String(parsed.arguments || '{}');
        } catch (e) {
          logger.debug(`[KimiParser] tagged_json pattern: JSON parse failed: ${e.message}`);
          continue;
        }
      } else {
        functionRef = match[1];
        argsJson = match[2];
      }

      
const funcName = functionRef
    .replace(/^functions\./, '')
    .replace(/:\d+$/, '')
    .trim();

  logger.debug(`[KimiParser] Regex match - funcName: "${funcName}", argsJson (first 100): "${argsJson?.substring?.(0, 100)}"`);

  
      if (!funcName || funcName.length === 0) {
        logger.debug(`[KimiParser] Skip: empty function name (pattern: ${name})`);
        continue;
      }

try {
  
  const parsedArgs = JSON.parse(argsJson);
  logger.debug(`[KimiParser] Extracted: ${funcName} with args: ${argsJson.substring(0, 50)}...`);

  toolCalls.push({
          name: funcName,
          arguments: JSON.stringify(parsedArgs),
          raw: argsJson
        });
} catch (e) {
  
  logger.debug(`[KimiParser] JSON parse failed for ${funcName}, raw: ${argsJson.substring(0, 50)}...`);
  const fallbackResult = tryExtractJsonFromText(argsJson);
  if (fallbackResult) {
    toolCalls.push({
      name: funcName,
      arguments: JSON.stringify(fallbackResult),
      raw: argsJson,
      fallback: true
    });
    logger.info(`[KimiParser] Fallback extraction for ${funcName} (pattern: ${name})`);
  } else {
    logger.warn(`[KimiParser] JSON inválido na tool call ${funcName} (${argsJson.length} chars, pattern: ${name})`);
  }
}
    }

    
    if (toolCalls.length > 0) {
      logger.debug(`[KimiParser] Found ${toolCalls.length} tool calls with pattern: ${name}`);
      break;
    }
  }

  
  if (toolCalls.length === 0) {
    const fallbackCalls = tryFallbackToolCallExtraction(content);
    if (fallbackCalls.length > 0) {
      logger.info(`[KimiParser] Fallback extraction found ${fallbackCalls.length} tool calls`);
      return fallbackCalls;
    }
  }

  return toolCalls;
}

function tryExtractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Continua...
  }

  
  const jsonMatch = trimmed.match(/\{[^{}]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continua...
    }
  }

  return null;
}

function tryFallbackToolCallExtraction(content) {
 const toolCalls = [];

 
 

 
 const jsonObjectPattern = /\{[^}]*"name"[^}]*\}/g;
 let match;

 while ((match = jsonObjectPattern.exec(content)) !== null) {
 try {
 
 let parsed;
 try {
 parsed = JSON.parse(match[0]);
 } catch (parseErr) {
 
 const partialMatch = match[0].match(/"name"\s*:\s*"([^"]+)"/);
 if (partialMatch) {
 const toolName = partialMatch[1];
 
 const argsMatch = match[0].match(/"arguments"\s*:\s*(\{[^}]*\})/);
 let args = {};
 if (argsMatch) {
 try { args = JSON.parse(argsMatch[1]); } catch (e) { /* ignore */ }
 }
 toolCalls.push({
 name: toolName,
 arguments: JSON.stringify(args),
 raw: match[0],
 fallback: true,
 partial: true
 });
 continue;
 }
 }

 
 let toolName = parsed.name || parsed.function?.name;

 if (!toolName || typeof toolName !== 'string') continue;

 // Extrai argumentos
 let args = parsed.arguments || parsed.function?.arguments || {};

 if (typeof args === 'string') {
 try {
 args = JSON.parse(args);
 } catch (e) {
 
 const extracted = tryExtractJsonFromText(args);
 if (extracted) {
 args = extracted;
 } else {
 continue;
 }
 }
 }

 toolCalls.push({
 name: toolName,
 arguments: JSON.stringify(args),
 raw: match[0],
 fallback: true
 });
 } catch (e) {
 logger.debug(`[KimiParser] Fallback parse falhou: ${e.message}`);
 }
 }

 
 if (toolCalls.length === 0) {
 const nameValuePattern = /"name"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g;
 while ((match = nameValuePattern.exec(content)) !== null) {
 const toolName = match[1];
 
 const searchStart = match.index;
 const searchEnd = Math.min(match.index + 200, content.length);
 const nearbyContent = content.substring(searchStart, searchEnd);

 
 const argsMatch = nearbyContent.match(/(\{[^{}]*\})/);
 let args = {};
 if (argsMatch) {
 try { args = JSON.parse(argsMatch[1]); } catch (e) { /* ignore - keep empty */ }
 }

 if (toolName) {
 toolCalls.push({
 name: toolName,
 arguments: JSON.stringify(args),
 raw: nearbyContent.substring(0, 50),
 fallback: true,
 aggressive: true
 });
 }
 }
 }

 return toolCalls;
}

function hasKimiToolCalls(content) {
  if (!content || typeof content !== 'string') return false;

  
  
  const hasToken = content.includes('<!|tool_call_begin') ||
                   content.includes('<|tool_call_begin') ||
                   content.includes('tool_call_begin') ||
                   content.includes('tool_call_argument');

  if (!hasToken) return false;

  
  const patterns = [
    KIMI_TOOL_PATTERN,
    KIMI_TOOL_PATTERN_FLEXIBLE,
    KIMI_TOOL_PATTERN_SIMPLE,
    KIMI_TOOL_PATTERN_TAGGED_JSON
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return true;
  }

  return false;
}

function removeKimiTokens(content) {
  if (!content || typeof content !== 'string') return content;

  // FAST EXIT: If content has none of the marker substrings, return immediately
  // This avoids running 6+ regex replacements on the vast majority of chunks
  if (!content.includes('tool_call_begin') &&
      !content.includes('tool_call_end') &&
      !content.includes('tool_call_argument') &&
      !content.includes('tool_calls_section')) {
    return content;
  }

  let result = content;

  
  const patterns = [
    KIMI_TOOL_PATTERN,
    KIMI_TOOL_PATTERN_FLEXIBLE,
    KIMI_TOOL_PATTERN_SIMPLE,
    KIMI_TOOL_PATTERN_TAGGED_JSON
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '');
  }

  // Remove section end
  result = result.replace(KIMI_SECTION_END_PATTERN, '');

  
  result = result.replace(KIMI_ANY_TOKEN_PATTERN, '');

  
  result = result.replace(/\btool_call_begin\b/g, '');
  result = result.replace(/\btool_call_argument_begin\b/g, '');
  result = result.replace(/\btool_call_end\b/g, '');

  
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

function logToolCall(toolName, status, size, error = null) {
  const baseMsg = `[ToolCall] [${toolName}] ${status}`;
  
  if (error) {
    logger.warn(`${baseMsg} (${size} chars) - Erro: ${error}`);
  } else {
    logger.debug(`${baseMsg} (${size} chars)`);
  }
}

function convertResponseToSSE(completionResponse) {
  const events = [];
  const choice = completionResponse.choices?.[0];
  
  if (!choice) return events;
  
  const message = choice.message;
  const baseChunk = {
    id: String(completionResponse.id),
    object: 'chat.completion.chunk',
    created: Number(completionResponse.created),
    model: String(completionResponse.model),
  };

  
  let cleanContent = message.content;
  let kimiToolCalls = [];
  
  if (cleanContent && hasKimiToolCalls(cleanContent)) {
    kimiToolCalls = parseKimiToolCalls(cleanContent);
    cleanContent = removeKimiTokens(cleanContent);
    
    if (kimiToolCalls.length > 0) {
      logger.info(`[KimiParser] Detectadas ${kimiToolCalls.length} tool calls no content`);
    }
  }

  
  if (cleanContent) {
    
    events.push({
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: { 
            role: 'assistant',
            content: cleanContent 
          },
          finish_reason: null,
        },
      ],
    });
  }

  
  const allToolCalls = [
    ...(message.tool_calls || []),
  ...kimiToolCalls.map((tc, idx) => ({
    index: (message.tool_calls?.length || 0) + idx,
    id: String(tc?.id || `call_kimi_${idx}_${Date.now()}`),
    type: 'function',
      function: {
name: tc.name || 'unknown_tool',
        arguments: tc.arguments,
      },
    }))
  ];

  
  if (allToolCalls.length > 0) {
    events.push({
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            role: !cleanContent ? 'assistant' : undefined,
            tool_calls: allToolCalls.map((tc, idx) => ({
              index: tc.index !== undefined ? tc.index : idx,
              id: String(tc?.id || `call_${idx}_${Date.now()}`),
              type: 'function',
              function: {
name: tc.function?.name || 'unknown_tool',
                arguments: tc.function.arguments,
              },
            })),
          },
          finish_reason: null,
        },
      ],
    });
  }

  
  events.push({
    ...baseChunk,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: allToolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
  });

  return events;
}

function fixToolCalls(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return [];

  return toolCalls
    .map((tc) => {
      if (!tc || !tc.function) return null;

      const toolName = tc.function.name || 'unknown';

      
      if (typeof tc.function.arguments === 'object' && tc.function.arguments !== null) {
        tc.function.arguments = JSON.stringify(tc.function.arguments);
      }

      
      if (tc.function.arguments == null) {
        tc.function.arguments = '{}';
      }

      // Empty string → empty object
      if (tc.function.arguments.trim() === '') {
        tc.function.arguments = '{}';
      }

      
      const trimmed = tc.function.arguments.trim();
      const lastChar = trimmed[trimmed.length - 1];
      
      if (lastChar !== '}' && trimmed !== '{}') {
        // JSON incompleto - ignora silenciosamente
        return null;
      }

      
      const parsedArgs = extractValidJSON(tc.function.arguments);
      
      if (!parsedArgs && trimmed !== '{}') {
        logToolCall(toolName, 'JSON inválido', tc.function.arguments.length, 'formato incorreto');
        return null;
      }

      // Serialize directly — don't filter valid values
      tc.function.arguments = parsedArgs ? JSON.stringify(parsedArgs) : '{}';
      logToolCall(toolName, 'válida', tc.function.arguments.length);

      return tc;
    })
    .filter(Boolean);
}

class ToolCallBuffer {
  constructor() {
    this.buffers = new Map(); // Key: toolIndex -> { id, name, arguments }
    this.baseChunk = null;
    
    // split across multiple streaming chunks
    this.kimiContentBuffer = '';
    this.kimiContentBuffering = false;
  }

  
  accumulate(delta) {
    if (!delta?.tool_calls || !Array.isArray(delta.tool_calls)) {
      return false;
    }

    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      if (!this.buffers.has(idx)) {
        // New buffer entry for this index
        const initialArgs = (typeof tc.function?.arguments === 'string')
          ? tc.function.arguments
          : '';

        this.buffers.set(idx, {
          id: String(tc?.id || `call_${idx}_${Date.now()}`).trim(),
          type: (tc.type && typeof tc.type === 'string') ? tc.type : 'function',
          function: {
            name: String(tc.function?.name || ''),
            arguments: initialArgs,
          },
        });
      } else {
        // Update existing buffer entry — ALWAYS concatenate args.
        // Same index = same logical tool call, even if the ID changes mid-stream
        // (e.g. MiniMax M2.5 sends continuation fragments with a different ID).
        const buf = this.buffers.get(idx);

        if (tc.id != null && String(tc.id).trim() !== '') {
          buf.id = String(tc.id).trim();
        }
        if (tc.function?.name && tc.function.name !== '') {
          buf.function.name = tc.function.name;
        }
        buf.function.arguments += tc.function?.arguments || '';
        if (tc.type != null && typeof tc.type === 'string' && tc.type !== '') {
          buf.type = tc.type;
        }
      }
    }

    return true;
  }

  
  bufferKimiContent(content) {
    if (!content || typeof content !== 'string') {
      return { cleanContent: content, foundToolCalls: false };
    }

    
    // skip all marker detection (covers 95%+ of chunks)
    if (!this.kimiContentBuffering &&
        !content.includes('|') &&
        !content.includes('tool_call') &&
        !content.includes('tool_calls')) {
      return { cleanContent: content, foundToolCalls: false };
    }

    // Markers that indicate tool call regions
    const TOOL_CALL_START_MARKERS = ['tool_call_begin', '|tool_call'];
    const TOOL_CALL_END_MARKERS = ['tool_call_end', 'tool_calls_section_end'];

    // Check if this content starts or continues a tool call region
    const hasStartMarker = TOOL_CALL_START_MARKERS.some(m => content.includes(m));
    const hasEndMarker = TOOL_CALL_END_MARKERS.some(m => content.includes(m));

    // Check for partial markers at the end of content (token split across chunks)
    // e.g., content ends with "<|tool" or "tool_call_be" or "<!|tool_call_beg"
    const PARTIAL_MARKER_HINTS = ['<|tool', '<!|tool', 'tool_call', '<|', '<!|'];
    const mayHavePartialMarker = !this.kimiContentBuffering &&
      PARTIAL_MARKER_HINTS.some(hint => {
        // Check if content ends with a prefix of the hint or the hint is a suffix of content
        for (let len = 1; len <= hint.length; len++) {
          if (content.endsWith(hint.substring(0, len))) return true;
        }
        return false;
      });

    if (this.kimiContentBuffering) {
      // We're already buffering — append this chunk
      this.kimiContentBuffer += content;

      if (hasEndMarker) {
        // End of tool call region — parse what we have
        this.kimiContentBuffering = false;
        const buffered = this.kimiContentBuffer;
        this.kimiContentBuffer = '';

        // Parse tool calls from buffered content
        const toolCalls = parseKimiToolCalls(buffered);
        if (toolCalls.length > 0) {
          this.accumulateKimiToolCalls(toolCalls);
          
          const clean = removeKimiTokens(buffered);
          return { cleanContent: clean, foundToolCalls: true };
        }

        
        const clean = removeKimiTokens(buffered);
        return { cleanContent: clean, foundToolCalls: false };
      }

      // Still buffering — don't emit anything yet
      return { cleanContent: '', foundToolCalls: false };
    }

    // Not currently buffering
    if (hasStartMarker) {
      if (hasEndMarker) {
        // Complete tool call in a single chunk — parse directly
        const toolCalls = parseKimiToolCalls(content);
        if (toolCalls.length > 0) {
          this.accumulateKimiToolCalls(toolCalls);
          const clean = removeKimiTokens(content);
          return { cleanContent: clean, foundToolCalls: true };
        }
      }

      
      this.kimiContentBuffering = true;
      this.kimiContentBuffer = content;
      return { cleanContent: '', foundToolCalls: false };
    }

    
    // But check for partial markers that might indicate a split
    if (mayHavePartialMarker) {
      // Content might end with the start of a tool call token
      // Don't buffer yet — wait for next chunk to confirm
      // This avoids false positives on normal content containing "<|" etc.
    }

    return { cleanContent: content, foundToolCalls: false };
  }

  /**
   * Flush any remaining buffered Kimi content (called at stream end)
   * @returns {{ cleanContent: string, foundToolCalls: boolean }}
   */
  flushKimiBuffer() {
    if (!this.kimiContentBuffer) {
      return { cleanContent: '', foundToolCalls: false };
    }

    const buffered = this.kimiContentBuffer;
    this.kimiContentBuffer = '';
    this.kimiContentBuffering = false;

    // Try to parse any tool calls from the remaining buffer
    const toolCalls = parseKimiToolCalls(buffered);
    if (toolCalls.length > 0) {
      this.accumulateKimiToolCalls(toolCalls);
      const clean = removeKimiTokens(buffered);
      return { cleanContent: clean, foundToolCalls: true };
    }

    
    const clean = removeKimiTokens(buffered);
    return { cleanContent: clean, foundToolCalls: false };
  }

  
  accumulateKimiToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;

    for (const tc of toolCalls) {
      const idx = this.buffers.size;
      
      this.buffers.set(idx, {
        id: String(`call_kimi_${idx}_${Date.now()}`),
        type: 'function',
        function: {
          name: String(tc.name || ''),
          arguments: tc.arguments || '{}',
        },
      });
    }
  }

  
  getCompleteToolCalls() {
    const toolCalls = [];

    for (const [idx, buf] of this.buffers) {
      const toolName = buf.function.name || 'unknown';
      const argsStr = buf.function.arguments || '';
      const argsSize = argsStr.length;

      
      if (!buf.function.name || buf.function.name === '') {
        logToolCall(toolName, 'inválida (sem nome)', 0);
        continue;
      }

      
      if (argsSize === 0) {
        logToolCall(toolName, 'sem args (aceito vazio)', 0);
        toolCalls.push({
          index: idx,
          id: String(buf.id || `call_${idx}_${Date.now()}`),
          type: String(buf.type || 'function'),
          function: {
            name: String(buf.function.name),
            arguments: '{}',
          },
        });
        continue;
      }

      // Try to parse accumulated arguments
      const trimmed = argsStr.trim();
      let parsedArgs = null;

      // First try: direct JSON.parse (most common, most efficient)
      try {
        parsedArgs = JSON.parse(trimmed);
      } catch (e) {
        // Fall through to extractValidJSON for concatenated/malformed JSON
      }

      // Second try: extractValidJSON handles concatenated JSON objects
      if (!parsedArgs) {
        parsedArgs = extractValidJSON(trimmed);
      }

      // Third try: repairTruncatedJSON — salvage partial args from truncated stream
      if (!parsedArgs) {
        const repaired = repairTruncatedJSON(trimmed);
        if (repaired) {
          const repairedKeys = Object.keys(repaired);
          logger.warn(`[ToolCall] [${toolName}] JSON reparado (${argsSize} chars) - ${repairedKeys.length} params salvos: [${repairedKeys.join(', ')}]`);
          parsedArgs = repaired;
        }
      }

      if (!parsedArgs) {
        // Could not parse arguments at all — even repair failed
        logToolCall(toolName, 'JSON inválido', argsSize, 'parse failed');
        // Still emit with empty args rather than dropping the tool call
        // The client may be able to handle or retry
        toolCalls.push({
          index: idx,
          id: String(buf.id || `call_${idx}_${Date.now()}`),
          type: String(buf.type || 'function'),
          function: {
            name: String(buf.function.name),
            arguments: '{}',
          },
        });
        continue;
      }

      
      // The old code filtered ALL undefined/null values from the parsed args object.
      
      // of JSON.parse — JSON.parse never produces undefined values.
      // The issue was that re-serializing after filtering could lose structure.
      //
      // Instead, serialize the parsed args directly back to JSON.
      // JSON.stringify naturally excludes undefined values and preserves null, arrays, etc.
      const argsJson = JSON.stringify(parsedArgs);

      toolCalls.push({
        index: idx,
        id: String(buf.id || `call_${idx}_${Date.now()}`),
        type: String(buf.type || 'function'),
        function: {
          name: String(buf.function.name),
          arguments: argsJson,
        },
      });

      logToolCall(toolName, 'completa', argsJson.length);
    }

    return toolCalls;
  }

  /**
   * Limpa todos os buffers
   */
  clear() {
    this.buffers.clear();
    this.baseChunk = null;
    this.kimiContentBuffer = '';
    this.kimiContentBuffering = false;
  }

  
  hasPending() {
    return this.buffers.size > 0;
  }

  
  getStats() {
    return {
      count: this.buffers.size,
      names: Array.from(this.buffers.values()).map(b => b.function.name).filter(Boolean),
    };
  }
}

/**
 * Formata um evento SSE
 */
function formatSSE(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Envia [DONE] marker SSE
 */
function formatDone() {
  return 'data: [DONE]\n\n';
}

module.exports = {
  extractValidJSON,
  repairTruncatedJSON,
  parseKimiToolCalls,
  hasKimiToolCalls,
  removeKimiTokens,
  logToolCall,
  convertResponseToSSE,
  fixToolCalls,
  ToolCallBuffer,
  formatSSE,
  formatDone,
};
