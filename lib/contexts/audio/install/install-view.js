/* The task console's presentation of a one-click install (Marker, MinerU), whichever tool: its stages in order, the stage it is on, and the
   install's own state as the detail. `run` is the install slot's live run: its state is what the learner sees, from the same place Settings polls. */

const END_PHASE = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed', interrupted: 'failed' });

/** The kernel's presentation reader for one install of one tool. `stageText(phase, state)` is the tool's words; `detailOf(state, phase)` its detail. */
export function installPresenter({ stages, title, codePrefix, stageText, detailOf }) {
  const total = stages.length;
  return run => observed => {
    const { state } = run, phase = END_PHASE[observed.status] || state.stage, done = observed.status === 'complete' ? total : Math.max(0, stages.indexOf(phase));
    return { title,
      stage: { code: `${codePrefix}.${phase}`, text: stageText(phase, state) },
      progress: { done, total, unit: 'stages', percent: Math.floor(done * 100 / total), segments: [] },
      detail: { install: detailOf(state, phase) } };
  };
}
