import { createHash } from 'node:crypto';
import { id as makeId } from '../../../util.js';
import { estimateRun } from '../../../token-estimate.js';
import { removeCompanionFiles, writeGeneratedCompanionFiles } from '../../../companion/companions.js';
import { estimateCalls, planCompanionBuild } from './plan.js';
import { COMPANION_LESSON_KIND } from './jobs/companion-lesson-build.js';
import { REFUSALS } from './jobs/messages.js';

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code] ? REFUSALS[code](language) : code), { code });

export const estimateOfCompanionPlan = plan => ({
  ...estimateRun('blueprint', { calls: estimateCalls(plan) }),
  calls: plan?.mode === 'rescue' ? { low: 1, high: 2 } : { low: 3, high: 4 },
});

export function createCompanionJobs(ports) {
  const { root, runtime, read, registerCompanion, work, activeJob } = ports;

  async function build(args = {}, request = {}) {
    const language = args.language === 'en' || args.uiLanguage === 'en' || request.language === 'en' ? 'en' : 'zh';
    const state = await read();
    if (!runtime?.jobs) throw refuse('capability-unverified', language);
    const plan = planCompanionBuild(state, { ...args, language });
    if (args.estimate === true) {
      return {
        status: 'estimate',
        estimate: estimateOfCompanionPlan(plan),
        steps: plan.steps,
        grounded: plan.grounded,
        scopeHash: plan.scopeHash,
      };
    }
    if (runtime.sharedQuota) throw refuse('capability-unverified', language);

    const running = [...work.jobs.values()].find(job => job.type === COMPANION_LESSON_KIND && activeJob(job) && job.scopeHash === plan.scopeHash);
    if (running) return { jobId: running.id, status: running.status, alreadyRunning: true };

    const input = {
      runId: makeId(),
      title: plan.title,
      language,
      scopeHash: plan.scopeHash,
    };

    const bindings = {
      companion: {
        plan,
        kept: { results: new Map(), planKey: null },
        saveGenerated: async ({ plan: buildPlan, lesson, html }) => {
          const companionId = `comp-${makeId()}`;
          const bytes = Buffer.byteLength(html, 'utf8');
          const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
          const files = await writeGeneratedCompanionFiles({
            workspace: buildPlan.workspace,
            root,
            companionId,
            course: buildPlan.course,
            slug: lesson.id || lesson.title,
            html,
            lesson,
          });
          try {
            return await registerCompanion({
              companionId,
              course: buildPlan.course,
              title: lesson.title,
              bytes,
              sha256,
              workspacePath: files.htmlPath,
              lessonJsonPath: files.jsonPath,
              lesson,
              lessonMode: buildPlan.mode || lesson.mode || 'full',
              ...(buildPlan.hid || lesson.hid ? { hid: buildPlan.hid || lesson.hid } : {}),
              ...(buildPlan.targetCardIds?.length || lesson.targetCardIds?.length
                ? { targetCardIds: buildPlan.targetCardIds?.length ? buildPlan.targetCardIds : lesson.targetCardIds }
                : {}),
              mountMode: buildPlan.mountMode,
              grounded: buildPlan.grounded,
            }, request);
          } catch (err) {
            await removeCompanionFiles(root, [companionId]).catch(() => {});
            throw err;
          }
        },
      },
    };

    try {
      const started = await runtime.jobs.submit(COMPANION_LESSON_KIND, input, {}, bindings);
      return { jobId: started.runtime.legacyId, status: 'running', steps: plan.steps, grounded: plan.grounded };
    } catch (error) {
      throw REFUSALS[error?.code] ? refuse(error.code, language) : error;
    }
  }

  return { 'generation.companion.build': build, 'companion.build': build };
}
