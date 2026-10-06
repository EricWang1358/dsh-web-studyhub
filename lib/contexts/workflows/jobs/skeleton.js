import { WORKFLOW_FIELDS, presentWorkflow, stopMessage } from './workflow-view.js';
import { WORKFLOW_MESSAGES } from './messages.js';

export const SKELETON_KIND = 'workflow-skeleton';
const POLICY = Object.freeze({ purpose: 'plan', feature: 'flow', requestedEffort: 'default', executionMode: 'direct', budget: null });
const AGENT_POLICY = Object.freeze({ ...POLICY, executionMode: 'agent-preferred' });

/** The knowledge skeleton of a session's scope, written in the background while the learner goes on. The saved skeleton and its link to the session stay
 * with the learning workflow (`runSkeleton`, the domain's finish); this Job runs the generation: its stop signal, Calls and usage. */
export const skeletonDefinition = {
  kind: SKELETON_KIND, version: 1, title: WORKFLOW_MESSAGES.skeletonTitle, legacyFields: WORKFLOW_FIELDS,
  capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct', 'subagent'] },

  admit(context, input) {
    context.present(presentWorkflow({ kind: 'skeleton', job: input.job }, WORKFLOW_MESSAGES.skeleton));
    return { state: {} };
  },

  async run(context, input, { runs, live, agent }) {
    let asked = 0;
    const policy = agent ? AGENT_POLICY : POLICY;
    const complete = (system, prompt) => context.gateway.step(`skeleton:${++asked}`, policy).complete(system, prompt);
    const execution = { run: generate => generate(complete),
      describe: error => stopMessage(context.signal, WORKFLOW_MESSAGES.skeletonTimeout) ?? (error.message || WORKFLOW_MESSAGES.skeletonFailed) };
    const { failure, skeleton } = await runs.skeleton(live, input.input, execution);
    if (failure) throw new Error(failure);
    return skeleton ? { refs: [{ kind: 'skeleton', id: skeleton.id }], completeness: 'complete' } : { refs: [], completeness: 'partial' };
  },
};
