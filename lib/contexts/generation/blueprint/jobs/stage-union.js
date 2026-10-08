import { BLUEPRINT_LIMITS } from '../../../../exam-blueprint-material.js';
import { PAPER_PLACES } from '../constants.js';
import { mergePrompt } from '../prompts.js';
import { readMerge } from '../read.js';
import { candidatesOf, questionKey, repairGroups, uniqueLabel, unionPoints } from '../union.js';
import { briefOf } from './stage-context.js';

/** The questions of the papers as the list shows them: a label each that is unique inside its paper, the points they reach; the places of the papers go onto the points. */
function shapeOf(papers, questionCandidates, united, byId, state) {
  const shape = [], taken = new Map();
  for (const paper of papers) for (const question of paper.questions) {
    if (!taken.has(paper.key)) taken.set(paper.key, new Set());
    const label = uniqueLabel(taken.get(paper.key), question.label);
    const ids = [...new Set((questionCandidates.get(questionKey(paper.key, question)) ?? []).map(id => united.idOfCandidate.get(id)))];
    // The list holds at most BLUEPRINT_LIMITS.questions questions in its shape; what does not fit is counted. Its points still count.
    if (shape.length < BLUEPRINT_LIMITS.questions) {
      shape.push({ paper: paper.key, label, ...(question.type ? { type: question.type } : {}), ...(question.marks !== undefined ? { marks: question.marks } : {}), pointIds: ids });
    } else state.dropped.questions++;
    if (!question.evidence) continue;
    for (const id of ids) {
      const point = byId.get(id);
      if (point.paperPlaces.filter(item => item.paper === paper.key).length < PAPER_PLACES) point.paperPlaces.push({ paper: paper.key, place: question.evidence });
    }
  }
  return shape;
}

/**
 * Stage 2: the union of the points of the papers. Identical titles are one candidate (the program); when the points come from more than one chunk of paper the model may join
 * synonyms; the program checks the answer and every candidate stays.
 * @returns { tree, byId, shape, listed, ids }: the tree of points (with the places of the papers), the shape of the papers, the points as the slide pass is asked about them
 */
export async function unitePapers(ctx, papers) {
  const { plan, state, ask, show, boundary } = ctx;
  const { candidates, questionCandidates } = candidatesOf(papers);
  let groups = null;
  if (plan.mergeNeeded) {
    boundary('merge');
    state.stage = 'merge'; show();
    if (candidates.length > 1) {
      const joined = await ask(plan.mergeKey, { stage: 'merge' }, mergePrompt(candidates.map(briefOf), plan), readMerge, async read => read);
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
  const byId = new Map(tree.points.map(point => [point.id, point]));
  const shape = shapeOf(papers, questionCandidates, united, byId, state);
  const listed = united.leaves.map(leaf => ({ id: leaf.id, title: leaf.title, ...(leaf.parentId ? { parent: byId.get(leaf.parentId).title } : {}) }));
  return { tree, byId, shape, listed, ids: new Set(listed.map(point => point.id)) };
}
