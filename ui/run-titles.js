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

/** Re-localize run/exam DTO titles inside an existing snapshot without altering identity when nothing changed. */
export function relocalizeSnapshotRuns(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  let changed = false;
  let next = snapshot;
  for (const key of ['runs', 'exams']) {
    if (!Array.isArray(snapshot[key])) continue;
    let listChanged = false;
    const mapped = snapshot[key].map((item) => {
      const updated = localizedRun(item);
      if (updated?.title !== item?.title) {
        listChanged = true;
        return updated;
      }
      return item;
    });
    if (listChanged) {
      next = next === snapshot ? { ...snapshot } : next;
      next[key] = mapped;
      changed = true;
    }
  }
  if (snapshot.lastRun) {
    const updatedLast = localizedRun(snapshot.lastRun);
    if (updatedLast?.title !== snapshot.lastRun.title) {
      next = next === snapshot ? { ...snapshot } : next;
      next.lastRun = updatedLast;
      changed = true;
    }
  }
  return changed ? next : snapshot;
}
