import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicUpdateJson, backupThenRecover, parseJsonObject } from './atomic-json.js';
import { studyHomePath } from './runtime/dsh-home.js';
import { preserveUnknownKeys } from './contexts/system/preserve-unknown-keys.js';

export const markerSettingsPath = () => studyHomePath('marker.json');
const MARKER_ENVELOPE_KEYS = new Set(['version']);

export async function readMarkerSettings() {
  try {
    const value = JSON.parse(await readFile(markerSettingsPath(), 'utf8'));
    return preserveUnknownKeys(value, { command: typeof value?.command === 'string' ? value.command : '' }, MARKER_ENVELOPE_KEYS);
  } catch { return { command: '' }; }
}

/** A program path, never a shell command or a list of arguments. Empty restores automatic discovery. */
export async function saveMarkerSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Marker 设置必须是对象');
  const target = markerSettingsPath();
  let saved = { command: '' };
  await atomicUpdateJson(target, (prev) => {
    const next = { command: typeof prev?.command === 'string' ? prev.command : '' };
    if (patch.command !== undefined) {
      if (typeof patch.command !== 'string') throw new Error('Marker 程序路径必须是字符串');
      const command = patch.command.trim();
      if (command && (!path.isAbsolute(command) || /[\u0000\r\n]/.test(command))) throw new Error('请选择 Marker 程序的完整路径，或留空自动查找');
      next.command = command;
    }
    saved = preserveUnknownKeys(prev, next, MARKER_ENVELOPE_KEYS);
    return preserveUnknownKeys(prev, { version: 1, ...next });
  }, {
    parse: parseJsonObject,
    onCorrupt: backupThenRecover(target, {}, { mode: 0o600 }),
    space: 2,
    trailingNewline: true,
    mode: 0o600,
    sync: true,
  });
  return saved;
}
