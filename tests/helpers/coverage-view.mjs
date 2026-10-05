/* The answer of `coverage.get` for a draft, built from REAL coverage numbers of a small transcript (3 recordings of 4 parts, a checklist of covered and failed sections), so the
   screens that show coverage are rendered from the same numbers the backend computes. A page rendered outside the app cannot ask the backend, so a test seeds the answer
   into the page's own memo (ui/coverage/use-coverage.js seedCoverage) under the key the page asks with: the draft id and `${data.revision}:${draft.draftVersion}`. */
import { coverageOf } from '../../lib/coverage.js';
import { planRound } from '../../lib/coverage-round.js';
import { plainCoverage } from '../../lib/coverage-state.js';
import { transcriptFixture } from './coverage-fixture.mjs';

export const small = transcriptFixture({ recordings: 3, parts: 4, paragraphs: 2 });

const rangeOf = section => ({ sourceId: section.sourceId, start: section.start, end: section.end });

/**
 * `covered`: section ids with a question; `failed`: section ids that were planned and did not come out (with `reason`); `recorded: false` is a draft from before plans were kept.
 * -> the view and, for convenience, the sources it was made over.
 */
export function draftView({ draftId = 'd1', draftVersion = 3, covered = [], failed = [], reason = 'review-protocol', recorded = true, canTopUp = true, material = small } = {}) {
  const sources = material.sources, leaf = id => material.leaves.find(section => section.id === id);
  const targets = failed.map((id, index) => { const section = leaf(id), quote = material.quoteIn(section), start = material.textOf(section.sourceId).indexOf(quote, section.start);
    return { targetId: `t${index}`, objective: `Objective ${id}`, knowledge: `Knowledge ${id}`, sourceId: section.sourceId, quote, start, end: start + quote.length, status: 'failed', reason }; });
  const partPlans = recorded && failed.length ? [{ part: 1, sourceIds: [...new Set(failed.map(id => leaf(id).sourceId))], ranges: failed.map(id => rangeOf(leaf(id))), targets, status: 'failed', reason, attempts: 1 }]
    : recorded ? [{ part: 1, sourceIds: [sources[0].id], ranges: [rangeOf(leaf(covered[0] || material.ids[0]))], targets: [], status: 'passed', attempts: 1 }] : [];
  const coverage = coverageOf({ sources, cards: covered.map(id => material.card(leaf(id))), partPlans, targets: true });
  return { status: 'ok', scope: 'draft', draftId, draftVersion, canTopUp, coverage: plainCoverage(coverage), round: planRound(coverage) };
}

/** Seed the view into the memo of a bundle that exports `seedCoverage` (a test's own esbuild bundle of the page). */
export const seedView = (m, view, { revision } = {}) => m.seedCoverage({ draftId: view.draftId }, `${revision}:${view.draftVersion}`, view);
