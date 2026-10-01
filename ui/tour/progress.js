/* Per-library onboarding memory, a per-viewer convenience kept in
   localStorage: where a paused tour stopped, and whether this library's
   welcome page was dismissed. Blocked or full storage just forgets. */

const tourKey = (root) => `study-tour:${root || ""}`;
const welcomeKey = (root) => `study-welcome:${root || ""}`;

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* remembered for this session only */ }
}

/** { stepId, done } or null. */
export function readTourProgress(root) {
  try {
    const value = JSON.parse(read(tourKey(root)));
    return value && typeof value === "object" && typeof value.stepId === "string" ? { stepId: value.stepId, done: !!value.done } : null;
  } catch { return null; }
}
export const writeTourProgress = (root, value) => write(tourKey(root), value ? JSON.stringify({ stepId: value.stepId, done: !!value.done }) : null);

export const welcomeDismissed = (root) => read(welcomeKey(root)) === "dismissed";
export const dismissWelcome = (root) => write(welcomeKey(root), "dismissed");
