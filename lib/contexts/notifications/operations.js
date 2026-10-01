import { markRead } from "../../inbox.js";



/** notifications operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort } = ports;
const handlers = {
"inbox.raw": async function () {
      return (await storagePort.read()).inbox;
    }
};
const mutations = {
"inbox.mark": (s, a) => {
      const changed = markRead(s, a);
      return { changed, items: s.inbox };
    }
};
  return { handlers, mutations };
}
