/* The task console's presentation of a one-click install (Marker, MinerU), whichever tool: its stages in order, the stage it is on, and the
   install's own state as the detail. `run` is the install slot's live run: its state is what the learner sees, from the same place Settings polls. */

const END_PHASE = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed', interrupted: 'failed' });

/** The steps of an install as the console's step list shows them (the Job and the legacy row alike): [{ id, name, state: done | active | failed | pending }].
 *  `status` is the install's (running, complete, failed, cancelled, interrupted); `nameOf(id)` the tool's words for a stage. */
export function installSteps({ stages, done = [], stage = '', status = 'running', nameOf }) {
  const finished = new Set(Array.isArray(done) ? done : []);
  return stages.map(id => ({ id, name: nameOf(id) || id,
    state: status === 'complete' || finished.has(id) ? 'done' : id === stage ? (status === 'failed' ? 'failed' : 'active') : 'pending' }));
}

/** The kernel's presentation reader for one install of one tool. `stageText(phase, state)` is the tool's words; `detailOf(state, phase)` its detail;
 *  `nameOf(id)` the name of a stage in the step list. */
export function installPresenter({ stages, title, codePrefix, stageText, detailOf, nameOf = id => id }) {
  const total = stages.length;
  return run => observed => {
    const { state } = run, phase = END_PHASE[observed.status] || state.stage, done = observed.status === 'complete' ? total : Math.max(0, stages.indexOf(phase));
    return { title,
      stage: { code: `${codePrefix}.${phase}`, text: stageText(phase, state) },
      progress: { done, total, unit: 'stages', percent: Math.floor(done * 100 / total), segments: [] },
      detail: { install: { ...detailOf(state, phase), steps: installSteps({ stages, done: state.done, stage: state.stage, status: observed.status, nameOf }) } } };
  };
}
