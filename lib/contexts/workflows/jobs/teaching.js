import { withJobUsage } from '../../../usage-scope.js';
import { WORKFLOW_FIELDS, presentWorkflow, stopMessage } from './workflow-view.js';
import { preferAgent } from '../../../jobs/gateway-policy.js';
import { WORKFLOW_MESSAGES } from './messages.js';

export const TEACHING_KIND = 'workflow-teaching';
/** The author and the independent review are the two kinds of call of a teaching: each its own Step, numbered in the order they are asked. */
const ROLES = Object.freeze({ author: 'author', review: 'review' });
const POLICY = Object.freeze({ feature: 'flow', requestedEffort: 'default', executionMode: 'direct', budget: null });

/** One teaching of a step: a written article and its independent review. The session, the step's record, the citation and quality checks and the guard
 * against a changed step stay with the learning workflow (`runTeaching`, the domain's finish); this Job runs the generation: its stop signal, Calls and usage. */
export const teachingDefinition = {
  kind: TEACHING_KIND, version: 1, title: WORKFLOW_MESSAGES.teachingTitle, legacyFields: WORKFLOW_FIELDS,
  capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct', 'subagent'] },

  admit(context, input) {
    context.present(presentWorkflow({ kind: 'teaching', job: input.job }, WORKFLOW_MESSAGES.teaching));
    return { state: {} };
  },

  async run(context, input, { runs, live, agent }) {
    const policy = preferAgent(POLICY, agent), asked = { author: 0, review: 0 };
    // What the teaching used rides on the live job and, once saved, on the step's teaching record.
    const ask = role => (system, prompt) => withJobUsage(live, undefined,
      () => context.gateway.step(`${role}:${++asked[role]}`, { ...policy, purpose: role }).complete(system, prompt));
    const execution = { run: generate => generate({ author: ask(ROLES.author), review: ask(ROLES.review) }),
      describe: error => stopMessage(context.signal, WORKFLOW_MESSAGES.timeout) ?? (error.message || WORKFLOW_MESSAGES.teachingFailed) };
    const { failure } = await runs.teaching(live, input.input, execution);
    if (failure) throw new Error(failure);
    return { refs: [], completeness: 'complete' };
  },
};
