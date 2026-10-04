export const dailyRecapDefaults = Object.freeze({ automatic: false, tone: 'friendly', timeZone: 'Asia/Shanghai' });

export function checkedTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('请选择有效的时区');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error('请选择有效的时区'); }
}

export function mergeDailyRecapSettings(current, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('每日总结设置格式不对');
  const next = { ...dailyRecapDefaults, ...current, ...patch };
  if (typeof next.automatic !== 'boolean') throw new Error('自动生成每日总结需为 true 或 false');
  if (!['friendly', 'professional'].includes(next.tone)) throw new Error('总结口吻请选择亲切或专业');
  next.timeZone = checkedTimeZone(next.timeZone);
  return { automatic: next.automatic, tone: next.tone, timeZone: next.timeZone };
}

// Old libraries receive the same opt-in default without turning a malformed preference on.
export function normalizeDailyRecapSettings(value) {
  try { return mergeDailyRecapSettings(undefined, value ?? {}); }
  catch { return { ...dailyRecapDefaults }; }
}
