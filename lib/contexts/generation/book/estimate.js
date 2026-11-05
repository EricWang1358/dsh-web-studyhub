import { EXAM_LEAVES_PER_CALL } from './constants.js';

/* The scale of a whole review book build, from what its sample REALLY used (#710): the sample Job's own model calls, as the task console holds them. Each point
   of the rest is counted like a sample point: the typical point is the low end, the sample's average (the heavy point included) the high end; the exam notes and the
   inventory still to read and the answer kit are counted per call, like the sample's calls of that stage (else like an average call of its points). The time: the points'
   chains (write, review, repair) run `concurrency` at a time, the other calls likewise. Tokens in DSH's buckets, the same fields as an estimate before a run
   (ui/token-usage.js); no prices anywhere. Pure. */

const POINT_STAGES = new Set(['write', 'review', 'repair']);
const BUCKETS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];
const msOf = call => Math.max(0, (Date.parse(call.endedAt) || 0) - (Date.parse(call.startedAt) || 0));
const zero = () => Object.fromEntries(BUCKETS.map(bucket => [bucket, 0]));
const add = (a, b, times = 1) => Object.fromEntries(BUCKETS.map(bucket => [bucket, a[bucket] + (Number(b?.[bucket]) || 0) * times]));
const sum = usage => BUCKETS.reduce((total, bucket) => total + usage[bucket], 0);

/** What one group of calls used: { calls, tokens (buckets, or null when a call did not report its usage), ms }. */
function measure(calls) {
  const known = calls.every(call => call.tokenUsage);
  const tokens = known ? calls.reduce((total, call) => add(total, call.tokenUsage), zero()) : null;
  return { calls: calls.length, tokens, ms: calls.reduce((total, call) => total + msOf(call), 0) };
}
const scaled = (one, times) => ({ calls: one.calls * times, tokens: one.tokens ? add(zero(), one.tokens, times) : null, ms: one.ms * times });
const mean = list => ({ calls: list.reduce((total, one) => total + one.calls, 0) / list.length, ms: list.reduce((total, one) => total + one.ms, 0) / list.length,
  tokens: list.every(one => one.tokens) ? add(zero(), list.reduce((total, one) => add(total, one.tokens), zero()), 1 / list.length) : null });
const range = (low, high) => ({ low: Math.round(low), high: Math.round(high) });

/**
 * @param calls the sample Job's calls ({ stage, part, modelRequest, tokenUsage, startedAt, endedAt }); `part` is the point's place in the book
 * @param rest { points, tested, inventory, kit, confusables }: the points still to write, how many of them the papers test, the inventory, answer kit and
 *   confusable-pairs calls still to make
 * @returns { points, calls, totalTokens, inputTokens, uncachedInputTokens, cacheReadTokens, outputTokens, minutes, concurrency, stages, feature, notes } (token
 *   ranges null when the provider reported no usage), or null when the sample asked nothing (every point of it was kept)
 */
export function scaleEstimate({ calls, rest, total, sample, concurrency }) {
  const asked = (calls || []).filter(call => call.modelRequest);
  const byPoint = new Map();
  for (const call of asked.filter(item => POINT_STAGES.has(item.stage))) byPoint.set(call.part, [...(byPoint.get(call.part) || []), call]);
  if (!byPoint.size) return null;
  const points = [...byPoint.values()].map(measure), size = one => (one.tokens ? sum(one.tokens) : one.calls);
  const low = points.reduce((best, one) => (size(one) < size(best) ? one : best)), high = mean(points);
  const perCall = mean(points.map(one => ({ calls: 1, ms: one.ms / one.calls, tokens: one.tokens ? add(zero(), one.tokens, 1 / one.calls) : null })));
  const other = (stage, count) => {
    const own = asked.filter(call => call.stage === stage), one = own.length ? mean(own.map(call => measure([call]))) : perCall;
    return scaled(one, count);
  };
  const lanes = Math.max(1, concurrency || 1), rounds = Math.ceil(rest.points / lanes);
  const exam = other('exam', Math.ceil((rest.tested || 0) / EXAM_LEAVES_PER_CALL)), inventory = other('inventory', rest.inventory || 0);
  const kit = other('kit', rest.kit || 0), confusables = other('confusables', rest.confusables || 0), others = [exam, inventory, kit, confusables];
  const ends = [low, high].map(one => {
    const all = [scaled(one, rest.points), ...others];
    return { calls: all.reduce((count, part) => count + part.calls, 0), tokens: all.every(part => part.tokens) ? all.reduce((usage, part) => add(usage, part.tokens), zero()) : null,
      ms: rounds * one.ms + others.reduce((total, part) => total + part.ms, 0) / lanes };
  });
  const tokens = ends.every(end => end.tokens);
  const bucket = name => (tokens ? range(ends[0].tokens[name], ends[1].tokens[name]) : null);
  const input = end => end.tokens.uncachedInputTokens + end.tokens.cacheReadTokens + end.tokens.cacheWriteTokens;
  const stage = (id, low, high) => ({ id, calls: Math.round((low.calls + high.calls) / 2),
    inputTokens: range(low.tokens ? input({ tokens: low.tokens }) : 0, high.tokens ? input({ tokens: high.tokens }) : 0),
    outputTokens: range(low.tokens?.outputTokens ?? 0, high.tokens?.outputTokens ?? 0) });
  return {
    points: { total, sample, rest: rest.points },
    calls: range(ends[0].calls, ends[1].calls),
    totalTokens: tokens ? range(sum(ends[0].tokens), sum(ends[1].tokens)) : null,
    inputTokens: tokens ? range(input(ends[0]), input(ends[1])) : null,
    uncachedInputTokens: bucket('uncachedInputTokens'), cacheReadTokens: bucket('cacheReadTokens'), outputTokens: bucket('outputTokens'),
    // To the nearest minute: 0 says "under a minute" (a page never says "about 1 minute" of calls that took milliseconds).
    minutes: range(ends[0].ms / 60000, ends[1].ms / 60000), concurrency: lanes,
    stages: [stage('bookPoints', scaled(low, rest.points), scaled(high, rest.points)), ...(exam.calls ? [stage('exam', exam, exam)] : []),
      ...(inventory.calls ? [stage('inventory', inventory, inventory)] : []),
      ...(kit.calls ? [stage('kit', kit, kit)] : []), ...(confusables.calls ? [stage('confusables', confusables, confusables)] : [])],
    feature: 'other', notes: ['cache-depends', 'retries'],
  };
}
