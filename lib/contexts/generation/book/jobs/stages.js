import { NOTES_LIMITS, courseNotesMaterial, sameNotes } from '../../../../course-book.js';
import { partialPrint } from '../../../../course-book-reading.js';
import { makeAsk } from '../../blueprint/jobs/ask.js';
import { organiseOutline } from '../../outline/jobs/course-outline-build.js';
import { freshState } from '../../outline/jobs/outline-view.js';
import { bridgePrompt, notesPrompt, examPrompt } from '../prompts.js';
import { readBridges, readExam, readNotes } from '../read.js';
import { bridgeWork, notesWork } from '../work.js';
import { FAILURES, WHERE } from './messages.js';

/* The stages of one review book attempt: the outline when it is needed (the outline build's own stages), the explanations (a call per few leaves), exam notes (a call per
   batch of tested leaves), and ONE write. Each call is asked through `ask` (blueprint/jobs/ask.js): answered from the calls this Job finished before, else asked,
   once more when unreadable. Nothing is written before the last stage, so a stop or a failure leaves nothing half made. */

const coded = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const kept = async read => read;

/** Stage 1 (only when the outline is missing, out of date or marked by other papers): the outline build's stages; its record is held for the last write. */
export async function outlineStage(ctx) {
  const { context, plan, state, show, boundary, kept: store, input } = ctx;
  if (!plan.outlinePlan) return { record: plan.outline, held: null };
  let held = null;
  const sub = freshState(plan.outlinePlan);
  state.outline = sub; state.stage = 'outline'; show();
  await organiseOutline({ context, input: { language: input.language }, plan: plan.outlinePlan, state: sub, show, boundary,
    ask: makeAsk(context, store, sub), env: { ingest: async (record, replaces) => { held = { record, replaces }; } } });
  state.reused += sub.reused;
  return { record: held.record, held };
}

/** The work of the notes against the outline the first stage made (planned up front when the outline was kept). */
export function workOf(ctx, outline) {
  // A copy: an attempt fills its leaves in, and a retry starts from the plan again.
  const { plan, state } = ctx;
  const work = plan.work && outline === plan.outline ? structuredClone(plan.work)
    : notesWork(plan.state, plan.documents, outline, plan.previous, plan.language, { coverage: plan.coverage, point: plan.point });
  state.notes.total = work.bodyBatches.length; state.exam.total = work.examBatches.length;
  return work;
}

/** A big point read in passes, once its passes are answered: the parts in page order, the cites numbered through them, the ranges read. A pass the model did not
    answer leaves its pages out (the point counts as missed and its fingerprint matches no reading, so the next 更新全书 asks it again); none answered: as a leaf
    not answered. */
function settlePasses(item, state) {
  const answers = item.passes.map((_, k) => item.answers?.[k] ?? null), done = answers.flatMap((answer, k) => (answer ? [k] : []));
  if (!done.length) { state.missed++; if (item.earlier) item.body = item.earlier; return; }
  const parts = [], cites = [], extra = [], read = [];
  item.passes.forEach((pass, k) => {
    const answer = answers[k];
    if (!answer) return;
    const offset = cites.length, shift = text => text.replace(/\[\^(\d{1,2})\]/g, (_, n) => `[^${Number(n) + offset}]`);
    cites.push(...answer.cites.map(cite => ({ ...cite, n: cite.n + offset })));
    parts.push({ ranges: pass.labels, points: answer.points.map(shift), explain: shift(answer.explain), ...(answer.example ? { example: shift(answer.example) } : {}) });
    for (const text of answer.extra) if (!extra.includes(text) && extra.length < NOTES_LIMITS.extra) extra.push(text);
    read.push(...pass.pieces.map(piece => ({ sourceId: piece.sourceId, start: piece.start, end: piece.end })));
  });
  const whole = done.length === item.passes.length;
  item.body = { fingerprint: whole ? item.fingerprint : partialPrint(item.fingerprint, done), points: [], explain: '', ...(extra.length ? { extra } : {}), parts, cites, read,
    ...(item.replaces ? { replaces: item.replaces } : {}) };
  state.written++;
  if (!whole) state.missed++;
}

/** Stage 2: the explanations, a few leaves a call (a big point one call per pass). A leaf the model did not answer has none (counted; the next 更新全书 asks it again). */
export async function bodyStage(ctx, work) {
  const { plan, state, ask, show, boundary, input } = ctx;
  for (const batch of work.bodyBatches) {
    boundary(`notes:${batch.number}`);
    state.stage = 'notes'; show();
    const answer = await ask(batch.key, { stage: 'notes', part: batch.number, parts: work.bodyBatches.length }, notesPrompt(batch, plan), text => readNotes(text, batch), kept);
    if (!answer) throw coded('course-book-unreadable', FAILURES.unreadable(input.language, WHERE.notes(input.language, batch.number)));
    if (batch.pass !== undefined) {
      const item = work.items[batch.leafAt], leaf = answer.leaves.get(0);
      (item.answers ||= [])[batch.pass] = leaf ?? null;
      if (leaf) state.dropped += leaf.dropped;
      state.notes.done++; show();
      continue;
    }
    batch.items.forEach((item, at) => {
      const leaf = answer.leaves.get(at);
      // Not answered: the earlier explanation stays (shown as out of date) rather than none.
      if (!leaf) { state.missed++; if (item.earlier) item.body = item.earlier; return; }
      const { dropped, ...body } = leaf;
      item.body = { fingerprint: item.fingerprint, ...body, ...(item.replaces ? { replaces: item.replaces } : {}) };
      state.dropped += dropped; state.written++;
    });
    state.notes.done++; show();
  }
  for (const item of work.items) if (item.needsBody && item.passes) settlePasses(item, state);
}

/** Stage 2b: the bridges (过渡句) between the points of each chapter, once the explanations are known: only the points whose own or neighbours' title or summary
    changed, at most BRIDGES_PER_CALL a call. A point not answered keeps no bridge (shown without one; the next 更新全书 asks it again). The explanations are
    never rewritten for it. */
export async function bridgeStage(ctx, work) {
  const { plan, state, ask, show, boundary, input } = ctx;
  const { batches } = bridgeWork(work.items, plan.language);
  state.bridge.total = batches.length; show();
  for (const batch of batches) {
    boundary(`bridge:${batch.number}`);
    state.stage = 'bridge'; show();
    const answer = await ask(batch.key, { stage: 'bridge', part: batch.number, parts: batches.length }, bridgePrompt(batch, plan), text => readBridges(text, batch), kept);
    if (!answer) throw coded('course-book-unreadable', FAILURES.unreadable(input.language, WHERE.bridge(input.language, batch.number)));
    batch.items.forEach((item, at) => {
      const own = answer.bridges.get(at);
      if (own) item.bridge = { fingerprint: item.bridgeFingerprint, ...own };
    });
    state.bridge.done++; show();
  }
}

/** Stage 3 (only with sample papers): 考情 of the leaves whose paper places changed; a leaf no paper tests needed no call. */
export async function examStage(ctx, work) {
  const { plan, state, ask, show, boundary, input } = ctx;
  for (const batch of work.examBatches) {
    boundary(`exam:${batch.number}`);
    state.stage = 'exam'; show();
    const answer = await ask(batch.key, { stage: 'exam', part: batch.number, parts: work.examBatches.length }, examPrompt(batch, plan), text => readExam(text, batch), kept);
    if (!answer) throw coded('course-book-unreadable', FAILURES.unreadable(input.language, WHERE.exam(input.language, batch.number)));
    batch.items.forEach((item, at) => {
      const note = answer.notes.get(at);
      item.exam = { fingerprint: item.examFingerprint, tested: true, ...(note ? { note } : {}), ...(item.examReplaces ? { replaces: item.examReplaces } : {}) };
      state.examWritten++;
    });
    state.exam.done++; show();
  }
}

/** Stage 4: the outline (when this build made it) and the notes in ONE write; the ones they replace are archived in the same write. Nothing is written when nothing changed. */
export async function saveStage(ctx, work, outline, held) {
  const { context, plan, state, show, env, input } = ctx;
  state.stage = 'saving'; show();
  context.signal.throwIfAborted();
  const leaves = work.items.map(item => ({ id: item.id, title: item.title, anchors: item.anchors, ...(item.body ? { body: item.body } : {}),
    ...(item.bridge ? { bridge: item.bridge } : {}), ...(item.exam ? { exam: item.exam } : {}) }));
  Object.assign(state, { leaves: leaves.filter(leaf => leaf.body).length, kept: work.items.filter(item => !item.needsBody).length,
    empty: work.items.filter(item => item.body?.empty).length });
  let record;
  try {
    record = courseNotesMaterial({ title: plan.title, course: plan.course, language: plan.language, outlineId: outline.id, leaves,
      ...(work.papers.length ? { papers: work.papers.map(paper => ({ key: paper.key, ...(paper.fingerprint ? { fingerprint: paper.fingerprint } : {}) })) } : {}),
      counts: { written: state.written, reused: state.kept, examWritten: state.examWritten, examReused: work.items.filter(item => item.exam && !item.needsExam).length,
        dropped: state.dropped, missed: state.missed, empty: state.empty }, ...(plan.previous ? { supersedes: plan.previous.id } : {}) });
  } catch (cause) { throw coded('course-book-save-invalid', FAILURES.saveInvalid(input.language), cause); }
  if (!held && sameNotes(record.courseNotes, plan.previous?.courseNotes)) {
    Object.assign(state, { unchanged: true, targetId: plan.previous.id, stage: 'complete' }); show();
    return { refs: [{ kind: 'course-book', id: plan.previous.id, course: plan.course }], completeness: 'complete' };
  }
  const archive = [held?.replaces, plan.previous?.id].filter(id => id && id !== record.id && id !== held?.record.id);
  try { await env.ingest([...(held ? [held.record] : []), record], archive); } catch (cause) {
    throw context.signal.aborted ? cause : coded('course-book-save-failed', FAILURES.saveFailed(input.language), cause);
  }
  state.targetId = record.id; state.stage = 'complete'; show();
  return { refs: [{ kind: 'course-book', id: record.id, course: plan.course, ...(held ? { outlineId: held.record.id } : {}) }], completeness: 'complete' };
}
