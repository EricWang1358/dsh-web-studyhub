/* The wording the generation family says on its own account when the runtime (not the executor) ends or stops a job. Source text is the
   English the legacy path already used; the interface translates it like every other generation message. */

/** Why a run's workers were told to stop, by the stop reason the runtime gives (lib/jobs/lifecycle/settlement.js stop). */
export const STOP_MESSAGES = Object.freeze({
  'user-cancel': 'Generation cancelled; questions already saved to the draft are kept',
  unloaded: 'Generation stopped because the plugin was unloaded; approved content retained',
});

/** The label under which the runtime shows a generation run before the executor has said anything of its own. */
export const JOB_TITLES = Object.freeze({
  generation: 'Question generation',
  supplement: 'Supplement a deck',
});
