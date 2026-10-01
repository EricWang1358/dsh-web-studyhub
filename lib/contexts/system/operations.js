import { checkSettings } from "../../domain.js";
import { checkForUpdate, setUpdatePreferences } from "../../update-check.js";



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
};
const mutations = {
"settings": (s, a) => {

      s.settings = checkSettings({ ...s.settings, ...a });
      return s.settings;
    }
};
  return { handlers, mutations };
}
