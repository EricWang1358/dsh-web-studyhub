import { readJSON, readText, removeKey, writeText } from "../storage.js";
import { clearCount } from "../guidance/cleared.js";

/* Per-library onboarding memory, a per-viewer convenience kept in the
   browser's storage (ui/storage.js): where a paused tour stopped, and whether
   this library's welcome page was dismissed. Blocked or full storage just forgets. */

/** The key prefix of 以后再说 (the first-run line put away), one key per library; 设置 › 引导 reads it through ui/guidance/registry.js. */
export const WELCOME_PREFIX = "study-welcome:";
const tourKey = (root) => `study-tour:${root || ""}`;
const welcomeKey = (root) => `${WELCOME_PREFIX}${root || ""}`;

const read = (key) => readText(key, null);
const write = (key, value) => (value === null ? removeKey(key) : writeText(key, value)); // remembered for this session only when refused

/** { stepId, done } or null; `full: true` when the paused tour is the full one (ui/tour/steps.js), absent for the short one. */
export function readTourProgress(root) {
  const value = readJSON(tourKey(root));
  return value && typeof value === "object" && typeof value.stepId === "string" ? { stepId: value.stepId, done: !!value.done, ...(value.full === true ? { full: true } : {}) } : null;
}
export const writeTourProgress = (root, value) => write(tourKey(root), value ? JSON.stringify({ stepId: value.stepId, done: !!value.done, ...(value.full ? { full: true } : {}) }) : null);

export const welcomeDismissed = (root) => read(welcomeKey(root)) === "dismissed";
export const dismissWelcome = (root) => write(welcomeKey(root), "dismissed");

/* 以后再说 is also held in memory for the visit (ui/app/use-tour.js), so a cleared site storage or another tab's reset does not bring the line back in the
   middle of a visit. Only an explicit 再显示一次 / 重新显示全部提示 in THIS tab (ui/guidance/cleared.js counts them) undoes the memory. */
const WELCOME_ITEM = "first-run.later";

/** Put the line away for `root`: stores it, and answers the memory to keep for the visit ({ root, cleared }). */
export function hideWelcomeFor(root) {
  dismissWelcome(root);
  return { root, cleared: clearCount(WELCOME_ITEM) };
}

/** Is the line put away for `root`: by the memory of this visit (unless this tab cleared it since), or by what is stored. */
export const welcomeLater = (root, memory) => !!root && ((memory?.root === root && memory.cleared === clearCount(WELCOME_ITEM)) || welcomeDismissed(root));
