import { parseJson } from '../../../../generation.js';
import { compileLessonHtml } from '../../../../companion-template/render-html.js';
import { normalizeLessonSpec, validateLessonSpec } from '../../../../companion-template/validate.js';
import {
  normalizeSandboxMathExpr,
  preRepairLessonSpec,
  preRepairLessonWithReport,
} from '../../../../companion/companion-lesson.js';
import { slugifyName } from '../../../../companion/companions.js';
import { makeAsk } from '../../blueprint/jobs/ask.js';
import { act1Prompt, act2Prompt, blueprintPrompt, repairLessonPrompt } from '../prompts.js';
import { COMPANION_JOB_TITLE, REFUSALS, stageText } from './messages.js';

export { normalizeSandboxMathExpr, preRepairLessonSpec, preRepairLessonWithReport };

export const COMPANION_LESSON_KIND = 'companion-lesson-build';
export const COMPANION_FIELDS = Object.freeze(['runId', 'scopeHash', 'companionStage']);

const CAPABILITIES = Object.freeze({
  cancel: true,
  set: false,
  retry: true,
  pauseMode: 'checkpoint',
  recoveryMode: 'none',
  executionModes: ['direct'],
  retryKeeps: 'completed',
  stopKeeps: 'completed',
});

const readJsonObject = text => {
  try {
    const parsed = parseJson(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const freshCompanionState = plan => ({
  stage: 'queued',
  course: plan.course,
  doneSteps: 0,
  totalSteps: 4,
  reused: 0,
  preRepaired: false,
  repaired: false,
  slideCount: 0,
  companionId: null,
});

export function presentCompanionJob(input, state) {
  return observed => {
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete'
      : status === 'cancelled' ? 'cancelled'
      : status === 'paused' ? 'paused'
      : status === 'queued' ? 'queued'
      : state.stage;
    return {
      title: input.title,
      stage: {
        code: `companion.${stage}`,
        text: status === 'failed' ? (error?.message ?? '') : stageText(input.language, stage),
      },
      progress: {
        done: status === 'complete' ? state.totalSteps : state.doneSteps,
        total: state.totalSteps,
        unit: 'steps',
        percent: Math.round(((status === 'complete' ? state.totalSteps : state.doneSteps) / state.totalSteps) * 100),
        segments: [],
      },
      detail: {
        course: state.course,
        companionId: state.companionId,
        slideCount: state.slideCount,
        reused: state.reused,
        preRepaired: state.preRepaired,
        repaired: state.repaired,
      },
      legacy: {
        runId: input.runId,
        scopeHash: input.scopeHash,
        companionStage: stage,
      },
    };
  };
}

function failWith(code, language = 'zh', detail = '') {
  const base = REFUSALS[code] ? REFUSALS[code](language) : code;
  const err = new Error(detail ? `${base} (${detail})` : base);
  err.code = code;
  return err;
}

export const companionLessonDefinition = {
  kind: COMPANION_LESSON_KIND,
  version: 1,
  title: COMPANION_JOB_TITLE,
  legacyFields: COMPANION_FIELDS,
  capabilities: CAPABILITIES,
  legacyId: input => `companion-${input.runId}`,
  initialPresentation: (input, { companion }) => presentCompanionJob(input, freshCompanionState(companion.plan)),

  async run(context, input, { companion: env }) {
    const { plan, kept } = env;
    const state = freshCompanionState(plan);
    if (kept.planKey !== plan.planKey) {
      kept.results.clear();
      kept.planKey = plan.planKey;
    }
    const reader = presentCompanionJob(input, state);
    const show = () => { try { context.present(reader); } catch { /* ended */ } };
    const ask = makeAsk(context, kept, state, { feature: 'generate' });

    // Stage 1: Pedagogical Blueprint
    state.stage = 'blueprint';
    show();
    const bp = await ask(
      'companion:blueprint',
      { stage: 'plan' },
      blueprintPrompt(plan),
      text => {
        const obj = readJsonObject(text);
        return obj && typeof obj.title === 'string' && Array.isArray(obj.act1Slides) && Array.isArray(obj.act2Slides) ? obj : null;
      },
      obj => obj,
    );
    if (!bp) throw failWith('companion-blueprint-failed', input.language);
    state.doneSteps = 1;
    show();
    await context.checkpoint('blueprint');

    // Stage 2A: Author Act I (first half of slides)
    state.stage = 'act1';
    show();
    const act1 = await ask(
      'companion:act1',
      { stage: 'author', part: 1, parts: 2 },
      act1Prompt(plan, bp),
      text => {
        const obj = readJsonObject(text);
        return Array.isArray(obj?.slides) && obj.slides.length >= 4 ? obj.slides : null;
      },
      slides => slides,
    );
    if (!act1) throw failWith('companion-author-failed', input.language);
    state.doneSteps = 2;
    show();
    await context.checkpoint('act1');

    // Stage 2B: Author Act II (second half of slides)
    state.stage = 'act2';
    show();
    const act2 = await ask(
      'companion:act2',
      { stage: 'author', part: 2, parts: 2 },
      act2Prompt(plan, bp, act1),
      text => {
        const obj = readJsonObject(text);
        return Array.isArray(obj?.slides) && obj.slides.length >= 4 ? obj.slides : null;
      },
      slides => slides,
    );
    if (!act2) throw failWith('companion-author-failed', input.language);
    state.doneSteps = 3;
    show();
    await context.checkpoint('act2');

    // Stage 3: Assemble, Run Deterministic Pre-Repair, Evaluate Sandbox Math, Validate 18 Rules & Model-Repair only if still needed
    state.stage = 'verify';
    show();
    let assembled = {
      format: 'studyhub-lesson/1',
      template: bp.archetype || 'interactive',
      language: plan.language,
      id: slugifyName(bp.id || bp.title || plan.displayTopic, 'interactive-lesson'),
      course: plan.course,
      title: String(bp.title || plan.displayTopic).trim(),
      lead: String(bp.lead || '').trim(),
      minutes: Number(bp.minutes) || 25,
      needs: Array.isArray(bp.needs) ? bp.needs : [],
      after: Array.isArray(bp.after) ? bp.after : [],
      terms: bp.terms && typeof bp.terms === 'object' ? bp.terms : {},
      slides: [...act1, ...act2],
    };

    const preReport = preRepairLessonWithReport(assembled);
    assembled = preReport.lesson;
    if (preReport.fixes.length > 0) state.preRepaired = true;

    let check;
    try {
      assembled = normalizeLessonSpec(assembled);
      check = validateLessonSpec(assembled, { strictPedagogy: true });
    } catch (err) {
      check = { ok: false, errors: [err.message] };
    }

    if (!check.ok) {
      state.stage = 'repair';
      show();
      const repaired = await ask(
        'companion:repair',
        { stage: 'repair' },
        repairLessonPrompt(assembled, check.errors, plan.language),
        text => {
          const obj = readJsonObject(text);
          if (!obj || !Array.isArray(obj.slides)) return null;
          try {
            const preCleaned = preRepairLessonSpec({ ...assembled, ...obj, course: plan.course, language: plan.language });
            const normObj = normalizeLessonSpec(preCleaned);
            const recheck = validateLessonSpec(normObj, { strictPedagogy: true });
            return recheck.ok ? normObj : null;
          } catch {
            return null;
          }
        },
        obj => obj,
      );
      if (!repaired) {
        const structural = (() => {
          try {
            const normObj = normalizeLessonSpec(assembled);
            return validateLessonSpec(normObj, { strictPedagogy: false }).ok ? normObj : null;
          } catch { return null; }
        })();
        if (!structural) throw failWith('companion-validation-failed', input.language, check.errors.slice(0, 4).join('; '));
        assembled = structural;
      } else {
        assembled = repaired;
        state.repaired = true;
      }
    }

    // Stage 4: Compile Standalone HTML (with Offline MathML) & Register in Course
    state.stage = 'saving';
    show();
    const compiled = compileLessonHtml(assembled, { strictPedagogy: false });
    const saved = await env.saveGenerated({
      plan,
      lesson: compiled.lesson,
      html: compiled.html,
    });
    state.companionId = saved.companion.id;
    state.slideCount = compiled.lesson.slides.length;
    state.doneSteps = 4;
    show();

    return {
      refs: [
        { kind: 'companion', id: saved.companion.id, course: plan.course, title: saved.companion.title },
        ...(saved.sourceId ? [{ kind: 'source', id: saved.sourceId }] : []),
      ],
      completeness: 'complete',
    };
  },
};
