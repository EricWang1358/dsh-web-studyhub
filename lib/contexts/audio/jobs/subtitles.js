import { assertTextModel } from '../../../audio-job.js';
import { subtitlePlan } from '../../../subtitle-job.js';
import { subtitleNotice } from '../../../audio-messages.js';
import { writeLetter } from './notifications.js';
import { audioFacade } from './view.js';
import { presentSubtitle, subtitleView, SUBTITLE_FIELDS } from './subtitle-view.js';
import { runSubtitles } from './subtitles-run.js';

/**
 * A downloaded subtitle file proofread and translated into a bilingual transcript, as a job of the unified runtime. The cues exist only in memory
 * (nothing is saved to resume from after a restart, as before), so it can be retried while the process lives and cannot be paused or recovered;
 * what it already proofread and translated is kept in the audio cache, so a retry only does the rest. Its letter and announcement are written when it
 * settles, by the services of whoever submitted it (the bindings).
 */
export const subtitlesDefinition = {
  kind: 'audio-subtitles', version: 1, title: 'Subtitle import', legacyFields: SUBTITLE_FIELDS,
  capabilities: { cancel: true, set: false, retry: true, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct', 'subagent'] },
  notifications: [
    { channel: 'inbox', deliver: (_event, contract, { worker }) => writeLetter(worker, audioFacade(contract)) },
    { channel: 'session', deliver: (_event, contract, { worker }) => worker.notify?.(subtitleNotice(audioFacade(contract), contract.detail.legacy?.language)) },
  ],

  async admit(context, input, { worker }) {
    const settings = await worker.audioSettings();
    assertTextModel(settings, worker.complete);
    const plan = subtitlePlan({ input: input.input, args: input.args, settings });
    const view = subtitleView(plan, { language: worker.language, settings });
    context.present(presentSubtitle(view));
    return { state: { view, plan, settings, args: input.args } };
  },

  run: (context, _input, binding) => runSubtitles(context, binding),
};
