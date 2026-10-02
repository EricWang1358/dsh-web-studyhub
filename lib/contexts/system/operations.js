import { checkSettings } from "../../domain.js";
import { checkForUpdate, setUpdatePreferences } from "../../update-check.js";
import { createJevOperations } from "../../jev-operations.js";
import { readExperimental, setExperimental } from "../../experimental.js";



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
};
const mutations = {
"settings": (s, a) => {

      s.settings = checkSettings({ ...s.settings, ...a });
      return s.settings;
    }
};
  return { handlers, mutations };
}
