import { examBlueprintMaterial } from '../../../../exam-blueprint-material.js';
import { extractPrompt, mapPrompt, mergePoints, readMappings, readPoints, readQuestions, shapePrompt } from '../plan.js';
import { BLUEPRINT_FIELDS, freshState, presentBlueprint } from './blueprint-view.js';
import { BLUEPRINT_TITLE, FAILURES } from './messages.js';

export const EXAM_BLUEPRINT_KIND = 'exam-blueprint-build';
/** Every model call of a build is a Step of the gateway: direct, the learner's own model, usage booked under `other` (decision 9). */
const POLICY = Object.freeze({ purpose: 'plan', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct'] });
const REASK = '\n\nYour previous reply could not be read. Reply with the JSON only, exactly in the shape described.';
const PAPER_PLACES = 3;

const unreadable = (input, window, plan) => {
  const pages = window.slides.map(slide => slide.page).filter(Number.isInteger);
  const where = pages.length ? (input.language === 'en' ? ` (pages ${pages[0]}-${pages.at(-1)})` : `（第 ${pages[0]}–${pages.at(-1)} 页）`) : '';
  return Object.assign(new Error(FAILURES.unreadable(input.language, where)), { code: 'blueprint-window-unreadable', windows: plan.windows.length });
};

/** What a place the model named becomes, once the library's own resolver has found it: the same selection every citation carries. */
const evidenceOf = (selection, role) => ({ sourceId: selection.sourceId, quote: selection.quote, role,
  ...(selection.documentId ? { documentId: selection.documentId } : {}), ...(selection.revision ? { revision: selection.revision } : {}),
  ...(Number.isInteger(selection.page) ? { page: selection.page } : {}), start: selection.start, end: selection.end });

/**
 * One exam-blueprint build: lecture slides in windows (a checkpoint between them), the shape of the sample paper if one was chosen, then ONE blueprint material
 * saved through the materials context (lib/exam-blueprint-material.js). The queue, lifecycle, control, metering and the 任务 console are the runtime's; the plan,
 * the library and the model are the domain's (blueprint/plan.js, the bindings of the submit), and every model call is a Step of the gateway.
 * Not durable (decision 2): a stop or a failure keeps nothing, a retry starts again; a pause keeps the windows already read for the resume of this same Job.
 */
export const examBlueprintDefinition = {
  kind: EXAM_BLUEPRINT_KIND, version: 1, title: BLUEPRINT_TITLE, legacyFields: BLUEPRINT_FIELDS, capabilities: CAPABILITIES,
  legacyId: input => `blueprint-${input.runId}`,
  // Whole the moment submit returns: a second start, the list and the console find it at once.
  initialPresentation: (input, { blueprint }) => presentBlueprint(input, freshState(blueprint.plan)),

  async run(context, input, { blueprint: env }) {
    const { plan, kept } = env, state = freshState(plan), reader = presentBlueprint(input, state);
    // A pause keeps what was read for the resume of this Job; anything else (the first turn, a retry after a failure) starts from nothing and asks everything again.
    const resuming = kept.resumable === true;
    kept.resumable = false;
    if (!resuming) kept.results.clear();
    const show = () => { try { context.present(reader); } catch { /* the Attempt is over: nothing is left to show */ } };
    const boundary = ref => { kept.resumable = true; context.checkpoint(ref); kept.resumable = false; };
    const resolveOne = async (sourceId, quote) => {
      const answer = await env.resolve({ sourceId, quote });
      return answer?.status === 'resolved' ? answer.selection : answer?.status === 'ambiguous' ? answer.candidates?.[0] ?? null : null;
    };
    /** One model step: the answer kept from before (a resume) or asked for, asked once more when it cannot be read; `settle` turns a readable answer into what is kept. */
    const ask = async (key, stage, labels, { system, prompt }, read, settle) => {
      if (kept.results.has(key)) { await context.gateway.step(key, POLICY, { labels }).reuse('kept'); state.reused++; return kept.results.get(key); }
      for (let attempt = 0; attempt < 2; attempt++) {
        context.signal.throwIfAborted();
        const text = await context.gateway.step(attempt ? `${key}:r` : key, POLICY, { labels }).complete(system, attempt ? `${prompt}${REASK}` : prompt);
        const parsed = read(text);
        if (parsed) { const settled = await settle(parsed); kept.results.set(key, settled); return settled; }
      }
      return null;
    };

    state.stage = 'checking'; show();
    // Stage 1: the lecture slides, a window at a time. Every place a point names is found again by the library's own resolver; one it cannot find is dropped and counted.
    const found = [];
    for (const window of plan.windows) {
      boundary(`window:${window.number}`);
      state.stage = 'slides'; show();
      const role = plan.inputs[window.inputIndex].role;
      const result = await ask(window.key, 'slides', { stage: 'slides', part: window.number, parts: plan.windows.length }, extractPrompt(window, plan), text => readPoints(text, window), async read => {
        const points = [], dropped = { evidence: read.dropped.evidence, points: 0 };
        for (const point of read.points) {
          const evidence = [];
          for (const place of point.evidence) {
            const selection = await resolveOne(place.sourceId, place.quote);
            if (selection) evidence.push(evidenceOf(selection, role)); else dropped.evidence++;
          }
          if (evidence.length) points.push({ ...point, evidence }); else dropped.points++;
        }
        return { points, dropped };
      });
      if (!result) throw unreadable(input, window, plan);
      found.push(result.points);
      state.dropped.evidence += result.dropped.evidence; state.dropped.points += result.dropped.points;
      state.windows.done++; show();
    }
    const points = mergePoints(found);
    state.points = points.length;
    if (!points.length) throw Object.assign(new Error(FAILURES.noPoints(input.language)), { code: 'blueprint-no-points' });

    // Stages 2-3: the shape of the sample paper, and which points each of its questions reaches (only through points the slides gave).
    const ids = new Set(points.map(point => point.id)), questions = [], reached = new Map();
    for (const piece of plan.paperChunks) {
      boundary(`paper:${piece.number}`);
      state.stage = 'shape'; show();
      const shape = await ask(piece.shapeKey, 'shape', { stage: 'shape', part: piece.number, parts: plan.paperChunks.length }, shapePrompt(piece, plan), text => readQuestions(text, piece), async read => {
        const list = [];
        for (const question of read.questions) {
          const selection = question.sourceId ? await resolveOne(question.sourceId, question.quote) : null;
          const { sourceId: _sourceId, quote: _quote, ...rest } = question;
          list.push({ ...rest, ...(selection ? { evidence: evidenceOf(selection, 'past-paper') } : {}) });
        }
        return { questions: list };
      });
      state.paper.done++; show();
      if (!shape) throw Object.assign(new Error(FAILURES.unreadable(input.language, '')), { code: 'blueprint-window-unreadable' });
      for (const question of shape.questions) if (!questions.some(item => item.label === question.label)) questions.push(question);
      if (!shape.questions.length) { state.paper.done++; show(); continue; }
      boundary(`paper-map:${piece.number}`);
      state.stage = 'map'; show();
      const mapped = await ask(piece.mapKey, 'map', { stage: 'map', part: piece.number, parts: plan.paperChunks.length },
        mapPrompt(shape.questions.map(({ label, type, marks }) => ({ label, ...(type ? { type } : {}), ...(marks !== undefined ? { marks } : {}) })), points.map(({ id, title }) => ({ id, title })), plan),
        text => readMappings(text, shape.questions, ids), async read => ({ mappings: [...read.mappings] }));
      state.paper.done++; show();
      if (!mapped) throw Object.assign(new Error(FAILURES.unreadable(input.language, '')), { code: 'blueprint-window-unreadable' });
      for (const [label, pointIds] of mapped.mappings) if (!reached.has(label)) reached.set(label, pointIds);
    }
    const shape = plan.paperChunks.length ? { questions: questions.map(({ label, type, marks }) => ({ label, ...(type ? { type } : {}), ...(marks !== undefined ? { marks } : {}), pointIds: reached.get(label) ?? [] })),
      unmatched: questions.filter(question => !(reached.get(question.label)?.length)).map(question => question.label) } : undefined;
    if (shape) state.unmatched = shape.unmatched;
    for (const question of questions) for (const id of reached.get(question.label) ?? []) {
      const point = points.find(item => item.id === id);
      if (point && question.evidence && point.evidence.filter(place => place.role === 'past-paper').length < PAPER_PLACES) point.evidence.push(question.evidence);
    }

    // Stage 4: ONE material, saved through the materials context. Nothing was written before this point, so a stop or a failure leaves no half-made blueprint.
    state.stage = 'saving'; show();
    context.signal.throwIfAborted();
    const record = examBlueprintMaterial({ title: plan.title, courses: plan.course ? [plan.course] : [], ...(plan.scope ? { scope: plan.scope } : {}), language: plan.language,
      ...(plan.recommendedReading ? { recommendedReading: plan.recommendedReading } : {}), inputs: plan.inputs,
      points: points.map(({ id, title, requirement, evidence }) => ({ id, title, ...(requirement ? { requirement } : {}), evidence })), ...(shape ? { examShape: shape } : {}) });
    await env.ingest(record);
    state.stage = 'complete'; show();
    return { refs: [{ kind: 'source', id: record.id }], completeness: 'complete' };
  },
};
