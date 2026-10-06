import { LOCAL_MESSAGES, LocalMineruError } from '../../../mineru-local.js';
import { checkSetupRequest, runSetup } from '../../../mineru-setup.js';
import { observeLocalWith } from '../local-process-job.js';
import { SETUP_KIND, newSetupState, presentSetup } from './mineru-setup-view.js';

/** The local MinerU setup of one library (docs/plans/unified-job-runtime/s5-4-mineru-setup.md). The steps and their order are lib/mineru-setup.js's own;
 * this definition admits, observes and presents. The learner starts it in Settings (the assistant cannot, lib/assistant-boundary.js); the Job offers no
 * retry, pause or recovery, so the console cannot start it again either: a second setup is a second, confirmed start. */
export const mineruSetupDefinition = {
  kind: SETUP_KIND, version: 1, title: 'Local MinerU setup',
  capabilities: { cancel: true, retry: false },

  async admit(context, input, { seams }) {
    checkSetupRequest(input);
    if (!seams.cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
    const state = newSetupState(input);
    context.present(presentSetup(state));
    return { state };
  },

  async run(context, input, { seams, admitted }) {
    const { state } = context.admission;
    admitted?.();
    state.local = await runSetup(input, seams, { signal: context.signal, observe: observeLocalWith(context.gateway, 'setup', 'mineru'),
      onStep: name => { state.step = name; state.steps += 1; }, onLine: line => { state.lastLine = line; } });
    return { refs: [], completeness: 'complete' };
  },
};
