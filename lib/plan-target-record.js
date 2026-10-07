import { buildPartPlans } from './plan-record.js';
import { nameOf } from './part-plan.js';
import { PLAN_TARGET_LIMITS, clip } from './plan-targets.js';

/* The run's side of lib/plan-targets.js: the compact record of the knowledge points the plans of a running generation hold (lib/batch.js tells it to the job). It reads the plan record of the
   draft (lib/plan-record.js buildPartPlans), so it belongs to the backend; the console reads only lib/plan-targets.js. */

/** The reference to a source as a row shows it: its id, its title (a PDF page is its book) and its page. */
function refOf(sourceId, pieces) {
  const piece = (Array.isArray(pieces) ? pieces : []).find((item) => item?.id === sourceId);
  if (!piece) return { sourceId };
  const { name, page } = nameOf(piece), title = clip(name, PLAN_TARGET_LIMITS.title);
  return { sourceId, ...(title ? { title } : {}), ...(Number.isInteger(page) ? { page } : {}) };
}

/**
 * What a run has planned and what became of it, from the pieces lib/batch.js has at hand: `planned` the parts ({ sources, count, short? }), `outcomes`, `plans` (part index -> { targets }), `tries`, `notes`
 * (as buildPartPlans takes them) and `locators`, a cache of quote locators that lives as long as the run (so announcing again does not index the text again).
 * -> { list, short }
 */
export function planTargetsOf({ planned, outcomes, plans, tries, notes, locators }) {
  const records = buildPartPlans({ planned, outcomes, plans, runs: tries, notes, locators }), list = [], short = [];
  records.forEach((record, index) => {
    for (const target of record.targets) {
      const state = target.status === 'kept' ? 'kept' : target.status === 'failed' ? 'failed' : target.reason && target.reason !== 'pending' ? 'omitted' : 'planned';
      list.push({ part: record.part, id: target.targetId, objective: target.objective, ...(target.sourceId ? { source: refOf(target.sourceId, planned[index]?.sources) } : {}),
        ...(Number.isInteger(target.start) ? { at: target.start } : {}), state, ...(state === 'failed' || state === 'omitted' ? { reason: target.reason } : {}) });
    }
    if (record.short?.length) {
      const needed = record.short.reduce((sum, item) => sum + (item.needed || 0), 0), got = record.short.reduce((sum, item) => sum + (item.got || 0), 0);
      short.push({ part: record.part, needed, got });
    }
  });
  return { list, short };
}
