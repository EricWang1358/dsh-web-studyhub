import { randomUUID } from 'node:crypto';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError } from '../../../mineru-local.js';
import { checkSetupRequest, prepareSetup, runSetup } from '../../../mineru-setup.js';

/* The setup of the local mineru is a background run per library, polled by the panel (like the search index build). It only ever starts after the learner
   confirmed the download. This is the setup with runtime.pilot.mineruSetup off; the same entry points on the runtime are in ./mineru-setup-runs.js. */
const setups = new Map();
const publicSetup = run => (run ? Object.fromEntries(Object.entries(run).filter(([key]) => !['controller', 'promise'].includes(key))) : { status: 'idle' });

export function createLegacySetupRuns({ root, seams }) {
  return Object.freeze({
    async start(args) {
      const tier = checkSetupRequest(args), current = setups.get(root);
      if (current?.status === 'running') throw new LocalMineruError('setup-busy', LOCAL_MESSAGES.setupBusy);
      const local = seams(), prepared = await prepareSetup(tier, local);
      const run = { id: randomUUID(), status: 'running', tier, step: prepared.step, startedAt: new Date().toISOString(), lastLine: '',
        modelsMb: LOCAL.modelsMb[tier], controller: new AbortController() };
      setups.set(root, run);
      run.promise = (async () => {
        try {
          run.state = await runSetup(prepared, local, { signal: run.controller.signal, observe: (_kind, work) => work(run.controller.signal),
            onStep: name => { run.step = name; }, onLine: line => { run.lastLine = line; } });
          Object.assign(run, { status: 'complete', step: 'done' });
        } catch (error) {
          if (run.controller.signal.aborted) Object.assign(run, { status: 'cancelled', step: 'cancelled' });
          else Object.assign(run, { status: 'failed', error: String(error?.message || error).slice(0, 400) });
        } finally { run.finishedAt = new Date().toISOString(); }
      })();
      return publicSetup(run);
    },
    async status() { return publicSetup(setups.get(root)); },
    async cancel() {
      const run = setups.get(root);
      if (run?.status === 'running') run.controller.abort(new Error('cancelled'));
      return publicSetup(run);
    },
  });
}
