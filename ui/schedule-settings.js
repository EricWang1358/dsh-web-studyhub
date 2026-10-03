import { defaults } from '../lib/sm2.js';

const fields = Object.keys(defaults);

/** Refresh only pristine scheduling fields, preserving edits and other categories' values. */
export function syncScheduleSettings(current = {}, before = {}, after = {}) {
  let next = current;
  for (const key of fields) {
    if (!Object.hasOwn(after, key) || (current[key] !== undefined && Number(current[key]) !== Number(before[key]))) continue;
    if (current[key] === after[key]) continue;
    if (next === current) next = { ...current };
    next[key] = after[key];
  }
  return next;
}
