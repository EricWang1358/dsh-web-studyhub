/* The one top-up of a draft: 「为没覆盖的部分补题」. It is asked for the sections of a material that have no question (lib/coverage.js), planned-and-failed ones first, then the
   never-planned ones, each group in reading order, up to the generation limit of questions for one round; it keeps the approved questions and merges into the same draft.
   Pure, no Node modules: the draft page, the home card and the 任务 console show what a round will do from the same function the backend runs it with, so the number on the
   button, the estimate under it and the job that starts are the same.

   `planRound(coverage, { limit, keys })` -> { picks, sections, questions, fresh, reused, plannedFailed, neverPlanned, uncovered, left, rounds, limit, complete }
     picks: [{ key, id, sourceId, title, state, questions, reuse }]   `reuse` is how many of the section's questions are planned targets that failed and are written again as they were
   A planned-failed section that has planned targets with offsets (lib/plan-record.js) costs one question per target and is not planned again; every other uncovered section costs the
   quota the draft's plan gave it (`quotas`: Map(section key -> quota), from `editorial.coverageSpec`, heaviest first), else one question, planned from its own text. Questions are counted
   against `limit` (the generation limit of one ROUND, 30) and `left` / `rounds` say, honestly, how much a single round does not reach.
   `roundRequest(round, coverage, sources, { batchSize })` -> { count, sources, assignments, reuse, questions, sectionKeys }: what lib/batch.js plans the round from. `sources` are the fresh
   sections' text (pieces of the sources, each remembering where it was cut: lib/sections.js withSliceRange), `assignments` the sections the planner is given with their quotas
   (lib/assigned-plan.js: the program checks what the planner returns against them), `count` how many questions that is, `reuse` the groups of planned targets to write again, each with the
   pieces of the sections it is about. */
import { PLANNED_FAILED, uncoveredSections } from './coverage.js';
import { withSliceRange } from './sections.js';

/** The most questions one round makes: the generation limit of lib/contexts/generation/operations.js. */
export const ROUND_LIMIT = 30;

const same = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The targets of a planned-failed section that can be written again as they were: one per distinct objective. */
function reusableOf(section) {
  if (section.state !== PLANNED_FAILED) return [];
  const seen = new Set();
  return (section.targets || []).filter(target => { const key = same(target.objective); if (!key || seen.has(key)) return false; seen.add(key); return true; });
}

const costOf = (section, limit, quotas) => {
  const reuse = reusableOf(section).length;
  return reuse ? { questions: Math.min(reuse, limit), reuse: Math.min(reuse, limit) } : { questions: Math.max(1, Math.min(limit, quotas?.get(section.key) ?? 1)), reuse: 0 };
};

function pick(pool, limit, quotas) {
  const picks = [];
  let questions = 0;
  for (const section of pool) {
    const cost = costOf(section, limit, quotas);
    if (picks.length && questions + cost.questions > limit) break;
    picks.push({ section, ...cost });
    questions += cost.questions;
  }
  return { picks, questions };
}

/** How many rounds it takes to reach every section in `pool` at this limit (the first included); an estimate, since a round's failures stay in the pool. */
function roundsFor(pool, limit, quotas) {
  let rounds = 0, rest = pool;
  while (rest.length) { const { picks } = pick(rest, limit, quotas); rest = rest.slice(picks.length); rounds += 1; }
  return rounds;
}

/** The sections of a coverage that have no question in the order a round takes them: planned and failed first, then the never planned (the heaviest quota first when the draft has a plan, then reading order). */
function poolOf(coverage, quotas, late) {
  const pool = uncoveredSections(coverage || { sections: [] });
  let ordered = pool;
  if (quotas?.size) {
    const failed = pool.filter(section => section.state === PLANNED_FAILED), fresh = pool.filter(section => section.state !== PLANNED_FAILED), at = new Map(fresh.map((section, index) => [section.key, index]));
    ordered = [...failed, ...[...fresh].sort((a, b) => (quotas.get(b.key) ?? 1) - (quotas.get(a.key) ?? 1) || at.get(a.key) - at.get(b.key))];
  }
  // The sections that failed again and again (`late`, lib/coverage-run.js isRepeating) go last: the round starts with what can succeed.
  return late?.size ? [...ordered.filter(section => !late.has(section.key)), ...ordered.filter(section => late.has(section.key))] : ordered;
}

/**
 * What one round does. By default the first sections of the uncovered ones that fit in `limit` questions; with `keys` (section keys, lib/coverage.js sectionKey) exactly those,
 * which the backend uses to run what the screen showed: { error: 'unknown' | 'covered' | 'too-many' } when a key is not an uncovered section of this coverage or they need more than `limit` (`fit`: they are cut to what fits instead).
 */
export function planRound(coverage, { limit = ROUND_LIMIT, keys, quotas, fit = false, late } = {}) {
  const pool = poolOf(coverage, quotas, late);
  let chosen, questions;
  if (Array.isArray(keys)) {
    const byKey = new Map((coverage?.sections || []).map(section => [section.key, section]));
    const sections = [];
    for (const key of [...new Set(keys)]) {
      const section = byKey.get(key);
      if (!section) return { error: 'unknown', key };
      if (section.state === 'covered') return { error: 'covered', key };
      sections.push(section);
    }
    // Reading order within each state, planned-failed first: the order a round is made in.
    const order = new Map(pool.map((section, at) => [section.key, at]));
    sections.sort((a, b) => order.get(a.key) - order.get(b.key));
    chosen = sections.map(section => ({ section, ...costOf(section, limit, quotas) }));
    // `fit`: the keys are a round of the plan, which holds at most `limit` questions; a section that was planned and failed may cost a little more than its quota (it is written again from the targets it had), so the round is cut to what fits.
    if (fit) { let total = 0; chosen = chosen.filter((item, at) => { if (at > 0 && total + item.questions > limit) return false; total += item.questions; return true; }); }
    questions = chosen.reduce((sum, item) => sum + item.questions, 0);
    if (!chosen.length || questions > limit) return { error: 'too-many', questions };
  } else ({ picks: chosen, questions } = pick(pool, limit, quotas));
  const picks = chosen.map(({ section, questions: n, reuse }) => ({ key: section.key, id: section.id, sourceId: section.sourceId, title: section.title, state: section.state, questions: n, reuse }));
  const left = pool.length - chosen.length, reused = chosen.reduce((sum, item) => sum + item.reuse, 0);
  // `allQuestions`: what every uncovered section costs, i.e. the questions it takes to reach full coverage (the first round included): the number a learner reads before pressing the button.
  const allQuestions = pool.reduce((sum, section) => sum + costOf(section, limit, quotas).questions, 0);
  return { picks, sections: picks.length, questions, fresh: questions - reused, reused, plannedFailed: picks.filter(item => item.state === PLANNED_FAILED).length,
    neverPlanned: picks.filter(item => item.state !== PLANNED_FAILED).length, uncovered: pool.length, left, allQuestions,
    rounds: !chosen.length ? 0 : 1 + roundsFor(pool.filter(section => !chosen.some(item => item.section.key === section.key)), limit, quotas), limit, complete: left === 0 };
}

/**
 * The plan of a top-up of a draft that has none (a plain run asked for a number of questions): its uncovered sections in the order a round takes them, cut into rounds of at most `limit` questions,
 * in the shape of `editorial.coverageSpec` (lib/coverage-plan.js) so that the ONE executor of a coverage run (lib/coverage-run.js stepOf, lib/contexts/generation/operations.js) runs it:
 * { version, topup: true, goal, leaves, mustCover, weightSource, weights: [], quotas: [{ sectionId, quota, reason }], rounds: [{ round, questions, sectionIds }] }.
 * `goal` is what the draft holds plus every question the rounds make: the number every screen reads. Bounded like a coverage plan (a longer material keeps the first rows and says `truncated`).
 */
export function topUpSpec(coverage, { kept = 0, limit = ROUND_LIMIT, quotas, late, rows = 600 } = {}) {
  const pool = poolOf(coverage, quotas, late), rounds = [], asked = [];
  let rest = pool;
  while (rest.length) {
    const { picks, questions } = pick(rest, limit, quotas);
    rounds.push({ round: rounds.length + 1, questions, sectionIds: picks.map(item => item.section.key) });
    for (const item of picks) asked.push({ sectionId: item.section.key, quota: item.questions, reason: 'topup' });
    rest = rest.slice(picks.length);
  }
  const questions = asked.reduce((sum, item) => sum + item.quota, 0);
  return { version: 1, topup: true, goal: Math.max(0, kept) + questions, leaves: coverage?.leaves ?? pool.length, mustCover: pool.length, weightSource: 'length', weights: [],
    quotas: asked.slice(0, rows), rounds, ...(asked.length > rows ? { truncated: true } : {}) };
}

/** Pieces of the sources for ranges [{ sourceId, start, end }]: per source in reading order, ranges that touch or overlap are one piece. Each piece remembers where it was cut. */
function piecesFor(ranges, byId) {
  const order = [], bySource = new Map();
  for (const range of ranges) { if (!bySource.has(range.sourceId)) { bySource.set(range.sourceId, []); order.push(range.sourceId); } bySource.get(range.sourceId).push(range); }
  return order.flatMap(sourceId => {
    const source = byId.get(sourceId);
    if (!source || typeof source.text !== 'string') return [];
    const merged = [];
    for (const range of bySource.get(sourceId).sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1), end = Math.min(source.text.length, range.end);
      if (last && range.start <= last.end) last.end = Math.max(last.end, end); else merged.push({ start: range.start, end });
    }
    return merged.map(({ start, end }) => withSliceRange({ ...source, text: source.text.slice(start, end) }, start, end));
  });
}

const rangeOfSection = section => ({ sourceId: section.sourceId, start: section.start, end: section.end });

/** What lib/batch.js plans a round from; see the top of this file. `coverage` must have been made with `targets: true`. */
export function roundRequest(round, coverage, sources, { batchSize = 5 } = {}) {
  const byId = new Map((sources || []).map(source => [source.id, source])), sections = new Map((coverage?.sections || []).map(section => [section.key, section]));
  const fresh = [], reuse = [], assignments = [];
  let serial = 0;
  for (const { key, reuse: n, questions: asked } of round.picks) {
    const section = sections.get(key);
    if (!section) continue;
    if (!n) {
      fresh.push(section);
      assignments.push({ key: section.key, sectionId: section.key, sourceId: section.sourceId, start: section.start, end: section.end, quota: asked, ...(section.title ? { title: section.title } : {}) });
      continue;
    }
    for (const target of reusableOf(section).slice(0, n)) {
      const text = byId.get(target.sourceId)?.text;
      if (typeof text !== 'string' || !(target.end > target.start)) continue;
      // The pieces hold the section and, should the quote run over its end, the whole quote.
      reuse.push({ range: { sourceId: target.sourceId, start: section.start, end: Math.max(section.end, target.end) }, target: { targetId: `reuse-${++serial}`, objective: target.objective,
        knowledge: target.knowledge || target.objective, citations: [{ sourceId: target.sourceId, quote: text.slice(target.start, target.end) }] } });
    }
  }
  const groups = [], size = Math.max(1, batchSize);
  for (let at = 0; at < reuse.length; at += size) {
    const slice = reuse.slice(at, at + size);
    groups.push({ targets: slice.map(item => item.target), sources: piecesFor(slice.map(item => item.range), byId) });
  }
  return { count: assignments.reduce((sum, item) => sum + item.quota, 0), sources: piecesFor(fresh.map(rangeOfSection), byId), assignments, reuse: groups, questions: round.questions, sectionKeys: round.picks.map(item => item.key),
    titles: fresh.map(section => section.title || (section.page ? `page ${section.page}` : section.n ? `segment ${section.n}` : section.id)).slice(0, 40) };
}
