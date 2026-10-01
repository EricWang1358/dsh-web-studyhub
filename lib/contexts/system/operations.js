import { checkSettings } from "../../domain.js";



/** system operations close over only the ports declared by this context. */
export function createOperations() {
const handlers = {

};
const mutations = {
"settings": (s, a) => {

      s.settings = checkSettings({ ...s.settings, ...a });
      return s.settings;
    }
};
  return { handlers, mutations };
}
