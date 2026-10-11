import { createHash } from 'node:crypto';
import { policyOf } from '../../inventory/policy.js';
import { REPAIR_ROUNDS } from '../constants.js';
import { judge, openIssues } from '../coverage.js';
import { repairPrompt, reviewPrompt, writePrompt } from '../prompts.js';
import { readDraft, readReview } from '../read.js';
import { readOf } from '../sources.js';

/* The knowledge points, written in parallel (the attempt's one pool, inventory/parallel.js): each unit of a point (the point, or a pass of a big one) is
   written from its pages and checklist, then reviewed by an independent call (another brief, the review's reasoning level), and the program judges it
   (book/coverage.js). A unit that fails is repaired with the issues named and reviewed again, at most REPAIR_ROUNDS times; a unit still failing is kept and
   marked short with what it misses (never claimed complete). A point whose writing call failed keeps its earlier explanation (shown out of date) and is
   asked again by the next build; a point that was short is mended: reviewed and repaired from its text, not written again. */

const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/** One unit: write (or take the earlier text), then review -> repair -> review ... -> { draft, verdict, repaired } or { failed: true }. */
async function unitChain(ctx, item, unit, where, policies) {
  const { parallel, plan, state } = ctx, base = [item.fingerprint, unit.n];
  const labels = (stage, round) => ({ stage, part: where.number, parts: where.total, ...(round ? { round } : {}), file: item.title.slice(0, 120) });
  const earlier = item.mode === 'mend' && item.body.units[unit.n - 1]?.text ? item.body.units[unit.n - 1] : null;
  // A unit that passed before is kept as it is (no call): mending asks only what is short or was never written.
  // A unit left short by an earlier build is kept too unless the learner asked to fill the gaps (补漏): nothing changed, so a rerun makes no call.
  if (earlier?.status === 'ok' || (earlier?.status === 'short' && !item.asked)) {
    const missing = earlier.status === 'ok' ? [] : unit.checklist.filter(entry => entry.priority === 'must' && !earlier.covered.includes(entry.id));
    return { draft: { text: earlier.text, cites: earlier.cites, claimed: earlier.covered, dropped: 0 }, kept: true, repaired: 0,
      verdict: { pass: earlier.status === 'ok', reviewed: true, covered: earlier.covered, missing, blocking: [], issues: [] } };
  }
  let draft = earlier ? { text: earlier.text, cites: earlier.cites, claimed: earlier.covered, dropped: 0 }
    : await parallel.ask(`cb:write:${short(base)}`, labels('write'), policies.write, writePrompt(unit, item, plan), text => readDraft(text, unit));
  if (!draft) return { failed: true };
  state.dropped += draft.dropped;
  let verdict = null, repaired = 0;
  for (let round = 0; ; round++) {
    const review = await parallel.ask(`cb:review:${short([...base, round, draft.text])}`, labels('review', round), policies.review, reviewPrompt(unit, item, draft, plan),
      text => readReview(text, unit));
    state.calls.review++;
    verdict = judge(unit, draft, review, round);
    if (verdict.pass || !review || round >= REPAIR_ROUNDS) break;
    const fixed = await parallel.ask(`cb:repair:${short([...base, round, draft.text])}`, labels('repair', round + 1), policies.repair,
      repairPrompt(unit, item, draft, { ...verdict, round: round + 1 }, plan), text => readDraft(text, unit));
    state.calls.repair++;
    if (!fixed) break;
    draft = fixed; repaired++; state.dropped += fixed.dropped;
  }
  return { draft, verdict, repaired };
}

/** The point's body from its units' results: a unit whose writing failed is kept pending (its must items missing; the next build writes it alone); null when none was written. */
export function bodyOf(item, results) {
  if (results.every(result => result.failed)) return null;
  const pending = unit => ({ pass: false, reviewed: true, covered: [], missing: unit.checklist.filter(entry => entry.priority === 'must'), blocking: [], issues: [] });
  const verdicts = item.units.map((unit, at) => (results[at].failed ? pending(unit) : results[at].verdict));
  const units = item.units.map((unit, at) => (results[at].failed ? { text: '', cites: [], covered: [], read: readOf(unit.segments), status: 'pending' }
    : { text: results[at].draft.text, cites: results[at].draft.cites, covered: verdicts[at].covered, read: readOf(unit.segments), status: verdicts[at].pass ? 'ok' : 'short' }));
  const covered = [...new Set(units.flatMap(unit => unit.covered))], pass = verdicts.every(verdict => verdict.pass);
  const open = item.units.map((unit, at) => openIssues(verdicts[at], unit)), seen = new Set();
  const missing = open.flatMap(entry => entry.missing).filter(entry => !covered.includes(entry.id) && !seen.has(entry.id) && seen.add(entry.id));
  return { fingerprint: item.fingerprint, units, coverage: { must: item.checklist.filter(entry => entry.priority === 'must').length, covered, missing,
    optional: item.checklist.filter(entry => entry.priority !== 'must').length }, issues: pass ? [] : open.flatMap(entry => entry.issues).slice(0, 40),
    status: pass && !missing.length ? 'ok' : 'short', readPrint: item.readPrint, ...(item.replaces ? { replaces: item.replaces } : {}) };
}

/** Stage: every point that is not kept, in parallel; each point's state is on the board the console shows (writing, reviewing, ok, short, failed). */
export async function leafStage(ctx, work) {
  const { plan, state, show, parallel } = ctx, todo = work.items.filter(item => item.mode !== 'keep');
  const policies = { write: policyOf('write', plan.efforts), review: policyOf('review', plan.efforts), repair: policyOf('repair', plan.efforts) };
  Object.assign(state.leaves, { total: todo.length, done: 0 });
  state.board = todo.slice(0, 300).map(item => ({ id: item.id, title: item.title, status: 'waiting', must: item.checklist.filter(entry => entry.priority === 'must').length }));
  state.stage = 'write'; show();
  await parallel.each(todo, async item => {
    const where = { number: work.items.indexOf(item) + 1, total: work.items.length }, row = state.board.find(entry => entry.id === item.id);
    if (row) { row.status = item.mode === 'mend' ? 'reviewing' : 'writing'; show(); }
    const results = await Promise.all(item.units.map(unit => unitChain(ctx, item, unit, where, policies)));
    const body = bodyOf(item, results);
    if (body) { item.body = body; item.written = true; state.leaves[body.status]++; state.repaired += results.reduce((sum, result) => sum + (result.repaired ?? 0), 0); }
    else { state.leaves.failed++; state.missed++; if (item.earlier) item.body = item.earlier; else delete item.body; }
    if (row) Object.assign(row, { status: body ? body.status : 'failed', covered: body?.coverage.covered.length ?? 0, missing: body?.coverage.missing.length ?? 0 });
    state.leaves.done++; show();
  }, 'leaves');
}
