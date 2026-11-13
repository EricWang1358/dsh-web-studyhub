import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseStoredJson } from '../util.js';

/* Preferences for routing non-concurrent, single-shot, tool-less StudyHub jobs and subagent tasks
   to a local web-Gemini MCP bridge (for example `mcp__gemini-browser__ask_gemini_web`). Stored under
   `$DSH_HOME/study/` alongside retrieval settings because MCP servers belong to the DSH installation,
   not portable study library backups. */

export const MIN_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 1800;
export const DEFAULT_WAIT_SECONDS = 600;
const TOOL_NAME = /^mcp__[A-Za-z0-9_.-]{1,120}$/;

export const DEFAULT_WEB_GEMINI_SETTINGS = Object.freeze({
  enabled: false,
  toolName: '',
  waitSeconds: DEFAULT_WAIT_SECONDS,
});

/** Location of the web-Gemini routing settings under the DSH user directory. */
export const webGeminiSettingsPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'web-gemini.json');

/** Parse a saved or partial object into valid settings, falling back safely on corrupt values. */
export function normalizeWebGeminiSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_WEB_GEMINI_SETTINGS };
  const enabled = value.enabled === true;
  const rawTool = typeof value.toolName === 'string' ? value.toolName.trim() : '';
  const toolName = rawTool && TOOL_NAME.test(rawTool) ? rawTool : '';
  const parsedWait = Math.trunc(Number(value.waitSeconds));
  const waitSeconds = Number.isFinite(parsedWait)
    ? Math.max(MIN_WAIT_SECONDS, Math.min(MAX_WAIT_SECONDS, parsedWait))
    : DEFAULT_WAIT_SECONDS;
  return { enabled, toolName, waitSeconds };
}

/** Read current web-Gemini settings asynchronously; returns defaults when absent or unreadable. */
export async function readWebGeminiSettings() {
  try {
    return normalizeWebGeminiSettings(parseStoredJson(await readFile(webGeminiSettingsPath(), 'utf8')));
  } catch {
    return { ...DEFAULT_WEB_GEMINI_SETTINGS };
  }
}

/** Read current web-Gemini settings synchronously for timeout/readiness resolution in non-async setup paths. */
export function readWebGeminiSettingsSync() {
  try {
    return normalizeWebGeminiSettings(parseStoredJson(readFileSync(webGeminiSettingsPath(), 'utf8')));
  } catch {
    return { ...DEFAULT_WEB_GEMINI_SETTINGS };
  }
}

/** Validate and atomically save web-Gemini settings, merging omitted fields from the existing file. */
export async function saveWebGeminiSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('网页 Gemini 设置必须是对象');
  const current = await readWebGeminiSettings();
  const enabled = patch.enabled === undefined ? current.enabled : Boolean(patch.enabled);
  let toolName = current.toolName;
  if (patch.toolName !== undefined) {
    const rawTool = typeof patch.toolName === 'string' ? patch.toolName.trim() : '';
    if (rawTool && !TOOL_NAME.test(rawTool)) throw new Error('指定的 MCP 工具名格式无效');
    toolName = rawTool;
  }
  let waitSeconds = current.waitSeconds;
  if (patch.waitSeconds !== undefined) {
    const parsed = Number(patch.waitSeconds);
    if (!Number.isInteger(parsed) || parsed < MIN_WAIT_SECONDS || parsed > MAX_WAIT_SECONDS)
      throw new Error(`等待时长需为 ${MIN_WAIT_SECONDS}–${MAX_WAIT_SECONDS} 秒之间的整数`);
    waitSeconds = parsed;
  }
  const next = { enabled, toolName, waitSeconds };
  const target = webGeminiSettingsPath(), tmp = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return next;
}
