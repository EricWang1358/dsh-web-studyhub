import { hostService } from '../host-service.js';
import { retrievalPort } from '../retrieval-host.js';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  MIN_WAIT_SECONDS,
  readWebGeminiSettings,
  readWebGeminiSettingsSync,
  saveWebGeminiSettings,
} from './web-gemini-settings.js';

/* Bridges non-concurrent, single-shot, tool-less StudyHub tasks to an installed web-Gemini
   MCP server (such as `mcp__gemini-browser__ask_gemini_web`). Calls are serialized through
   one process-wide FIFO queue because browser-tab bridges inject into one active Gemini tab. */

export const PREFERRED_WEB_GEMINI_TOOL = 'mcp__gemini-browser__ask_gemini_web';
export const WEB_GEMINI_TEST_TOKEN = 'STUDYHUB_GEMINI_OK';
export const WEB_GEMINI_NOT_READY_MESSAGE = '网页 Gemini 配置未启动，请确认已在 DSH 启动 ask-gemini-mcp，并在浏览器打开已加载扩展的 Gemini 网页。';
const PROBE_NOT_READY_DETAIL = '请确认已在 DSH 启动 ask-gemini-mcp，并在浏览器打开已加载扩展的 Gemini 网页。';
const TEST_PROMPT = `Reply with ONLY this exact token and nothing else: ${WEB_GEMINI_TEST_TOKEN}`;

const PROMPT_ARG_KEYS = ['prompt', 'question', 'message', 'query', 'text', 'input', 'content'];
const ELIGIBLE_KINDS = new Set([
  'workflow-skeleton',
  'workflow-teaching',
  'daily-recap',
  'note-generate',
  'course-book-ai',
  'case-answer-card',
  'companion-lesson-build',
  'assist',
]);

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const schemaOf = tool => (isObject(tool?.parameters) ? tool.parameters : isObject(tool?.inputSchema) ? tool.inputSchema : null);
const isStringSchema = schema => !schema || schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'));

let serialTail = Promise.resolve();

function enqueueWebGemini(task, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  const run = serialTail.then(async () => {
    signal?.throwIfAborted?.();
    return await task();
  });
  serialTail = run.then(() => {}, () => {});
  return run;
}

/** Describe MCP tools exposed by DSH that accept a text prompt, putting Gemini web tools first. */
export function detectWebGeminiTools(tools = []) {
  const found = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (typeof tool?.name !== 'string' || !tool.name.startsWith('mcp__')) continue;
    const schema = schemaOf(tool);
    const props = isObject(schema?.properties) ? schema.properties : null;
    const stringKeys = props ? Object.entries(props).filter(([, value]) => isStringSchema(value)).map(([key]) => key) : ['prompt'];
    if (props && stringKeys.length === 0) continue;
    const [, server = '', ...rest] = tool.name.split('__');
    const label = rest.join('__') || tool.name;
    const haystack = `${tool.name} ${tool.description ?? ''}`;
    const exactPreferred = tool.name === PREFERRED_WEB_GEMINI_TOOL;
    const askGemini = /(?:^|__)ask_gemini(?:_web)?$/i.test(tool.name) || /ask_gemini/i.test(label);
    const geminiHint = /gemini/i.test(haystack);
    const rank = exactPreferred ? 0 : askGemini ? 1 : geminiHint ? 2 : 3;
    found.push({
      name: tool.name,
      server,
      label,
      description: String(tool.description ?? '').slice(0, 300),
      matched: rank < 3,
      rank,
      argKey: PROMPT_ARG_KEYS.find(key => stringKeys.includes(key)) || stringKeys[0] || 'prompt',
      parameters: schema,
    });
  }
  found.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return found.map(({ rank, ...entry }) => entry);
}

/** Resolve which MCP tool should run given saved/requested preference and detected tools. */
export function resolveWebGeminiTool(detected, preferredName = '') {
  const chosen = typeof preferredName === 'string' ? preferredName.trim() : '';
  if (chosen) {
    const match = detected.find(entry => entry.name === chosen) || null;
    return { tool: match, missing: match ? null : chosen };
  }
  const auto = detected.find(entry => entry.matched) || null;
  return { tool: auto, missing: null };
}

/** Build the MCP tool arguments object combining optional system instructions and user prompt. */
export function buildWebGeminiArgs(tool, system, prompt) {
  const parts = [system, prompt].map(part => (typeof part === 'string' ? part.trim() : '')).filter(Boolean);
  const combined = parts.join('\n\n');
  const key = tool?.argKey || 'prompt';
  return { [key]: combined };
}

function isWebGeminiErrorPayload(cleaned) {
  if (!cleaned || /^[{[`]/.test(cleaned)) return false;
  const lines = cleaned.split(/\r?\n/).length;
  if (cleaned.length <= 800 && lines <= 6 && /^(?:MCP\s+error\b|Error:\s+\S|ToolExecutionError:\s+\S|AbortError:\s+\S)/i.test(cleaned)) {
    return true;
  }
  if (cleaned.length <= 600 && lines <= 4 && /(?:(?:chrome|browser)\s+)?extension\s+(?:is\s+)?not\s+connected|open\s+a\s+gemini\s+page\s+with\s+the\s+extension\s+loaded|no\s+(?:active\s+)?gemini\s+(?:tab|page|window)\b|gemini\s+(?:tab|page)\s+(?:is\s+)?not\s+(?:open|found|connected)/i.test(cleaned)) {
    return true;
  }
  return false;
}

function classifyWebGeminiError(error, seconds, { timeoutAborted = false } = {}) {
  const rawMsg = String(error?.message || error || '').trim();
  const isSetupFailure = /(?:chrome|browser)?\s*extension\b|not\s+connected|open\s+a\s+gemini\s+page|no\s+(?:active\s+)?gemini|econnrefused|enoent|connection\s+(?:closed|refused|lost)|websocket|mcp\s+error|tool\s+batch\s+execution\s+failed|browser\s+disconnected|未检测到|未在\s*DSH|工具注册表不可用|未提供\s*MCP|配置未启动/i.test(rawMsg);
  if (timeoutAborted || (!isSetupFailure && /等待回答超时|timed?\s*out|timeout/i.test(rawMsg))) {
    const timeoutMessage = `网页 Gemini 等待回答超时（${seconds} 秒内未完成响应）`;
    return { reason: 'timeout', message: timeoutMessage, probeMessage: timeoutMessage };
  }
  return { reason: 'not-ready', message: WEB_GEMINI_NOT_READY_MESSAGE, probeMessage: PROBE_NOT_READY_DETAIL };
}

/** Extract clean response text from an MCP tool execution result and strip Chrome DOM copy banners. */
export function extractWebGeminiText(raw) {
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (isObject(raw)) {
    if (Array.isArray(raw.content)) {
      text = raw.content
        .filter(item => item && typeof item.text === 'string')
        .map(item => item.text)
        .join('\n');
    }
    if (!text && isObject(raw.structuredContent)) {
      for (const key of ['text', 'reply', 'answer', 'response', 'result', 'content']) {
        if (typeof raw.structuredContent[key] === 'string' && raw.structuredContent[key].trim()) {
          text = raw.structuredContent[key];
          break;
        }
      }
    }
    if (!text && typeof raw.text === 'string') text = raw.text;
    const errorDetail = typeof raw.error === 'string'
      ? raw.error
      : raw.error?.message || (typeof raw.structuredContent?.error === 'string' ? raw.structuredContent.error : raw.structuredContent?.error?.message);
    if (raw.isError === true || raw.status === 'error' || Boolean(raw.error) || raw.structuredContent?.isError === true || Boolean(raw.structuredContent?.error)) {
      throw Object.assign(new Error(text.trim() || String(errorDetail || '').trim() || '网页 Gemini MCP 返回了错误'), { code: 'web-gemini-tool-error' });
    }
  }
  let cleaned = String(text ?? '').trim();
  // Chrome's markdown container innerText can prepend a language + Copy button label above code blocks.
  const withoutCopyBanner = cleaned.replace(/^(?:[A-Za-z0-9_+-]{1,24}\s*\r?\n)?(?:Copy code|复制代码)\s*\r?\n/, '');
  if (withoutCopyBanner !== cleaned) cleaned = withoutCopyBanner.trim();
  // If the entire reply is a fenced JSON block whose body parses cleanly or starts with JSON, keep fence-compatible text
  // (`parseJson` strips fences too; unwrapping copy-banner artifacts ensures downstream JSON parsers always succeed).
  if (!cleaned) throw new Error('empty-model-output');
  if (isWebGeminiErrorPayload(cleaned)) {
    throw Object.assign(new Error(cleaned), { code: 'web-gemini-tool-error' });
  }
  return cleaned;
}

/** True only for non-concurrent, single-shot or serial tool-less StudyHub tasks (never batched fan-out or light steps). */
export function isWebGeminiEligibleJob({ record, options } = {}) {
  if (!record || options?.model === 'light') return false;
  if (ELIGIBLE_KINDS.has(record.kind)) return true;
  if (record.kind === 'generation') {
    const genKind = record.detail?.legacy?.kind ?? record.detail?.kind;
    return genKind === 'case';
  }
  return false;
}

function portFor(ctx) {
  if (!ctx) return null;
  if (Object.hasOwn(ctx, 'tools') && typeof ctx.tools === 'function' && typeof ctx.call === 'function') return ctx;
  return retrievalPort(ctx);
}

function summarizeStatus(settings, detected) {
  const { tool, missing } = resolveWebGeminiTool(detected, settings.toolName);
  const publicTools = detected.map(({ name, server, label, description, matched }) => ({ name, server, label, description, matched }));
  return {
    enabled: settings.enabled,
    toolName: settings.toolName,
    waitSeconds: settings.waitSeconds,
    minWaitSeconds: MIN_WAIT_SECONDS,
    maxWaitSeconds: MAX_WAIT_SECONDS,
    effectiveTool: tool?.name ?? null,
    missing,
    available: Boolean(tool),
    hasToolRegistry: Boolean(detected),
    tools: publicTools,
    active: Boolean(settings.enabled && tool),
  };
}

/** Safely check whether a DSH/Cordis context exposes a tools registry without triggering inject assertions. */
export function hasWebGeminiToolsRegistry(ctx) {
  if (!ctx) return false;
  if (Object.hasOwn(ctx, 'tools') && typeof ctx.tools === 'function' && typeof ctx.call === 'function') return true;
  return Boolean(hostService(ctx, 'tools', 'schemas') || hostService(ctx, 'tools', 'execute'));
}

/** Host adapter exposing web-Gemini status, configuration, connectivity testing, and serialized execution. */
export function createWebGeminiPort(ctx) {
  const hasToolRegistry = hasWebGeminiToolsRegistry(ctx);
  const readTools = () => {
    const port = portFor(ctx);
    return port ? detectWebGeminiTools(port.tools()) : [];
  };

  async function invokeTool({ tool, system, prompt, signal, waitSeconds }) {
    const port = portFor(ctx);
    if (!port) throw Object.assign(new Error('当前宿主未提供 MCP 工具调用能力'), { code: 'web-gemini-not-ready' });
    if (!tool) throw Object.assign(new Error('未检测到可用的网页 Gemini MCP 工具'), { code: 'web-gemini-not-ready' });
    const seconds = Math.max(MIN_WAIT_SECONDS, Math.min(MAX_WAIT_SECONDS, Math.trunc(Number(waitSeconds) || DEFAULT_WAIT_SECONDS)));
    const timeoutMs = seconds * 1000;
    const args = buildWebGeminiArgs(tool, system, prompt);
    return enqueueWebGemini(async () => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const raw = await port.call(tool.name, args, { signal: combined, timeoutMs });
        return extractWebGeminiText(raw);
      } catch (error) {
        if (signal?.aborted && !timeoutSignal.aborted) throw error;
        const classified = classifyWebGeminiError(error, seconds, { timeoutAborted: timeoutSignal.aborted });
        throw Object.assign(new Error(classified.message, { cause: error }), {
          code: classified.reason === 'timeout' ? 'web-gemini-timeout' : 'web-gemini-not-ready',
        });
      }
    }, signal);
  }

  async function status() {
    const settings = await readWebGeminiSettings();
    const detected = readTools();
    return { ...summarizeStatus(settings, detected), hasToolRegistry };
  }

  async function set(patch = {}) {
    const current = await readWebGeminiSettings();
    const detected = readTools();
    if (typeof patch.toolName === 'string' && patch.toolName.trim() && patch.toolName.trim() !== current.toolName) {
      const wanted = patch.toolName.trim();
      if (!detected.some(item => item.name === wanted)) {
        throw new Error(`未在 DSH 中检测到工具「${wanted}」，请先确认 ask-gemini-mcp 已启用`);
      }
    }
    await saveWebGeminiSettings(patch);
    return status();
  }

  async function test({ toolName, waitSeconds, signal } = {}) {
    const settings = await readWebGeminiSettings();
    const detected = readTools();
    const targetName = typeof toolName === 'string' ? toolName : settings.toolName;
    const { tool, missing } = resolveWebGeminiTool(detected, targetName);
    const chosenSeconds = waitSeconds !== undefined ? Number(waitSeconds) : settings.waitSeconds;
    const effectiveSeconds = Number.isInteger(chosenSeconds) && chosenSeconds >= MIN_WAIT_SECONDS && chosenSeconds <= MAX_WAIT_SECONDS
      ? chosenSeconds
      : settings.waitSeconds;
    if (!tool) {
      return {
        ok: false,
        toolName: missing || targetName || PREFERRED_WEB_GEMINI_TOOL,
        reason: 'missing',
        latencyMs: 0,
        message: missing
          ? `未在 DSH 中找到指定的 MCP 工具「${missing}」。请确认服务器已启动。`
          : '未检测到网页 Gemini MCP 工具（如 ask_gemini_web）。请确认 DSH 已安装并启用 ask-gemini-mcp。',
      };
    }
    const startedAt = Date.now();
    try {
      const reply = await invokeTool({
        tool,
        system: '',
        prompt: TEST_PROMPT,
        signal,
        waitSeconds: effectiveSeconds,
      });
      const latencyMs = Date.now() - startedAt;
      const normalized = reply.trim();
      const matchedToken = normalized.toUpperCase().includes(WEB_GEMINI_TEST_TOKEN);
      if (!matchedToken) {
        return {
          ok: false,
          toolName: tool.name,
          waitSeconds: effectiveSeconds,
          latencyMs,
          matchedToken: false,
          reason: 'not-ready',
          message: PROBE_NOT_READY_DETAIL,
        };
      }
      return {
        ok: true,
        toolName: tool.name,
        waitSeconds: effectiveSeconds,
        latencyMs,
        matchedToken,
        reply: normalized.slice(0, 240),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const classified = classifyWebGeminiError(error, effectiveSeconds, {
        timeoutAborted: error?.code === 'web-gemini-timeout',
      });
      return {
        ok: false,
        toolName: tool.name,
        waitSeconds: effectiveSeconds,
        latencyMs,
        reason: classified.reason,
        message: classified.probeMessage,
      };
    }
  }

  function isActiveSync() {
    const settings = readWebGeminiSettingsSync();
    if (!settings.enabled) return false;
    const { tool } = resolveWebGeminiTool(readTools(), settings.toolName);
    return Boolean(tool);
  }

  function stepTimeoutMs({ record, policy, options } = {}) {
    if (!isWebGeminiEligibleJob({ record, options })) return policy?.budget?.timeoutMs;
    const settings = readWebGeminiSettingsSync();
    if (!settings.enabled) return policy?.budget?.timeoutMs;
    const { tool } = resolveWebGeminiTool(readTools(), settings.toolName);
    if (!tool) return policy?.budget?.timeoutMs;
    return Math.max(policy?.budget?.timeoutMs || 0, settings.waitSeconds * 1000);
  }

  async function prepare({ record, options } = {}) {
    if (!isWebGeminiEligibleJob({ record, options })) return null;
    const settings = await readWebGeminiSettings();
    if (!settings.enabled) return null;
    const { tool } = resolveWebGeminiTool(readTools(), settings.toolName);
    if (!tool) return null;
    const runner = record?.capabilities?.executionModes?.includes('subagent') ? 'subagent' : 'direct';
    return {
      runner,
      toolName: tool.name,
      waitSeconds: settings.waitSeconds,
      ask: (system, prompt, signal) => invokeTool({ tool, system, prompt, signal, waitSeconds: settings.waitSeconds }),
    };
  }

  async function prepareForAssist() {
    const settings = await readWebGeminiSettings();
    if (!settings.enabled) return null;
    const { tool } = resolveWebGeminiTool(readTools(), settings.toolName);
    if (!tool) return null;
    return {
      runner: 'subagent',
      toolName: tool.name,
      waitSeconds: settings.waitSeconds,
      ask: (system, prompt, signal) => invokeTool({ tool, system, prompt, signal, waitSeconds: settings.waitSeconds }),
    };
  }

  async function activeAsk() {
    return await prepareForAssist();
  }

  return Object.freeze({
    status,
    set,
    test,
    isActiveSync,
    stepTimeoutMs,
    prepare,
    prepareForAssist,
    activeAsk,
  });
}
