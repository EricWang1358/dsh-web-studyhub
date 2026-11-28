import { preserveUnknownKeys } from './contexts/system/preserve-unknown-keys.js';

export const dailyRecapDefaults = Object.freeze({ automatic: false, tone: 'friendly', timeZone: 'Asia/Shanghai' });

export function checkedTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('请选择有效的时区');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error('请选择有效的时区'); }
}

export function mergeDailyRecapSettings(current, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('每日总结设置格式不对');
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = { ...dailyRecapDefaults, ...base, ...patch };
  if (typeof next.automatic !== 'boolean') throw new Error('自动生成每日总结需为 true 或 false');
  if (!['friendly', 'professional'].includes(next.tone)) throw new Error('总结口吻请选择亲切或专业');
  next.timeZone = checkedTimeZone(next.timeZone);
  return preserveUnknownKeys(base, { automatic: next.automatic, tone: next.tone, timeZone: next.timeZone });
}

// Old libraries receive the same opt-in default without turning a malformed preference on; unknown future keys survive.
export function normalizeDailyRecapSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let timeZone = dailyRecapDefaults.timeZone;
  if (typeof source.timeZone === 'string') {
    try { timeZone = checkedTimeZone(source.timeZone); } catch { /* fall back to default */ }
  }
  return preserveUnknownKeys(value, {
    automatic: typeof source.automatic === 'boolean' ? source.automatic : dailyRecapDefaults.automatic,
    tone: ['friendly', 'professional'].includes(source.tone) ? source.tone : dailyRecapDefaults.tone,
    timeZone,
  });
}
