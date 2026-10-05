import { readJSON, readText, removeKey, writeText } from "../storage.js";

/* Per-library onboarding memory, a per-viewer convenience kept in the
   browser's storage (ui/storage.js): where a paused tour stopped, and whether
   this library's welcome page was dismissed. Blocked or full storage just forgets. */

const tourKey = (root) => `study-tour:${root || ""}`;
const welcomeKey = (root) => `study-welcome:${root || ""}`;

const read = (key) => readText(key, null);
const write = (key, value) => (value === null ? removeKey(key) : writeText(key, value)); // remembered for this session only when refused

/** { stepId, done } or null. */
export function readTourProgress(root) {
  const value = readJSON(tourKey(root));
  return value && typeof value === "object" && typeof value.stepId === "string" ? { stepId: value.stepId, done: !!value.done } : null;
}
export const writeTourProgress = (root, value) => write(tourKey(root), value ? JSON.stringify({ stepId: value.stepId, done: !!value.done }) : null);

export const welcomeDismissed = (root) => read(welcomeKey(root)) === "dismissed";
export const dismissWelcome = (root) => write(welcomeKey(root), "dismissed");
