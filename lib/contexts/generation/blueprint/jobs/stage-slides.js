import { createHash } from 'node:crypto';
import { mergePrompt, slidesPrompt } from '../prompts.js';
import { readMerge, readSlides } from '../read.js';
import { addExtra, candidatesOfExtras, repairGroups, uniteExtraCandidates } from '../union.js';
import { briefOf, evidenceOf } from './stage-context.js';

/** What a window of slides gave, once every place is found again by the library's own resolver: a place that cannot be found is counted in `unresolved`, not in `evidence`. */
function settleWindow(ctx, role) {
  const { resolveOne } = ctx;
  return async read => {
    const dropped = { evidence: read.dropped.evidence, unresolved: 0, points: 0 }, found = [], extra = [];
    const placed = async place => {
      const selection = await resolveOne(place.sourceId, place.quote);
      if (!selection) dropped.unresolved++;
      return selection && evidenceOf(selection, role);
    };
    for (const item of read.evidence) { const place = await placed(item); if (place) found.push({ pointId: item.pointId, place }); }
    for (const point of read.extra) {
      const evidence = (await Promise.all(point.evidence.map(placed))).filter(Boolean);
      if (evidence.length) extra.push({ title: point.title, ...(point.parent ? { parent: point.parent } : {}), evidence }); else dropped.points++;
    }
    return { found, extra, dropped };
  };
}

/**
 * Stage 3: the lecture slides, a window at a time: the places of the united points, and what the slides teach that no paper reached.
 * A window the model cannot answer after two tries is skipped and recorded (the list is then marked partial); it does not void the build.
 * @returns the extra points of all windows, in window order: [{ title, parent?, evidence, window }]
 */
export async function readWindows(ctx, base) {
  const { plan, state, ask, show, boundary } = ctx, extras = [];
  for (const window of plan.windows) {
    boundary(`window:${window.number}`);
    state.stage = 'slides'; show();
    const labels = { stage: 'slides', part: window.number, parts: plan.windows.length };
    const role = plan.inputs[window.inputIndex].role;
    const result = await ask(window.key, labels, slidesPrompt(window, base.listed, plan), text => readSlides(text, window, base.ids), settleWindow(ctx, role));
    if (!result) state.skippedWindows.push({ number: window.number, pages: window.slides.map(slide => slide.page).filter(Number.isInteger) });
    else {
      for (const { pointId, place } of result.found) base.byId.get(pointId)?.slidePlaces.push(place);
      extras.push(...result.extra.map(extra => ({ ...extra, window: window.number })));
      for (const [name, count] of Object.entries(result.dropped)) state.dropped[name] += count;
    }
    state.windows.done++; show();
  }
  return extras;
}

/**
 * Stage 4: the extra points of the windows are united (titles and parents only) by the same machinery as the points of the papers: the program joins
 * identical titles, the model may join synonyms across windows, the program checks the answer; then each united point joins the tree.
 */
export async function uniteExtras(ctx, base, extras) {
  const { plan, state, ask, show, boundary } = ctx;
  const candidates = candidatesOfExtras(extras);
  let groups = null;
  if (plan.extraMergeNeeded) {
    boundary('extras');
    state.stage = 'mergeExtra'; show();
    if (candidates.length > 1 && new Set(extras.map(extra => extra.window)).size > 1) {
      // The answer is kept under the candidates it was asked about: if a window is read differently on a retry, the model is asked again.
      const key = `${plan.extraMergeKey}:${createHash('sha1').update(JSON.stringify(candidates.map(briefOf))).digest('hex').slice(0, 12)}`;
      const joined = await ask(key, { stage: 'merge' }, mergePrompt(candidates.map(briefOf), plan), readMerge, async read => read);
      groups = joined?.groups ?? null;
    }
    state.merge.done++; show();
  }
  for (const extra of uniteExtraCandidates(candidates, repairGroups(groups, candidates.map(candidate => candidate.id)).groups)) addExtra(base.tree, extra);
}
