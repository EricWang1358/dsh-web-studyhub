import { uiFormat } from './i18n.js';

export function localizedRun(run) {
  return run?.titleInfo ? { ...run, title: uiFormat(run.titleInfo.template, run.titleInfo.values) } : run;
}
// Only known review DTO positions, never arbitrary card/source/note titles.
export function localizeRunResponse(value) {
  if (!value || typeof value !== 'object' || value.unchanged) return value;
  let result = localizedRun(value);
  for (const key of ['runs', 'exams']) if (Array.isArray(value[key]))
    result = { ...result, [key]: value[key].map(localizedRun) };
  if (value.lastRun) result = { ...result, lastRun: localizedRun(value.lastRun) };
  return result;
}
