import { BLUEPRINT_LIMITS, examBlueprintMaterial } from '../../../../exam-blueprint-material.js';
import { SLIDE_PLACES } from '../constants.js';
import { capEvidence, capPoints, limitSlidePlaces, orderTree } from '../union.js';
import { noPoints, saveFailed, saveInvalid, unreadable } from './failures.js';
import { WHERE } from './messages.js';

/** The points as the list holds them, in the order of the course and inside the limits: the paper's points first when there are too many, at most `evidence` places of a point. */
function pointsOf(ctx, tree) {
  const { plan, state } = ctx;
  limitSlidePlaces(tree.points, SLIDE_PLACES);
  const rank = new Map(plan.windows.flatMap(window => window.slides).map((slide, index) => [slide.id, index]));
  const first = point => Math.min(Infinity, ...point.slidePlaces.map(place => rank.get(place.sourceId) ?? Infinity));
  // A point with no place at all (a paper question that could not be found in the paper, and no slide) cannot be shown and is counted.
  const bearing = new Set(tree.points.filter(point => point.slidePlaces.length || point.paperPlaces.length).map(point => point.id));
  const parentsKept = new Set(tree.points.filter(point => point.parentId && bearing.has(point.id)).map(point => point.parentId));
  const alive = tree.points.filter(point => bearing.has(point.id) || parentsKept.has(point.id));
  const capped = capPoints(alive, BLUEPRINT_LIMITS.points, first);
  state.dropped.points += tree.points.length - capped.length;
  return orderTree(capped, first).map(point => {
    const { evidence, left } = capEvidence(point.slidePlaces, point.paperPlaces, BLUEPRINT_LIMITS.evidence);
    state.dropped.places += left;
    return { id: point.id, title: point.title, ...(point.parentId ? { parentId: point.parentId } : {}), evidence };
  });
}

/** The list that is saved (at most 400 questions in its shape, only the points that are kept) and the windows of slides it did not read. */
function recordOf(ctx, points, shape) {
  const { plan, state } = ctx, kept = new Set(points.map(point => point.id));
  const examShape = plan.paperChunks.length ? { questions: shape.map(item => ({ ...item, pointIds: item.pointIds.filter(id => kept.has(id)) })) } : undefined;
  if (examShape) { examShape.unmatched = examShape.questions.filter(item => !item.pointIds.length).map(item => item.label); state.unmatched = examShape.unmatched; }
  const skippedWindows = state.skippedWindows.map(item => ({ pages: item.pages, slides: plan.windows.find(window => window.number === item.number).slides.length }));
  return examBlueprintMaterial({ title: plan.title, courses: plan.course ? [plan.course] : [], ...(plan.scope ? { scope: plan.scope } : {}), language: plan.language,
    ...(plan.supersedes ? { supersedes: plan.supersedes } : {}), ...(plan.recommendedReading ? { recommendedReading: plan.recommendedReading } : {}),
    inputs: plan.inputs, points, ...(examShape ? { examShape } : {}), ...(skippedWindows.length ? { skippedWindows } : {}) });
}

/**
 * Stage 5: the list, in the order of the course, saved as ONE material through the materials context. Nothing was written before this point, so a stop or a failure leaves no
 * half-made list. A failure here is in the learner's words, and the answers of the model stay kept: a retry saves without asking again.
 */
export async function finishBuild(ctx, base) {
  const { context, input, env, plan, state, show } = ctx;
  const points = pointsOf(ctx, base.tree);
  state.points = points.filter(point => !points.some(other => other.parentId === point.id)).length;
  if (!state.points) throw state.skippedWindows.length ? unreadable(input, WHERE.slides(input.language, '')) : noPoints(input);
  state.stage = 'saving'; show();
  context.signal.throwIfAborted();
  let record;
  try { record = recordOf(ctx, points, base.shape); } catch (cause) { throw saveInvalid(input, cause); }
  try { await env.ingest(record, plan.supersedes); } catch (cause) { throw context.signal.aborted ? cause : saveFailed(input, cause); }
  state.targetId = record.id; state.stage = 'complete'; show();
  return { refs: [{ kind: 'exam-point-list', id: record.id }], completeness: state.skippedWindows.length ? 'partial' : 'complete' };
}
