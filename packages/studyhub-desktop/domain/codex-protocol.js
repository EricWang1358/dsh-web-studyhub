// @ts-check

/** @typedef {import('./contracts.js').UsageBuckets} UsageBuckets */

export const CODEX_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

const READ_ONLY_GUARD = 'Do not run shell commands, do not call tools, do not read or write any files, and respond with the final answer directly.';

/**
 * Wrap system and user instructions into a single stdin prompt for `codex exec -`.
 * @param {string} system
 * @param {string} prompt
 * @returns {string}
 */
export function buildCodexWrappedPrompt(system, prompt) {
  const sys = String(system ?? '').trim();
  const user = String(prompt ?? '');
  const systemBlock = sys ? `${sys}\n${READ_ONLY_GUARD}` : READ_ONLY_GUARD;
  return `[System Instruction]\n${systemBlock}\n\n[User]\n${user}`;
}

/**
 * Build verified `codex exec` v0.170.0 read-only JSONL arguments with stdin prompt (`-`).
 * Never passes `--dangerously-bypass-approvals-and-sandbox` or write sandbox modes.
 * @param {{ model?: string, effort?: string, outputSchemaPath?: string }} [options]
 * @returns {string[]}
 */
export function buildCodexExecArgs(options = {}) {
  const args = [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
  ];
  const model = typeof options.model === 'string' ? options.model.trim() : '';
  if (model) args.push('-m', model);
  const effort = typeof options.effort === 'string' ? options.effort.trim() : '';
  if (effort && CODEX_EFFORT_LEVELS.includes(effort)) {
    args.push('-c', `model_reasoning_effort="${effort}"`);
  }
  const schemaPath = typeof options.outputSchemaPath === 'string' ? options.outputSchemaPath.trim() : '';
  if (schemaPath) args.push('--output-schema', schemaPath);
  args.push('-');
  return args;
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
 * @param {number} fallback
 * @returns {number}
 */
function optionalNumber(value, fallback) {
  return value === undefined || value === null ? fallback : Number(value);
}

/**
 * Map Codex `turn.completed.usage` into StudyHub's disjoint `token-usage.js` buckets without double counting.
 * OpenAI Responses API `input_tokens` includes `cached_input_tokens` (and `cache_write_input_tokens` when present),
 * and `output_tokens` already includes `reasoning_output_tokens`.
 * @param {unknown} raw
 * @returns {UsageBuckets | null}
 */
export function mapCodexUsageToBuckets(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = /** @type {Record<string, unknown>} */ (raw);
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  const cacheRead = optionalNumber(usage.cached_input_tokens, 0);
  const cacheWrite = optionalNumber(usage.cache_write_input_tokens, 0);
  const reasoning = optionalNumber(usage.reasoning_output_tokens, 0);

  if (![input, output, cacheRead, cacheWrite].every(isSafeCount)) return null;

  const cachedCombined = cacheRead + cacheWrite;
  const uncachedInput = cachedCombined > 0 && cachedCombined <= input ? input - cachedCombined : input;
  const reasoningField = isSafeCount(reasoning) ? { reasoningTokens: reasoning } : {};

  return {
    inputTokens: uncachedInput,
    uncachedInputTokens: uncachedInput,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...reasoningField,
  };
}

/**
 * @param {UsageBuckets | null} current
 * @param {UsageBuckets | null} next
 * @returns {UsageBuckets | null}
 */
function combineUsageBuckets(current, next) {
  if (!next) return current;
  if (!current) return next;
  const reasoning = (current.reasoningTokens || 0) + (next.reasoningTokens || 0);
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    uncachedInputTokens: current.uncachedInputTokens + next.uncachedInputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + next.cacheWriteTokens,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
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
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function extractTopLevelError(obj) {
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
  if (obj.error && typeof obj.error === 'object') {
    const nested = /** @type {Record<string, unknown>} */ (obj.error);
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim();
  }
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error.trim();
  return '';
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {{ kind: 'agent_message' | 'item_error' | 'other', text: string, errorMessage: string }}
 */
function parseCompletedItem(obj) {
  if (!obj.item || typeof obj.item !== 'object') {
    return { kind: 'other', text: '', errorMessage: '' };
  }
  const item = /** @type {Record<string, unknown>} */ (obj.item);
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return { kind: 'agent_message', text: item.text, errorMessage: '' };
  }
  if (item.type === 'error' && typeof item.message === 'string') {
    return { kind: 'item_error', text: '', errorMessage: item.message.trim() };
  }
  return { kind: 'other', text: '', errorMessage: '' };
}

/**
 * Parse a single JSONL line from `codex exec --json`.
 * @param {string} rawLine
 * @returns {{ type: string, threadId: string, text: string, usage: UsageBuckets | null, errorMessage: string, fatal: boolean } | null}
 */
export function parseCodexStreamLine(rawLine) {
  const obj = parseJsonObjectLine(rawLine);
  if (!obj) return null;
  const type = typeof obj.type === 'string' ? obj.type : '';
  if (type === 'thread.started') {
    const threadId = typeof obj.thread_id === 'string' ? obj.thread_id : '';
    return { type, threadId, text: '', usage: null, errorMessage: '', fatal: false };
  }
  if (type === 'item.completed') {
    const item = parseCompletedItem(obj);
    return { type, threadId: '', text: item.text, usage: null, errorMessage: item.errorMessage, fatal: false };
  }
  if (type === 'turn.completed') {
    return { type, threadId: '', text: '', usage: mapCodexUsageToBuckets(obj.usage), errorMessage: '', fatal: false };
  }
  if (type === 'turn.failed' || type === 'error') {
    return { type, threadId: '', text: '', usage: null, errorMessage: extractTopLevelError(obj), fatal: true };
  }
  return { type, threadId: '', text: '', usage: null, errorMessage: '', fatal: false };
}

/**
 * @param {string} message
 * @returns {Error & { modelFailure: boolean }}
 */
function codexFailure(message) {
  return Object.assign(new Error(message), { modelFailure: true });
}

/**
 * Extract the last error message from Codex JSONL output (useful when exit code !== 0).
 * @param {string} rawOutput
 * @returns {string}
 */
export function extractCodexJsonlError(rawOutput) {
  let fatal = '';
  let itemError = '';
  for (const line of String(rawOutput ?? '').split(/\r?\n/)) {
    const parsed = parseCodexStreamLine(line);
    if (!parsed || !parsed.errorMessage) continue;
    if (parsed.fatal) fatal = parsed.errorMessage;
    else itemError = parsed.errorMessage;
  }
  return fatal || itemError;
}

/**
 * Fold all JSONL events from `codex exec --json` stdout into a single state object.
 * @param {string} trimmed
 */
function collectCodexEvents(trimmed) {
  /** @type {string[]} */
  const messages = [];
  /** @type {string[]} */
  const itemErrors = [];
  let threadId = '';
  /** @type {UsageBuckets | null} */
  let usage = null;
  let fatalError = '';
  let sawEvent = false;

  for (const line of trimmed.split(/\r?\n/)) {
    const event = parseCodexStreamLine(line);
    if (!event) continue;
    sawEvent = true;
    if (event.threadId) threadId = event.threadId;
    if (event.text) messages.push(event.text);
    if (event.usage) usage = combineUsageBuckets(usage, event.usage);
    if (event.fatal && event.errorMessage) fatalError = event.errorMessage;
    else if (event.errorMessage) itemErrors.push(event.errorMessage);
  }
  return { messages, itemErrors, threadId, usage, fatalError, sawEvent };
}

/**
 * @param {string} zh
 * @param {string} en
 * @param {boolean} isEn
 * @returns {Error & { modelFailure: boolean }}
 */
function localizedCodexFailure(zh, en, isEn) {
  return codexFailure(isEn ? en : zh);
}

/**
 * Parse complete JSONL stdout from `codex exec --json`.
 * Ignores non-fatal `item.type === 'error'` warnings when `agent_message` succeeded.
 * @param {string} rawOutput
 * @param {{ language?: 'zh' | 'en' }} [options]
 * @returns {{ text: string, usage: UsageBuckets | null, threadId: string }}
 */
export function parseCodexJsonlOutput(rawOutput, options = {}) {
  const isEn = options.language === 'en';
  const trimmed = String(rawOutput ?? '').trim();
  if (!trimmed) {
    throw localizedCodexFailure('Codex CLI 没有返回输出', 'Codex CLI returned no output', isEn);
  }
  const state = collectCodexEvents(trimmed);
  if (state.fatalError) {
    throw localizedCodexFailure(`Codex CLI 执行失败：${state.fatalError}`, `Codex CLI failed: ${state.fatalError}`, isEn);
  }
  const text = state.messages.join('\n');
  if (text.trim()) {
    return { text, usage: state.usage, threadId: state.threadId };
  }
  const lastItemErr = state.itemErrors[state.itemErrors.length - 1];
  if (lastItemErr) {
    throw localizedCodexFailure(`Codex CLI 执行失败：${lastItemErr}`, `Codex CLI failed: ${lastItemErr}`, isEn);
  }
  if (!state.sawEvent) {
    throw localizedCodexFailure('无法解析 Codex CLI 输出', 'Could not parse Codex CLI output', isEn);
  }
  throw localizedCodexFailure('Codex CLI 没有返回文字', 'Codex CLI returned no text', isEn);
}
