import { readJSON, writeJSON, browserStorage } from '../../storage.js';

/* 公式乱码 suggestion (#1001), told once per material: the materials it was shown for, in the browser like 上次读到 (last-read.js), keyed the same way
   (lastReadKey: the library and the material), the newest HINT_LIMIT only. */

export const FORMULA_HINT_KEY = 'studyhub-formula-hint:v1';
export const HINT_LIMIT = 200;

const readAll = storage => {
  const all = readJSON(FORMULA_HINT_KEY, null, storage);
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
};

/** Whether the suggestion was already shown for this material. */
export const formulaHintTold = (key, storage = browserStorage()) => !!key && Number.isFinite(readAll(storage)[key]);

/** Remember that the suggestion was shown for this material; true when it was written. */
export function tellFormulaHint(key, { storage = browserStorage(), now = Date.now() } = {}) {
  if (!key || !storage) return false;
  const all = { ...readAll(storage), [key]: now };
  const keys = Object.keys(all);
  if (keys.length > HINT_LIMIT) for (const old of keys.sort((a, b) => all[a] - all[b]).slice(0, keys.length - HINT_LIMIT)) delete all[old];
  return writeJSON(FORMULA_HINT_KEY, all, storage);
}
