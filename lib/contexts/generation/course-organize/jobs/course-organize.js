import { runCourseOrganize } from '../organize.js';

export const COURSE_ORGANIZE_KIND = 'course-organize';
export const COURSE_ORGANIZE_FIELDS = Object.freeze([
  'runId', 'course', 'organizeMode', 'linksAdded', 'termsExtracted', 'termsCached', 'termsSkippedNoModel', 'termsNote', 'skippedReasons',
]);

// Model-backed: term extraction calls the model, so the job runs on the live agent's executor like every other model job (a host-executor job may not call a model).
const CAPABILITIES = Object.freeze({
  cancel: true,
  set: false,
  retry: false,
  pauseMode: 'unsupported',
  recoveryMode: 'none',
  executionModes: ['direct'],
});

/** One extraction call: a Step of the job's gateway on the host's light lane, unhedged for batch work (as a coach batch, lib/contexts/coach/jobs/light-step.js). */
const TERMS_POLICY = Object.freeze({
  purpose: 'extract',
  feature: 'other',
  requestedEffort: 'low',
  executionMode: 'direct',
  budget: null,
});

function stageLabel(language, stage, state) {
  const en = language === 'en';
  if (stage === 'queued') return en ? 'Queued to organize prerequisites and terms' : '等待整理前置依赖与生词';
  if (stage === 'cancelled') return en ? 'Cancelled (completed links and terms kept)' : '已取消（已写入的前置与生词已保留）';
  if (stage === 'prereqs') return en ? `Linking prerequisite cards (${state.linksAdded} added)` : `正在整理前置依赖（已新增 ${state.linksAdded} 条）`;
  if (stage === 'terms') return en ? `Extracting card terms (${state.termsExtracted} cards)` : `正在预提取生词（已完成 ${state.termsExtracted} 题）`;
  if (stage === 'done' || stage === 'complete') {
    if (state.termsNote === 'no-model') {
      return en
        ? `Done: ${state.linksAdded} prerequisite link(s) added; term extraction skipped (no model configured)`
        : `已完成：新增 ${state.linksAdded} 条前置链接；未配置模型，生词预提取已跳过`;
    }
    return en
      ? `Done: ${state.linksAdded} prerequisite link(s) added, ${state.termsExtracted} card(s) terms cached`
      : `已完成：新增 ${state.linksAdded} 条前置链接，预提取 ${state.termsExtracted} 题生词`;
  }
  return en ? 'Organizing course prerequisites and terms' : '正在整理课程前置依赖与生词';
}

export const freshOrganizeState = (input) => ({
  stage: 'queued',
  course: input.course,
  mode: input.mode || 'all',
  done: 0,
  total: 1,
  linksAdded: 0,
  termsExtracted: 0,
  termsCached: 0,
  termsSkippedNoModel: 0,
  skipped: [],
  skippedReasons: {},
  termsNote: '',
});

export function presentCourseOrganizeJob(input, state) {
  return observed => {
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete'
      : status === 'cancelled' ? 'cancelled'
      : status === 'queued' ? 'queued'
      : state.stage;
    const total = Math.max(1, Number(state.total) || 1);
    const done = status === 'complete' ? total : Math.min(total, Math.max(0, Number(state.done) || 0));
    return {
      title: input.title,
      stage: {
        code: `course-organize.${stage}`,
        text: status === 'failed' ? (error?.message ?? '') : stageLabel(input.language, stage, state),
      },
      progress: {
        done,
        total,
        unit: 'items',
        percent: Math.round((done / total) * 100),
        segments: [],
      },
      detail: {
        course: state.course,
        mode: state.mode,
        linksAdded: state.linksAdded,
        termsExtracted: state.termsExtracted,
        termsCached: state.termsCached,
        termsSkippedNoModel: state.termsSkippedNoModel,
        skipped: state.skipped,
        skippedReasons: state.skippedReasons,
        ...(state.termsNote ? { termsNote: state.termsNote } : {}),
      },
      legacy: {
        runId: input.runId,
        course: state.course,
        organizeMode: state.mode,
        linksAdded: state.linksAdded,
        termsExtracted: state.termsExtracted,
        termsCached: state.termsCached,
        termsSkippedNoModel: state.termsSkippedNoModel,
        ...(state.termsNote ? { termsNote: state.termsNote } : {}),
        skippedReasons: state.skippedReasons,
      },
    };
  };
}

export const courseOrganizeDefinition = {
  kind: COURSE_ORGANIZE_KIND,
  version: 1,
  title: 'Organize prerequisites and terms',
  legacyFields: COURSE_ORGANIZE_FIELDS,
  capabilities: CAPABILITIES,
  legacyId: input => `course-organize-${input.runId}`,
  initialPresentation: (input) => presentCourseOrganizeJob(input, freshOrganizeState(input)),

  async run(context, input, { organize: env }) {
    const state = freshOrganizeState(input);
    context.present(presentCourseOrganizeJob(input, state));

    const snapshot = await env.read();
    // Every model call is a Step of this job's gateway, numbered in the order the extraction asks.
    let asked = 0;
    const ask = env.hasModel
      ? (system, prompt) => context.gateway.step(`terms:${++asked}`, TERMS_POLICY, { model: 'light', hedge: false }).complete(system, prompt)
      : null;

    const result = await runCourseOrganize({
      state: snapshot,
      course: input.course,
      mode: input.mode || 'all',
      ask,
      applyLink: (candidate) => env.applyLink(candidate),
      saveCardTerms: (deckId, cardId, record) => env.saveCardTerms(deckId, cardId, record),
      signal: context.signal,
      onProgress: (progress) => {
        Object.assign(state, progress);
        context.present(presentCourseOrganizeJob(input, state));
      },
    });

    Object.assign(state, {
      stage: 'done',
      linksAdded: result.linksAdded,
      termsExtracted: result.termsExtracted,
      termsCached: result.termsCached,
      termsSkippedNoModel: result.termsSkippedNoModel,
      skipped: result.skipped,
      skippedReasons: result.skippedReasons,
      termsNote: result.termsNote,
    });
    context.present(presentCourseOrganizeJob(input, state));
    return { refs: [], completeness: result.termsNote === 'no-model' ? 'partial' : 'complete' };
  },
};
