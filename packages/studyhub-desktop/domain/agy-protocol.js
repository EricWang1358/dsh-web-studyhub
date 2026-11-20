// @ts-check

/** @typedef {import('./contracts.js').CliModelInfo} CliModelInfo */
/** @typedef {import('./contracts.js').UsageBuckets} UsageBuckets */

export const AGY_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const READ_ONLY_GUARD = 'Do not call any tools, do not read or write any files, and respond with the final answer directly.';

/**
 * Wrap system and user instructions into a single prompt for `agy` (which has no --system-prompt or --disable-tools).
 * @param {string} system
 * @param {string} prompt
 * @returns {string}
 */
export function buildAgyWrappedPrompt(system, prompt) {
  const sys = String(system ?? '').trim();
  const user = String(prompt ?? '');
  const systemBlock = sys ? `${sys}\n${READ_ONLY_GUARD}` : READ_ONLY_GUARD;
  return `[System Instruction]\n${systemBlock}\n\n[User]\n${user}`;
}

/**
 * Build verified `agy` stream-json CLI arguments (eliminates Windows 32KB argv limit).
 * Never passes `--dangerously-skip-permissions`.
 * @param {{ timeoutMs?: number, model?: string, effort?: string, jsonSchema?: string }} [options]
 * @returns {string[]}
 */
export function buildAgyStreamArgs(options = {}) {
  const rawTimeout = options.timeoutMs;
  const printTimeout = rawTimeout === 0
    ? '0s'
    : `${Math.max(5, Math.ceil((Number(rawTimeout) || 600_000) / 1000))}s`;
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--print-timeout', printTimeout,
  ];
  const model = typeof options.model === 'string' ? options.model.trim() : '';
  if (model) args.push('--model', model);
  const effort = typeof options.effort === 'string' ? options.effort.trim() : '';
  if (effort && AGY_EFFORT_LEVELS.includes(effort)) args.push('--effort', effort);
  const schema = typeof options.jsonSchema === 'string' ? options.jsonSchema.trim() : '';
  if (schema) args.push('--json-schema', schema);
  return args;
}

/**
 * Serialize a single NDJSON user message line for `agy --input-format stream-json`.
 * @param {string} content
 * @returns {string}
 */
export function buildAgyUserMessageLine(content) {
  return `${JSON.stringify({ event: 'user', message: { content: String(content ?? '') } })}\n`;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function optionalNumber(value, fallback) {
  return value === undefined ? fallback : Number(value);
}

/**
 * Map `agy` usage `{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }`
 * into StudyHub's `token-usage.js` disjoint buckets without double-counting `thinking_tokens`.
 * @param {unknown} raw
 * @returns {UsageBuckets | null}
 */
export function mapAgyUsageToBuckets(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = /** @type {Record<string, unknown>} */ (raw);
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  const cacheRead = optionalNumber(usage.cache_read_tokens, 0);
  const thinking = optionalNumber(usage.thinking_tokens, 0);
  const total = optionalNumber(usage.total_tokens, input + output);

  if (![input, output, cacheRead].every(isSafeCount)) return null;

  const cacheIncludedInInput = cacheRead > 0 && cacheRead <= input && total === input + output;
  const uncachedInput = cacheIncludedInInput ? input - cacheRead : input;
  const reasoning = isSafeCount(thinking) ? { reasoningTokens: thinking } : {};

  return {
    inputTokens: uncachedInput,
    uncachedInputTokens: uncachedInput,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    ...reasoning,
  };
}

/**
 * @param {string} message
 * @returns {Error & { modelFailure: boolean }}
 */
function agyFailure(message) {
  return Object.assign(new Error(message), { modelFailure: true });
}

/**
 * @param {Record<string, unknown>} data
 */
function assertAgySuccessStatus(data) {
  const status = String(data.status || '').toUpperCase();
  if (status === 'ERROR') {
    const rawErr = typeof data.error === 'string' ? data.error.trim() : '';
    throw agyFailure(`Antigravity CLI 执行失败：${rawErr || '未知错误'}`);
  }
  if (status !== 'SUCCESS') {
    throw agyFailure(`Antigravity CLI 返回了未知状态：${status || '空'}`);
  }
}

/**
 * Parse a single `agy` JSON result object (shared by `--output-format json` and `stream-json` `result` event).
 * @param {unknown} payload
 * @returns {{ text: string, usage: UsageBuckets | null, conversationId: string, durationSeconds: number | null }}
 */
export function parseAgyJsonResult(payload) {
  if (!payload || typeof payload !== 'object') {
    throw agyFailure('Antigravity CLI 返回了无效的 JSON 结果');
  }
  const data = /** @type {Record<string, unknown>} */ (payload);
  assertAgySuccessStatus(data);
  const text = typeof data.response === 'string' ? data.response : '';
  if (!text.trim()) throw agyFailure('Antigravity CLI 没有返回文字');
  const durationSeconds = typeof data.duration_seconds === 'number' && Number.isFinite(data.duration_seconds)
    ? data.duration_seconds
    : null;
  return {
    text,
    usage: mapAgyUsageToBuckets(data.usage),
    conversationId: typeof data.conversation_id === 'string' ? data.conversation_id : '',
    durationSeconds,
  };
}

/**
 * @param {string} rawLine
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObjectLine(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (!line.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Parse a single NDJSON line from `agy --output-format stream-json`.
 * @param {string} rawLine
 * @returns {{ event: string, textDelta: string, result: Record<string, unknown> | null, usage: UsageBuckets | null } | null}
 */
export function parseAgyStreamLine(rawLine) {
  const obj = parseJsonObjectLine(rawLine);
  if (!obj) return null;
  const event = typeof obj.event === 'string' ? obj.event : '';
  if (event === 'result' && obj.result && typeof obj.result === 'object') {
    return { event, textDelta: '', result: /** @type {Record<string, unknown>} */ (obj.result), usage: null };
  }
  if (event === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
    const update = /** @type {Record<string, unknown>} */ (obj.step_update);
    const isAgentText = update.step_type === 'agent_response' && typeof update.text_delta === 'string';
    return {
      event,
      textDelta: isAgentText ? /** @type {string} */ (update.text_delta) : '',
      result: null,
      usage: mapAgyUsageToBuckets(update.usage),
    };
  }
  return { event, textDelta: '', result: null, usage: null };
}

/**
 * Try parsing stdout as a single `--output-format json` payload.
 * @param {string} trimmed
 * @returns {{ text: string, usage: UsageBuckets | null, conversationId: string, durationSeconds: number | null } | null}
 */
function tryParseSingleAgyJson(trimmed) {
  try {
    const single = JSON.parse(trimmed);
    if (single && typeof single === 'object' && 'status' in single) {
      return parseAgyJsonResult(single);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse complete stdout from either `stream-json` (NDJSON) or single `--output-format json`.
 * @param {string} rawOutput
 * @returns {{ text: string, usage: UsageBuckets | null, conversationId: string, durationSeconds: number | null }}
 */
export function parseAgyStreamOutput(rawOutput) {
  const trimmed = String(rawOutput ?? '').trim();
  if (!trimmed) throw agyFailure('Antigravity CLI 没有返回输出');

  let lastResult = null;
  let lastUsage = null;
  const deltas = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const item = parseAgyStreamLine(line);
    if (!item) continue;
    if (item.result) lastResult = item.result;
    if (item.textDelta) deltas.push(item.textDelta);
    if (item.usage) lastUsage = item.usage;
  }

  if (lastResult) return parseAgyJsonResult(lastResult);
  const single = tryParseSingleAgyJson(trimmed);
  if (single) return single;

  const joined = deltas.join('');
  if (joined.trim()) {
    return { text: joined, usage: lastUsage, conversationId: '', durationSeconds: null };
  }
  throw agyFailure('无法解析 Antigravity CLI 输出');
}

/**
 * Parse `agy models` stdout TSV lines (`<model-id>\t<Display Name>`).
 * @param {string} stdout
 * @returns {CliModelInfo[]}
 */
export function parseAgyModelsOutput(stdout) {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t').map((part) => part.trim()).filter(Boolean);
    const id = parts[0] || '';
    if (!id || seen.has(id) || /\s/.test(id)) continue;
    seen.add(id);
    models.push({ id, name: parts[1] || id });
  }
  return models;
}
