/* Token usage as DSH shows it (WP27): pure helpers behind ui/TokenUsage.jsx.

   The fields, their order, their wording and the `tok` unit are those of the
   session usage panel in DSH (Token 用量 / 缓存命中 / 未缓存输入 / 缓存读取 /
   缓存写入 / 输出), with DSH's own English labels. Counts after a run are exact
   and grouped by "," like DSH; before a run they are ranges in DSH's compact
   form (12.2K, 1.2M). A cache-write row appears only when there was one and the
   hit rate only when something was sent, as in DSH. */
import { ui, uiFormat } from './i18n.js';
import { cacheHitPercent, formatCompactTokens, formatExactTokens, promptTokens, totalTokens } from '../lib/token-usage.js';

const tok = (formatted) => `${formatted} tok`;
const DASH = '–';

/** Rows of an actual usage, in DSH's order: [{ id, label, value }]. */
export function usageRows(usage) {
  const rows = [{ id: 'total', label: ui('Token 用量'), value: tok(formatExactTokens(totalTokens(usage))) }];
  const hit = cacheHitPercent(usage);
  if (hit !== null) rows.push({ id: 'hit', label: ui('缓存命中'), value: `${hit}%` });
  rows.push({ id: 'uncached', label: ui('未缓存输入'), value: tok(formatExactTokens(usage?.uncachedInputTokens || 0)) });
  rows.push({ id: 'cacheRead', label: ui('缓存读取'), value: tok(formatExactTokens(usage?.cacheReadTokens || 0)) });
  if ((usage?.cacheWriteTokens || 0) !== 0) rows.push({ id: 'cacheWrite', label: ui('缓存写入'), value: tok(formatExactTokens(usage.cacheWriteTokens)) });
  rows.push({ id: 'output', label: ui('输出'), value: tok(formatExactTokens(usage?.outputTokens || 0)) });
  return rows;
}

/** The plain-text line the copy button puts on the clipboard. */
export const joinRows = (rows) => rows.map((row) => `${row.label} ${row.value}`).join(' · ');
export const usageText = (usage) => joinRows(usageRows(usage));

/** "12.2K–20.1K tok", or one number when the range is a point. */
export function rangeTok(range) {
  const low = Math.max(0, Math.round(range?.low || 0)), high = Math.max(low, Math.round(range?.high || 0));
  return tok(low === high ? formatCompactTokens(low) : `${formatCompactTokens(low)}${DASH}${formatCompactTokens(high)}`);
}

/** Rows of an estimate: the same fields as ranges; a first run may hit no cache at all. */
export function estimateRows(estimate) {
  const rows = [{ id: 'total', label: ui('预计 Token 用量'), value: rangeTok(estimate.totalTokens) }];
  const mostCached = estimate.inputTokens?.high ? Math.min(100, Math.ceil((estimate.cacheReadTokens?.high || 0) / estimate.inputTokens.high * 100)) : 0;
  rows.push({ id: 'hit', label: ui('缓存命中'), value: `0${DASH}${mostCached}%` });
  rows.push({ id: 'uncached', label: ui('未缓存输入'), value: rangeTok(estimate.uncachedInputTokens) });
  rows.push({ id: 'cacheRead', label: ui('缓存读取'), value: rangeTok(estimate.cacheReadTokens) });
  rows.push({ id: 'output', label: ui('输出'), value: rangeTok(estimate.outputTokens) });
  return rows;
}
export const estimateText = (estimate) => joinRows(estimateRows(estimate));

/** "8–10 次模型调用" (one number when the range is a point). */
export function callsText(calls) {
  const low = Math.max(0, Math.round(calls?.low || 0)), high = Math.max(low, Math.round(calls?.high || 0));
  if (low === high) return high === 1 ? ui('1 次模型调用') : uiFormat('{0} 次模型调用', [high]);
  return uiFormat('{0}–{1} 次模型调用', [low, high]);
}
/** The call count of a finished job, as small print. */
export const usedCallsText = (calls) => (calls === 1 ? ui('1 次调用') : uiFormat('{0} 次调用', [calls]));

/** "预计 58.3K–96.1K tok · 8–10 次模型调用": the one line above the submit button. */
export function estimateSummary(estimate) {
  return `${ui('预计')} ${rangeTok(estimate.totalTokens)} · ${callsText(estimate.calls)}`;
}

/** The estimate a job kept, as "预计 …" without the call count. */
export const expectedText = (estimate) => `${ui('预计')} ${rangeTok(estimate.totalTokens)}`;

const FEATURE_LABELS = () => ({
  generate: ui('出题'), repair: ui('改题与复核'), coach: ui('陪学'), flow: ui('学习流'), case: ui('案例'), audio: ui('音频文本'), other: ui('其他'),
});
/** Features in the product's order, with their names. */
export const USAGE_FEATURE_ORDER = Object.freeze(['generate', 'repair', 'coach', 'flow', 'case', 'audio', 'other']);
export const featureLabel = (id) => FEATURE_LABELS()[id] || id;

/** One stage of an estimate, in plain words. */
export function stageLabel(id, feature) {
  if (feature === 'case' && id === 'author') return ui('写案例和评分标准');
  return ({
    plan: ui('规划考点'), author: ui('出题与自查'), review: ui('独立审阅'), grade: ui('按评分标准批改'), suggest: ui('帮我想想'),
    article: ui('写讲解'), proofread: ui('校对'), translate: ui('翻译'), title: ui('起标题'),
  })[id] || id;
}

/** What an estimate cannot know, as a sentence per note code. */
export function noteText(code, estimate = {}) {
  const blocked = estimate.blocked;
  switch (code) {
    case 'cache-depends': return ui('缓存命中多少取决于服务商的缓存；第一次运行可能是 0。');
    case 'retries': return ui('出错重试（例如模型返回的格式不对）会多调用几次，实际用量可能更多。');
    case 'large-selection': return ui('资料较多：规划阶段会把每份资料读一遍，之后每一批只带上规划选中的页。缩小页码范围能明显减少用量。');
    case 'over-limit': return blocked
      ? uiFormat('你选的 {1} 份资料共 {3} 字符，超过了一次最多 {0} 字符的上限，请缩小页码范围或分批出题。上面的数字是一次最多能选入的资料（约前 {2} 份）的用量。',
        [formatExactTokens(blocked.limit), blocked.totalSources, blocked.fitSources, formatExactTokens(blocked.chars)])
      : '';
    case 'effort-high': return ui('推理程度越高，推理 token 越多（计入输出）。');
    case 'cjk-higher': return ui('中文资料的实际 token 通常更接近上限。');
    case 'transcript-estimated': return ui('转写稿的长度按正常语速、英文讲课估算；中文讲课的转写稿更短，但每个字的 token 更多。');
    case 'transcribe-separate': return ui('转写本身按音频时长计，不在这里；见「音频转录」页的用量与额度。');
    default: return '';
  }
}
/** How the two ends of every range are counted. */
export const methodNote = () => ui('下限按 DSH 的固定估算；上限按 DeepSeek 公布的换算（中文每字约 0.6 token，英文每字符约 0.3）。');
