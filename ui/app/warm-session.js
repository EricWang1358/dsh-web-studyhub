/* Per-session warm state across panel unmounts within the same host session.
   Keeping the last verified snapshot, binding, board, daily plan, notebooks and active page
   turns a return from DSH Chat into an immediate paint followed by a `since` revalidation. */

const MAX_WARM_SESSIONS = 8;

/** Pages whose entire view comes from the library snapshot / persisted stores rather than ephemeral run state. */
export const RESTORABLE_PAGES = new Set([
  'library',
  'sources',
  'generate',
  'tasks',
  'wrongbook',
  'workflows',
  'notes',
  'board',
  'exam',
  'examprep',
  'examcoach',
  'book',
  'dashboard',
  'skeleton',
  'audio',
  'live',
  'outline',
  'graph',
  'settings',
]);

const sessions = new Map();

const validKey = (warmKey) => (typeof warmKey === 'string' && warmKey ? warmKey : '');

function resetLibraryFields(entry) {
  entry.data = null;
  entry.snapshotKey = {};
  entry.board = null;
  entry.dailyPlan = null;
  entry.notebooks = null;
  entry.views = {};
}

function touchEntry(warmKey, { create = false } = {}) {
  const key = validKey(warmKey);
  if (!key) return null;
  let entry = sessions.get(key);
  if (entry) {
    // Refresh insertion order so active sessions stay warm under the cap.
    sessions.delete(key);
    sessions.set(key, entry);
    return entry;
  }
  if (!create) return null;
  entry = { root: '', binding: null, data: null, snapshotKey: {}, board: null, dailyPlan: null, notebooks: null, views: {} };
  sessions.set(key, entry);
  while (sessions.size > MAX_WARM_SESSIONS) sessions.delete(sessions.keys().next().value);
  return entry;
}

/** Return the cached warm session only when its snapshot and binding still agree on the same library root. */
export function readWarmSession(warmKey) {
  const key = validKey(warmKey);
  if (!key) return null;
  const entry = sessions.get(key);
  if (!entry?.data || !entry.binding?.root || entry.data.root !== entry.binding.root) return null;
  return entry;
}

/** Store the latest verified library snapshot and its per-key serialization cache. */
export function writeWarmSnapshot(warmKey, { binding, data, snapshotKey } = {}) {
  if (!data) return;
  const entry = touchEntry(warmKey, { create: true });
  if (!entry) return;
  const root = data?.root || binding?.root || '';
  if (entry.root && root && entry.root !== root) {
    entry.board = null;
    entry.dailyPlan = null;
    entry.notebooks = null;
    entry.views = {};
  }
  entry.root = root;
  const matchedBinding = binding?.root === root ? binding : entry.binding?.root === root ? entry.binding : null;
  entry.binding = matchedBinding || (root ? { ...(binding || {}), root } : binding || { root: '', provider: '', model: '' });
  entry.data = data;
  entry.snapshotKey = snapshotKey ? { ...snapshotKey } : {};
}

/** Update the session's library binding, dropping cached data if it moved to a different root. */
export function writeWarmBinding(warmKey, binding) {
  if (!binding) return;
  const entry = touchEntry(warmKey, { create: true });
  if (!entry) return;
  const root = binding?.root || '';
  if (entry.root && entry.root !== root) resetLibraryFields(entry);
  entry.root = root;
  entry.binding = binding;
}

/** Cache the latest confirmed board snapshot for this session and library root. */
export function writeWarmBoard(warmKey, root, board) {
  if (!root || !board) return;
  const entry = touchEntry(warmKey, { create: true });
  if (!entry) return;
  if (entry.root && entry.root !== root) return;
  if (!entry.root) entry.root = root;
  entry.board = board;
}

/** Cache the latest daily-plan snapshot when it belongs to the session's current library root. */
export function writeWarmDailyPlan(warmKey, root, dailyPlan) {
  if (!root || !dailyPlan) return;
  const entry = touchEntry(warmKey);
  if (!entry || entry.root !== root) return;
  entry.dailyPlan = dailyPlan;
}

/** Cache the latest notebook directory listing when it belongs to the session's current library root. */
export function writeWarmNotebooks(warmKey, root, notebooks) {
  if (!root) return;
  const entry = touchEntry(warmKey);
  if (!entry || entry.root !== root) return;
  entry.notebooks = notebooks;
}

/** Remember the active restorable page per non-sidebar seat placement for instant re-entry. */
export function writeWarmView(warmKey, root, placement, { page, boardView } = {}) {
  if (!root || placement === 'sidebar' || !RESTORABLE_PAGES.has(page)) return;
  const entry = touchEntry(warmKey);
  if (!entry || entry.root !== root) return;
  entry.views[placement || 'main'] = { page, boardView: boardView || 'today' };
}

/** Forget all warm state for one session (e.g. after switching or restoring a library). */
export function clearWarmSession(warmKey) {
  const key = validKey(warmKey);
  if (key) sessions.delete(key);
}

/** Clear all warm sessions across tests. */
export function resetWarmSessions() {
  sessions.clear();
}
