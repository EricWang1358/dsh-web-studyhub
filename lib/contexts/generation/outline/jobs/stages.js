import { createHash } from 'node:crypto';
import { courseOutlineMaterial } from '../../../../course-outline-book.js';
import { mapPrompt, paperPrompt, reducePoints, reducePrompt } from '../prompts.js';
import { readMap, readPaper, readReduce } from '../read.js';
import { assemble, leavesOf, markPapers, pointsOf } from '../tree.js';
import { FAILURES, WHERE } from './messages.js';

/* The stages of one attempt: map (a call per batch of materials), reduce (one call), papers (a call per chunk of sample paper), save (one write).
   Each call is asked through `ask` (blueprint/jobs/ask.js): answered from the calls this Job finished before, else asked, once more when unreadable. */

const coded = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const kept = async read => read;

/** Stage 1: every batch of material descriptors becomes knowledge points. A batch the model cannot answer twice fails the build (a retry asks it again). */
export async function mapStage(ctx) {
  const { plan, state, ask, show, boundary, input } = ctx, answers = [];
  for (const batch of plan.batches) {
    boundary(`map:${batch.number}`);
    state.stage = 'map'; show();
    const answer = await ask(batch.key, { stage: 'map', part: batch.number, parts: plan.batches.length }, mapPrompt(batch, plan), readMap, kept);
    if (!answer) throw coded('course-outline-unreadable', FAILURES.unreadable(input.language, WHERE.map(input.language, batch.number)));
    answers.push(answer);
    state.map.done++; show();
  }
  return pointsOf(plan, answers);
}

/** Stage 2: the points become chapters and sections. The answer is kept under the points it was asked about (a batch read differently asks again). */
export async function reduceStage(ctx, mapped) {
  const { plan, state, ask, show, boundary, input } = ctx;
  boundary('reduce');
  state.stage = 'reduce'; show();
  const points = reducePoints(mapped.points);
  const answer = await ask(`co:reduce:${short(points)}`, { stage: 'reduce' }, reducePrompt(points, plan), readReduce, kept);
  if (!answer) throw coded('course-outline-unreadable', FAILURES.unreadable(input.language, WHERE.reduce(input.language)));
  state.reduce.done++; show();
  const outline = assemble(plan, mapped, answer);
  if (!outline.nodes.length) throw coded('course-outline-empty', FAILURES.empty(input.language));
  return outline;
}

/** Stage 3 (only with sample papers): each chunk of paper marks the leaves its questions test, by quotes found in the paper. */
export async function paperStage(ctx, outline) {
  const { plan, state, ask, show, boundary, input } = ctx;
  if (!plan.paperChunks.length) return;
  const leaves = leavesOf(outline.nodes), shown = leaves.map(item => ({ id: item.alias, title: item.node.title, ...(item.path.length ? { under: item.path.join(' › ') } : {}) }));
  const results = [];
  for (const chunk of plan.paperChunks) {
    boundary(`paper:${chunk.number}`);
    state.stage = 'paper'; show();
    const answer = await ask(`${chunk.key}:${short(shown)}`, { stage: 'paper', part: chunk.number, parts: plan.paperChunks.length }, paperPrompt(chunk, shown, plan),
      text => readPaper(text, chunk), kept);
    if (!answer) throw coded('course-outline-unreadable', FAILURES.unreadable(input.language, WHERE.paper(input.language)));
    results.push({ paper: chunk.paper, questions: answer.questions });
    state.unverified += answer.unverified;
    state.papers.done++; show();
  }
  state.invalid += markPapers(leaves, results);
}

/** Stage 4: ONE record saved through the materials context. Nothing was written before, so a stop or a failure leaves nothing half made. */
export async function saveStage(ctx, outline) {
  const { context, plan, state, show, env, input } = ctx;
  Object.assign(state, { stage: 'saving', units: outline.counts.units, leftover: outline.counts.leftover, invalid: state.invalid + outline.counts.invalid,
    repeated: outline.counts.repeated, merged: outline.counts.merged, chapters: outline.nodes.length, leaves: leavesOf(outline.nodes).length });
  show();
  context.signal.throwIfAborted();
  let record;
  try {
    record = courseOutlineMaterial({ title: plan.title, course: plan.course, language: plan.language, orderBasis: outline.orderBasis, nodes: outline.nodes, other: outline.other,
      ...(plan.papers.length ? { papers: plan.papers } : {}), fingerprint: plan.fingerprint, ...(plan.supersedes ? { supersedes: plan.supersedes } : {}),
      counts: { units: outline.counts.units, leftover: outline.counts.leftover, invalid: state.invalid, repeated: outline.counts.repeated } });
  } catch (cause) { throw coded('course-outline-save-invalid', FAILURES.saveInvalid(input.language), cause); }
  try { await env.ingest(record, plan.supersedes); } catch (cause) {
    throw context.signal.aborted ? cause : coded('course-outline-save-failed', FAILURES.saveFailed(input.language), cause);
  }
  state.targetId = record.id; state.stage = 'complete'; show();
  return { refs: [{ kind: 'course-outline', id: record.id, course: plan.course }], completeness: 'complete' };
}
