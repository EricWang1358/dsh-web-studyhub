import { id as makeId } from '../../../util.js';
import { currentCourse } from '../../../focus.js';
import { ORGANIZE_MODES } from './contracts.js';
import { CARD_TERMS_MAX_CALLS } from '../../study/contracts.js';
import { planCourseOrganize } from './organize.js';
import { COURSE_ORGANIZE_KIND } from './jobs/course-organize.js';
import { REFUSALS } from './jobs/messages.js';

/** A refusal of the runtime (no live executor, shared quota, plugin closing) in the learner's words, keeping its code. */
const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });

/** `hasModel`: whether the job's own gateway has a model to call. The job never receives a model port of the request that started it:
 * it runs after that request has returned, and every call it makes is a Step of its gateway (on its record, in the usage ledger). */
export function createCourseOrganizeJobs(ports) {
  const { runtime, read, work, activeJob, hasModel, applyLink, saveCardTerms } = ports;

  async function start(args = {}, request = {}) {
    const language = args.language === 'en' || args.uiLanguage === 'en' || request.language === 'en' ? 'en' : 'zh';
    const mode = ORGANIZE_MODES.includes(args.mode) ? args.mode : 'all';
    const state = await read();
    const courseName = typeof args.course === 'string' && args.course.trim()
      ? args.course.trim()
      : (currentCourse(state) || '');
    if (!courseName) {
      throw new Error(language === 'en' ? 'Please specify a course to organize.' : '请先指定要整理的课程。');
    }

    const plan = planCourseOrganize(state, courseName);
    const modelAvailable = typeof hasModel === 'function' ? Boolean(hasModel()) : Boolean(hasModel);
    // The questions whose terms a model would extract in this mode; each is asked once, and once more when its reply is unreadable.
    const termCards = modelAvailable && mode !== 'prereqs' ? plan.uncachedTermCards.length : 0;
    const preview = {
      course: plan.course,
      decks: plan.decks.length,
      totalCards: plan.totalCards,
      candidateLinks: plan.linkCandidates.length,
      uncachedTermCards: plan.uncachedTermCards.length,
      cachedTermCards: plan.cachedTermCards,
      hasModel: modelAvailable,
      modelCalls: { low: termCards, high: termCards * CARD_TERMS_MAX_CALLS },
    };

    if (args.dryRun === true) {
      return { status: 'preview', course: plan.course, hasModel: modelAvailable, preview };
    }

    if (!runtime?.jobs) {
      throw new Error(language === 'en' ? 'Background job runtime is unavailable.' : '后台任务运行时不可用。');
    }

    const running = [...work.jobs.values()].find(
      job => job.type === COURSE_ORGANIZE_KIND && activeJob(job) && job.course === plan.course,
    );
    if (running) {
      return { jobId: running.id, status: running.status, course: plan.course, alreadyRunning: true, hasModel: modelAvailable, preview };
    }

    const input = {
      runId: makeId(),
      course: plan.course,
      mode,
      language,
      title: language === 'en' ? `Organize ${plan.course}` : `整理「${plan.course}」前置与生词`,
    };

    const bindings = {
      organize: {
        read,
        hasModel: modelAvailable,
        applyLink,
        saveCardTerms,
      },
    };

    let started;
    try {
      started = await runtime.jobs.submit(COURSE_ORGANIZE_KIND, input, {}, bindings);
    } catch (error) {
      if (REFUSALS[error?.code]) throw refuse(error.code, language);
      throw error;
    }
    return {
      jobId: started.runtime.legacyId,
      status: 'running',
      course: plan.course,
      hasModel: modelAvailable,
      preview,
    };
  }

  return {
    'course.organize.start': start,
    'generation.courseOrganize.start': start,
  };
}
