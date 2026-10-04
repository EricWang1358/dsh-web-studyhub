import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const markerSettingsPath = () => path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'), 'study', 'marker.json');

export async function readMarkerSettings() {
  try {
    const value = JSON.parse(await readFile(markerSettingsPath(), 'utf8'));
    return { command: typeof value?.command === 'string' ? value.command : '' };
  } catch { return { command: '' }; }
}

/** A program path, never a shell command or a list of arguments. Empty restores automatic discovery. */
export async function saveMarkerSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Marker 设置必须是对象');
  const next = await readMarkerSettings();
  if (patch.command !== undefined) {
    if (typeof patch.command !== 'string') throw new Error('Marker 程序路径必须是字符串');
    const command = patch.command.trim();
    if (command && (!path.isAbsolute(command) || /[\u0000\r\n]/.test(command))) throw new Error('请选择 Marker 程序的完整路径，或留空自动查找');
    next.command = command;
  }
  const target = markerSettingsPath(), temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
  return next;
}
