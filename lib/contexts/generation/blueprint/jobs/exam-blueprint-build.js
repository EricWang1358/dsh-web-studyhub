import { examBlueprintMaterial } from '../../../../exam-blueprint-material.js';
import { mergePrompt, paperPrompt, readMerge, readPaper, readSlides, slidesPrompt } from '../plan.js';
import { addExtra, candidatesOf, orderTree, repairGroups, unionPoints } from '../union.js';
import { BLUEPRINT_FIELDS, freshState, presentBlueprint } from './blueprint-view.js';
import { BLUEPRINT_TITLE, FAILURES, WHERE } from './messages.js';

export const EXAM_BLUEPRINT_KIND = 'exam-blueprint-build';
/** Every model call of a build is a Step of the gateway: direct, the learner's own model, usage booked under `other`. */
const POLICY = Object.freeze({ purpose: 'plan', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct'] });
const REASK = '\n\nYour previous reply could not be read. Reply with the JSON only, exactly in the shape described.';
const PAPER_PLACES = 2, SLIDE_PLACES = 3;

const unreadable = (input, where) => Object.assign(new Error(FAILURES.unreadable(input.language, where)), { code: 'blueprint-window-unreadable' });

/** What a place the model named becomes, once the library's own resolver has found it: the same selection every citation carries. */
const evidenceOf = (selection, role) => ({ sourceId: selection.sourceId, quote: selection.quote, role,
  ...(selection.documentId ? { documentId: selection.documentId } : {}), ...(selection.revision ? { revision: selection.revision } : {}),
  ...(Number.isInteger(selection.page) ? { page: selection.page } : {}), start: selection.start, end: selection.end });

/**
 * One 考点清单 build, bottom-up (plan revision 5): the chosen sample papers are read first (what each question tests, in two levels), the points of several papers are united (the model may
 * join synonyms, the program checks nothing is lost), the lecture slides are read in windows for the places of those points and for what the papers did not reach, and ONE material is saved
 * through the materials context (lib/exam-blueprint-material.js). The queue, lifecycle, control, metering and the 任务 console are the runtime's; the plan, the library and the model are the
 * domain's (blueprint/plan.js, blueprint/union.js, the bindings of the submit), and every model call is a Step of the gateway.
 * Not durable: a stop or a failure keeps nothing and a retry starts again; a pause keeps what was read for the resume of this same Job.
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
    const ask = async (key, labels, { system, prompt }, read, settle) => {
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
    // 1. The sample papers: what each question tests. A question whose quote is not in the paper keeps its points but has no place to show, so it cannot make them 必学.
    const papers = [];
    for (const piece of plan.paperChunks) {
      boundary(`paper:${piece.number}`);
      state.stage = 'paper'; show();
      const result = await ask(piece.askKey, { stage: 'paper', part: piece.number, parts: plan.paperChunks.length }, paperPrompt(piece, plan), text => readPaper(text, piece), async read => {
        const questions = [];
        for (const { sourceId, quote, ...question } of read.questions) {
          const selection = sourceId ? await resolveOne(sourceId, quote) : null;
          questions.push({ ...question, ...(selection ? { evidence: evidenceOf(selection, 'past-paper') } : {}) });
        }
        return { questions, unverified: questions.filter(question => !question.evidence).length };
      });
      if (!result) throw unreadable(input, WHERE.paper(input.language));
      papers.push({ key: piece.key, questions: result.questions });
      state.dropped.questions += result.unverified; state.papers.done++; show();
    }

    // 2. The union. Identical titles are one candidate (the program); the model may join synonyms; the program checks the answer and every candidate stays.
    const { candidates, questionCandidates } = candidatesOf(papers);
    let groups = null;
    if (plan.mergeNeeded) {
      boundary('merge');
      state.stage = 'merge'; show();
      if (candidates.length > 1) {
        const joined = await ask(plan.mergeKey, { stage: 'merge' }, mergePrompt(candidates.map(({ id, title, parent }) => ({ id, title, ...(parent ? { parent } : {}) })), plan), readMerge, async read => read);
        groups = joined?.groups ?? null; // an answer that cannot be read leaves the program's union as it is
      }
      state.merge.done++; show();
    }
    const checked = repairGroups(groups, candidates.map(candidate => candidate.id));
    if (plan.mergeNeeded) state.mergeRepaired = checked.repaired;
    const united = unionPoints(candidates, checked.groups);
    const tree = { next: united.next, points: [
      ...united.leaves.map(leaf => ({ id: leaf.id, title: leaf.title, ...(leaf.parentId ? { parentId: leaf.parentId } : {}), slidePlaces: [], paperPlaces: [], papers: leaf.papers })),
      ...united.bigs.map(big => ({ id: big.id, title: big.title, slidePlaces: [], paperPlaces: [], papers: [] }))] };
    const shape = [];
    for (const paper of papers) for (const question of paper.questions) {
      if (shape.some(item => item.paper === paper.key && item.label === question.label)) continue;
      const ids = [...new Set((questionCandidates.get(`${paper.key}\u0000${question.label}`) ?? []).map(id => united.idOfCandidate.get(id)))];
      shape.push({ paper: paper.key, label: question.label, ...(question.type ? { type: question.type } : {}), ...(question.marks !== undefined ? { marks: question.marks } : {}), pointIds: ids });
      if (!question.evidence) continue;
      for (const id of ids) {
        const point = tree.points.find(item => item.id === id);
        if (point.paperPlaces.filter(item => item.paper === paper.key).length < PAPER_PLACES) point.paperPlaces.push({ paper: paper.key, place: question.evidence });
      }
    }

    // 3. The lecture slides, a window at a time: the places of the united points, and what the slides teach that no paper reached (补充). Every place is found again by the library's own resolver.
    const rank = new Map(plan.windows.flatMap(window => window.slides).map((slide, index) => [slide.id, index]));
    const listed = united.leaves.map(leaf => ({ id: leaf.id, title: leaf.title, ...(leaf.parentId ? { parent: tree.points.find(point => point.id === leaf.parentId).title } : {}) }));
    const ids = new Set(listed.map(point => point.id));
    for (const window of plan.windows) {
      boundary(`window:${window.number}`);
      state.stage = 'slides'; show();
      const role = plan.inputs[window.inputIndex].role;
      const result = await ask(window.key, { stage: 'slides', part: window.number, parts: plan.windows.length }, slidesPrompt(window, listed, plan), text => readSlides(text, window, ids), async read => {
        const dropped = { evidence: read.dropped.evidence, points: 0 }, found = [], extra = [];
        const placed = async place => { const selection = await resolveOne(place.sourceId, place.quote); if (!selection) dropped.evidence++; return selection && evidenceOf(selection, role); };
        for (const item of read.evidence) { const place = await placed(item); if (place) found.push({ pointId: item.pointId, place }); }
        for (const point of read.extra) {
          const evidence = (await Promise.all(point.evidence.map(placed))).filter(Boolean);
          if (evidence.length) extra.push({ title: point.title, ...(point.parent ? { parent: point.parent } : {}), evidence }); else dropped.points++;
        }
        return { found, extra, dropped };
      });
      if (!result) {
        const pages = window.slides.map(slide => slide.page).filter(Number.isInteger);
        throw unreadable(input, WHERE.slides(input.language, pages.length ? (input.language === 'en' ? `pages ${pages[0]}-${pages.at(-1)}` : `第 ${pages[0]}–${pages.at(-1)} 页`) : ''));
      }
      for (const { pointId, place } of result.found) {
        const point = tree.points.find(item => item.id === pointId);
        if (point && point.slidePlaces.length < SLIDE_PLACES && !point.slidePlaces.some(item => item.sourceId === place.sourceId && item.quote === place.quote)) point.slidePlaces.push(place);
      }
      for (const extra of result.extra) addExtra(tree, extra);
      state.dropped.evidence += result.dropped.evidence; state.dropped.points += result.dropped.points;
      state.windows.done++; show();
    }

    // 4. The list, in the order of the course. A point with no place at all (a paper question that could not be found in the paper, and no slide) cannot be shown and is counted.
    const first = point => Math.min(Infinity, ...point.slidePlaces.map(place => rank.get(place.sourceId) ?? Infinity));
    const bearing = new Set(tree.points.filter(point => point.slidePlaces.length || point.paperPlaces.length).map(point => point.id));
    const parentsKept = new Set(tree.points.filter(point => point.parentId && bearing.has(point.id)).map(point => point.parentId));
    const alive = tree.points.filter(point => bearing.has(point.id) || parentsKept.has(point.id));
    state.dropped.points += tree.points.length - alive.length;
    const sorted = orderTree(alive, first);
    const points = sorted.map(point => ({ id: point.id, title: point.title, ...(point.parentId ? { parentId: point.parentId } : {}),
      evidence: [...point.slidePlaces.slice(0, SLIDE_PLACES), ...point.paperPlaces.map(item => item.place)] }));
    state.points = points.filter(point => !points.some(other => other.parentId === point.id)).length;
    if (!state.points) throw Object.assign(new Error(FAILURES.noPoints(input.language)), { code: 'blueprint-no-points' });
    const kept_ = new Set(points.map(point => point.id));
    const examShape = plan.paperChunks.length ? { questions: shape.map(item => ({ ...item, pointIds: item.pointIds.filter(id => kept_.has(id)) })) } : undefined;
    if (examShape) { examShape.unmatched = examShape.questions.filter(item => !item.pointIds.length).map(item => item.label); state.unmatched = examShape.unmatched; }

    // 5. ONE material, saved through the materials context. Nothing was written before this point, so a stop or a failure leaves no half-made list.
    state.stage = 'saving'; show();
    context.signal.throwIfAborted();
    const record = examBlueprintMaterial({ title: plan.title, courses: plan.course ? [plan.course] : [], ...(plan.scope ? { scope: plan.scope } : {}), language: plan.language,
      ...(plan.recommendedReading ? { recommendedReading: plan.recommendedReading } : {}), inputs: plan.inputs, points, ...(examShape ? { examShape } : {}) });
    await env.ingest(record);
    state.stage = 'complete'; show();
    return { refs: [{ kind: 'source', id: record.id }], completeness: 'complete' };
  },
};
