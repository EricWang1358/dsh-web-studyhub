import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseStoredJson } from './util.js';

/* The one switch that makes experimental features visible at all ("Show experimental features", Settings › Advanced). Off by default.

   Everything experimental (today the Jev layer) stays out of sight until a learner turns this on: no section, button, badge or notice,
   no request, no timer. Turning it off again hides all of it and stops every experimental feature at once; the choices made inside
   (Jev provider, switches) are kept but inactive.

   It is a StudyHub setting of the machine, kept in the DSH home next to the other plugin settings (<DSH home>/study/experimental.json),
   not in the library: exports and backups never carry it, and restoring one never switches experiments on somewhere else. The
   snapshot carries it (`experimental`), so the surfaces that depend on it need no request of their own. */

export const experimentalPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'experimental.json');

/** Whether experimental features are shown. Anything but a stored boolean `true` means off. */
export async function readExperimental() {
  try { return parseStoredJson(await readFile(experimentalPath(), 'utf8'))?.enabled === true; } catch { return false; }
}

/** Switch it on or off; resolves the new state. */
export async function setExperimental(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是 true 或 false');
  const target = experimentalPath(), temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ version: 1, enabled })}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
  return enabled;
}
