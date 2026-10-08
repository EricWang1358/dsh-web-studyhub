import { browserStorage, readJSON, writeJSON } from '../storage.js';

/* When the learner last had the 任务 console in front of them, per library: the time after which an ended job is news (ui/tasks/task-model.js unseenResults).
   It is a convenience of this browser, so a blocked or missing storage only means the badge starts again from "now" (the hook keeps it in memory meanwhile). */
const key = root => `study-tasks-seen:v1:${root || ''}`;

/** The time of the last visit; the first time this library is looked at it is `now` (jobs that ended before the app was ever opened here are not news), and it is kept. */
export function readSeenAt(root, { now = Date.now(), storage = browserStorage() } = {}) {
  if (!root) return now;
  const stored = readJSON(key(root), null, storage);
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  writeJSON(key(root), now, storage);
  return now;
}

export const markSeenAt = (root, at = Date.now(), storage = browserStorage()) => writeJSON(key(root), at, storage);
