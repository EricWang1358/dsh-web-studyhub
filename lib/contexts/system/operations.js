import { checkSettings } from "../../domain.js";
import { mergeGenerationSettings } from "../../generation-settings.js";
import { mergeDailyRecapSettings } from "../../daily-recap-settings.js";
import { mergeExamPrepSettings, resolveExamPrepSettings } from "../../exam-prep-settings.js";
import { checkForUpdate, setUpdatePreferences } from "../../update-check.js";
import { createJevOperations } from "../../jev-operations.js";
import { readExperimental, setExperimental } from "../../experimental.js";
import { createUsageFrequencyOperations } from "../../usage-frequency-operations.js";



/** system operations close over only the ports declared by this context. */
export function createOperations(ports = {}) {
const handlers = {
// Library-independent: the release check is cached per DSH home, not per study library.
"update.check": async function (a = {}) {
      return checkForUpdate({ force: a.force === true, ...(ports.fetch ? { fetch: ports.fetch } : {}) });
    },
"update.preferences": async function (a = {}) {
      return setUpdatePreferences({ ...(a.autoCheck !== undefined ? { autoCheck: a.autoCheck } : {}), ...(a.snooze !== undefined ? { snooze: a.snooze } : {}) });
    },
// "Show experimental features" (Settings › Advanced): the one switch that makes anything experimental visible. Off by default.
"experimental.get": async function () { return { enabled: await readExperimental() }; },
"experimental.set": async function (a = {}) { return { enabled: await setExperimental(a.enabled) }; },
// Experimental Jev decision layer (settings, key test, usage): library-independent, off until the learner switches it on.
...createJevOperations(ports),
// Usage frequency record (Settings › Advanced): opt-in, local, counts only; library-independent. Panel operations: the assistant's tool refuses them.
...createUsageFrequencyOperations(ports),
};
const mutations = {
"settings": (s, a) => {

      s.settings = checkSettings({ ...s.settings, ...a,
        ...(a.generation !== undefined ? { generation: mergeGenerationSettings(s.settings.generation, a.generation) } : {}),
        ...(a.dailyRecap !== undefined ? { dailyRecap: mergeDailyRecapSettings(s.settings.dailyRecap, a.dailyRecap) } : {}),
        ...(a.examPrep !== undefined ? { examPrep: mergeExamPrepSettings(s.settings.examPrep, a.examPrep) } : {}) });
      return s.settings;
    },
// 备考补习 personal defaults (lib/exam-prep-settings.js): one optional key of the library settings, absent until saved; reset takes the key out again.
"settings.examPrep.set": (s, a = {}) => (s.settings.examPrep = mergeExamPrepSettings(s.settings.examPrep, a.patch)),
"settings.examPrep.reset": (s) => {
  // The learner's switch is not a personal default: forgetting the defaults keeps the page as it is (off stays off).
  if (s.settings.examPrep?.enabled === false) s.settings.examPrep = { enabled: false }; else delete s.settings.examPrep;
  return resolveExamPrepSettings(s.settings.examPrep);
}
};
  return { handlers, mutations };
}
