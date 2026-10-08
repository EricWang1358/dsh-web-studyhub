import { REPEAT_LIMIT } from '../../lib/coverage-run.js';
import { parseJson } from '../../lib/generation.js';

/* The run of the owner's report (「自动补到完整」 ticked, and the run still stopped at 92%): sections that do not come out in the planned round and come out in a later fill round, one more fill round
   for each, beside one section that never comes out. Built for the merged-transcript fixture (tests/helpers/merged-transcript.mjs: "Recording 1, part N, point ..." is the text of one section):
     parts 2 .. REPEAT_LIMIT       the HELPERS: the planner refuses them (「insufficient evidence」) until the fill round `freeFrom[part]` has started, then answers: part N comes out in fill round N - 1
     part REPEAT_LIMIT + 1         the STUCK section: it never comes out (the planner refuses it, or the test makes its review fail)
   Every fill round gains exactly one helper, so the run goes on after each fill round (a fill round that gains no section ends it: no-progress) until the stuck section has REPEAT_LIMIT failed attempts:
   its planned round and REPEAT_LIMIT - 1 fill rounds. Written against REPEAT_LIMIT, so the story moves with the constant. */
const PLAN = 'Plan a source-grounded assessment';

/** `{ stuck, helpers, freeFrom }` for a run that gives up on one section after `limit` failed attempts. `parts`: how many parts one recording of the fixture has. */
export function stuckRun({ limit = REPEAT_LIMIT, parts = 6 } = {}) {
  const stuck = limit + 1;
  if (stuck > parts) throw new Error(`The fixture has ${parts} parts per recording: the stuck section would be part ${stuck}; give the fixture more parts`);
  const freeFrom = {};
  for (let part = 2; part < stuck; part += 1) freeFrom[part] = part - 1;
  return { stuck, helpers: Object.keys(freeFrom).map(Number), freeFrom };
}

/** The fill rounds a draft's plan has started so far (running, done or failed). */
export const fillsStarted = rounds => (Array.isArray(rounds) ? rounds : []).filter(round => round.fill && round.status && round.status !== 'pending').length;

/**
 * A model wrapper for `library(t, { wrap })`: the planner refuses (「insufficient evidence」) every call that is shown a part of recording 1 whose fill round has not started yet.
 * `freeFrom`: { [part]: the fill round (1-based) from which the planner answers for it; Infinity: never }. A part that is not listed is never refused.
 */
export const refusePlannerUntilFill = freeFrom => (complete, service) => async (system, prompt, context = {}) => {
  if (system.startsWith(PLAN)) {
    const request = parseJson(prompt.split('REQUEST DATA:\n')[1]);
    const shown = request.sources.map(source => /Recording 1, part (\d+),/.exec(source.text)).filter(Boolean).map(match => Number(match[1]));
    if (shown.some(part => part in freeFrom)) {
      const rounds = (await service.call('export')).drafts[0]?.editorial?.coverageSpec?.rounds;
      const started = fillsStarted(rounds);
      if (shown.some(part => part in freeFrom && started < freeFrom[part])) return JSON.stringify({ error: 'insufficient evidence' });
    }
  }
  return complete(system, prompt, context);
};
