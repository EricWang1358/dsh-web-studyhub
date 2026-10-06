import { SETUP_TEXT } from '../../../mineru-setup-text.js';

export const SETUP_KIND = 'mineru-setup';
const END_STEP = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed', interrupted: 'failed' });
const RUN_STATUS = Object.freeze({ queued: 'running', running: 'running', cancelling: 'running', complete: 'complete', cancelled: 'cancelled',
  failed: 'failed', interrupted: 'failed' });

/** What one Attempt knows while it runs. The run writes it, the presentation reads it; it lives on the admission lease. */
export const newSetupState = ({ tier, modelsMb, step }) => ({ tier, modelsMb, step, steps: 0, lastLine: '', local: null });

/** The kernel's presentation reader for one setup. How many steps there are depends on this computer (a stopped service, models already there), so there is no total. */
export function presentSetup(state) {
  return observed => {
    const step = END_STEP[observed.status] || state.step;
    return { title: SETUP_TEXT.title(state.tier), stage: { code: `mineru.setup.${step}`, text: SETUP_TEXT.stage(step, state) },
      progress: { done: state.steps, total: null, unit: 'steps', percent: observed.status === 'complete' ? 100 : null, segments: [] },
      detail: { setup: { tier: state.tier, modelsMb: state.modelsMb, step: state.step, lastLine: state.lastLine, local: state.local } } };
  };
}

/** The shape mineru.local.setup(.status) has always answered, read from the job's public contract. */
export function setupView(contract) {
  const detail = contract.detail.setup ?? {};
  return { id: contract.runtime.legacyId, status: RUN_STATUS[contract.status], tier: detail.tier, step: END_STEP[contract.status] ?? detail.step, startedAt: contract.startedAt,
    lastLine: detail.lastLine ?? '', modelsMb: detail.modelsMb, ...(contract.finishedAt ? { finishedAt: contract.finishedAt } : {}),
    ...(detail.local ? { state: detail.local } : {}), ...(contract.error ? { error: String(contract.error.message).slice(0, 400) } : {}) };
}
