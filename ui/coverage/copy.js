import { ui, uiFormat } from '../i18n.js';
import { META_DOT, joinMeta, formatElapsed } from '../format.js';
import { formatCompactTokens } from '../../lib/token-usage.js';
import { classifyFailure, shortCauseOf, THIN_CHARS } from '../../lib/generation-failure.js';

/* 覆盖: the words of coverage, written ONCE (README docs/plans/coverage-generation). The 任务 console's 资料部分, the draft page, the 资料 row, the reader's toolbar, outline and
   practice popover all say it through these functions, so one fact has one wording on every screen. Coverage is "asked" (a section has a question), mastery is "learned"
   (how the learner did on it): the words never mix the two. */

/* How many of a unit: the unit is what lib/coverage.js says the sections are (units). English has a singular, so each is two literals.
   「小节」 is the coverage unit EVERYWHERE the learner sees it (a transcript part, a heading, a section: all 小节; a PDF page is a 页 and a chapter a 章节); a generation BATCH is a 批次 (the 任务
   console); a transcript's own headings (「第六部分：…」) are the material's and are left alone. */
const COUNT = {
  part: [() => ui('1 个小节'), (n) => uiFormat('{0} 个小节', [n])],
  page: [() => ui('1 页'), (n) => uiFormat('{0} 页', [n])],
  chapter: [() => ui('1 个章节'), (n) => uiFormat('{0} 个章节', [n])],
  heading: [() => ui('1 个小节'), (n) => uiFormat('{0} 个小节', [n])],
  window: [() => ui('1 个片段'), (n) => uiFormat('{0} 个片段', [n])],
  section: [() => ui('1 个小节'), (n) => uiFormat('{0} 个小节', [n])],
};

/** "80 个小节" / "80 sections": `n` of the units a coverage counts. */
export const countOf = (units, n) => { const [one, many] = COUNT[units] || COUNT.section; return n === 1 ? one() : many(n); };

/** What a coverage level is called (lib/coverage-strength.js): the three words of the 覆盖强度 choice. */
export function levelLabel(value) { return ({ lean: ui('精简'), standard: ui('标准'), full: ui('完整') })[value] || ''; }

/** The head of the list of what has no question, and what is said when nothing is left, in the unit of the material. */
const UNCOVERED = { part: (n) => uiFormat('没覆盖的小节 · {0}', [n]), page: (n) => uiFormat('没覆盖的页 · {0}', [n]), chapter: (n) => uiFormat('没覆盖的章节 · {0}', [n]),
  heading: (n) => uiFormat('没覆盖的小节 · {0}', [n]), window: (n) => uiFormat('没覆盖的片段 · {0}', [n]), section: (n) => uiFormat('没覆盖的小节 · {0}', [n]) };
export const uncoveredHead = (units, n) => (UNCOVERED[units] || UNCOVERED.section)(n);
const ALL = { part: () => ui('每个小节都有题了。'), page: () => ui('每一页都有题了。'), chapter: () => ui('每个章节都有题了。'), heading: () => ui('每个小节都有题了。'),
  window: () => ui('每个片段都有题了。'), section: () => ui('每个小节都有题了。') };
export const allCoveredText = (units) => (ALL[units] || ALL.section)();

/** 「覆盖 7/80 个小节（9%）」 */
export const coverageHead = (c) => uiFormat('覆盖 {0}/{1}（{2}%）', [c.covered, countOf(c.units, c.leaves), c.percentLeaves]);

/** 「3 个计划了没出成」, 「70 个没计划到」: the rest of the line. A draft from before plans were kept says 「没有记录」 for what it cannot tell. */
export const plannedFailedText = (n) => uiFormat('{0} 个计划了没出成', [n]);
export const neverPlannedText = (n, recorded = true) => (recorded ? uiFormat('{0} 个没计划到', [n]) : uiFormat('{0} 个没有记录', [n]));

/** 「70 个排在后面的轮次」: the sections the draft's plan (editorial.coverageSpec) puts in a later round, which has not been run yet. They are planned, not "never planned". */
export const scheduledText = (n) => uiFormat('{0} 个排在后面的轮次', [n]);

/** 「覆盖 7/80 个小节（9%）· 3 个计划了没出成 · 70 个没计划到」; a draft with a plan says 「… · 60 个排在后面的轮次 · 10 个没计划到」. */
export function coverageLine(c) {
  const scheduled = Math.min(c.scheduled || 0, c.neverPlanned || 0), never = c.neverPlanned - scheduled;
  return [coverageHead(c), c.plannedFailed > 0 && plannedFailedText(c.plannedFailed), scheduled > 0 && scheduledText(scheduled), never > 0 && neverPlannedText(never, c.recorded)].filter(Boolean).join(META_DOT);
}

/** 「覆盖 9%」: the chip beside the mastery mark. */
export const coverageChipText = (c) => uiFormat('覆盖 {0}%', [c.percentLeaves]);

/** 「覆盖 7/80」: the outline's header. */
export const coverageOutlineHead = (c) => uiFormat('覆盖 {0}/{1}', [c.covered, c.leaves]);

/** What a section's state is called. `scheduled`: it is in a later round of the draft's plan. */
export function stateWord(state, recorded = true, scheduled = false) {
  if (state === 'covered') return ui('已覆盖');
  if (state === 'planned-failed') return ui('计划了没出成');
  if (scheduled) return ui('排在后面的轮次');
  return recorded ? ui('没计划到') : ui('没有记录');
}

/** What a state means, for a tooltip: said as asked, not as learned. */
export function stateMeaning(state, recorded = true, scheduled = false) {
  if (state === 'covered') return ui('这一节出过题。覆盖只说出没出过题，掌握度才说你答得怎么样。');
  if (state === 'planned-failed') return ui('这一节的考点计划过，但题没出成。可以用「为没覆盖的部分补题」补上。');
  if (scheduled) return ui('这一节在出题计划的后面几轮里，还没出题。可以用「为没覆盖的部分补题」继续。');
  return recorded ? ui('这一节没有被计划出题。可以用「为没覆盖的部分补题」补上。') : ui('这份草稿生成时没有保存计划，只能说这一节现在没有题。');
}

/** Why a planned section did not come out: the words of each failure code (lib/generation-failure.js), the ones the 任务 console and the draft already use. */
const REASON_WORD = { 'plan-short': '模型给出的考点比计划的少', quote: '引用在资料里找不到', plan: '考点规划未通过检查', quality: '题没有通过质量审阅', 'review-protocol': '审阅回复格式不对，重新审阅后仍不行',
  timeout: '模型长时间没有回应', 'rate-limit': '被模型服务限流', 'no-reply': '模型没有返回内容', quota: '模型账户余额或额度不足', credential: '模型服务拒绝了请求（密钥无效或没有权限）',
  budget: '因为这一轮的时间用完了，没做完的批次被停止', cancelled: '因为你停止了任务', unavailable: '模型服务暂时不可用，或中断了这次请求', other: '其他原因' };
export const reasonWord = (code) => ui(REASON_WORD[code] || REASON_WORD.other);

/** 「原因：…」 of a failed round or a stopped run, from the cause's CODE (lib/generation-failure.js); an older record that kept only the provider's text is classified, and what nothing recognises is not printed (never the provider's English). */
export function failedWhy(value) {
  if (value === 'timeout') return uiFormat('原因：{0}', [ui('这一轮用时到限')]);
  if (value === 'cancelled') return uiFormat('原因：{0}', [reasonWord('cancelled')]);
  if (typeof value !== 'string' || !value.trim()) return '';
  const code = Object.hasOwn(REASON_WORD, value) ? value : classifyFailure(value).code;
  return code === 'unknown' ? '' : uiFormat('原因：{0}', [reasonWord(code)]);
}

/* ---------- why a section came back short (lib/assigned-plan.js records the numbers, lib/coverage-run.js recordAttempts keeps them on the plan): what happened, why, what to do ---------- */

const known = (value) => Number.isFinite(value) && value >= 0;

/** 「第 18、19 页」 (all pages) or the sections' own names joined: the sections a line of the log or a list names. A section nothing names is left out. */
export function refsText(refs) {
  const list = (Array.isArray(refs) ? refs : []).filter((ref) => ref && sectionName(ref));
  if (list.length && list.every((ref) => ref.page)) return uiFormat('第 {0} 页', [list.map((ref) => ref.page).join(ui('、'))]);
  return list.map((ref) => sectionName(ref)).join(ui('、'));
}

/** 「要 3 个考点，只给出 1 个」: what the plan needed of a section and what the model gave (`short` { needed, got }); '' when the run did not record it. */
export function needGotText(short) {
  if (!known(short?.needed) || !(short.needed > 0) || !known(short?.got)) return '';
  return short.got > 0 ? uiFormat('要 {0} 个考点，只给出 {1} 个', [short.needed, short.got]) : uiFormat('要 {0} 个考点，一个也没给出', [short.needed]);
}

/** 「第 18 页：计划需要 3 个考点，模型只给出了 1 个」 (an item with a `short`), else ''. */
export function shortFact(item) {
  const short = item?.short;
  if (!known(short?.needed) || !(short.needed > 0) || !known(short?.got)) return '';
  return short.got > 0 ? uiFormat('{0}：计划需要 {1} 个考点，模型只给出了 {2} 个', [sectionName(item), short.needed, short.got])
    : uiFormat('{0}：计划需要 {1} 个考点，模型一个也没给出', [sectionName(item), short.needed]);
}

/** Why the plan came back short, in a sentence, from what the run recorded (lib/generation-failure.js shortCauseOf): only what the record can tell; a page with very little text says so. */
export function shortWhy(short) {
  if (!known(short?.needed) || !(short.needed > 0) || !known(short?.got)) return '';
  const cause = shortCauseOf(short);
  const said = ({
    fewer: () => (short.returned === short.got ? uiFormat('补问一次后，模型仍只给出 {0} 个', [short.got]) : uiFormat('补问一次后，模型一共给出 {0} 个，只有 {1} 个能在这一页里找到出处并通过检查', [short.returned, short.got])),
    empty: () => ui('补问一次后，模型一个考点也没给出'),
    quote: () => uiFormat('模型给出了 {0} 个考点，但引用的原文在这一页里找不到', [short.returned]),
    refused: () => ui('模型回复说这一页的内容不足以出考点'),
    invalid: () => ui('模型给出的考点没有通过检查（引用或格式不对）'),
    reply: () => ui('模型的回复读不出来（格式错误或被截断）'),
    short: () => uiFormat('记录里只有数量：计划要 {0} 个，模型给出 {1} 个', [short.needed, short.got]),
  })[cause]();
  const thin = known(short.chars) && short.chars < THIN_CHARS ? uiFormat('这一页只有约 {0} 个字，文字很少，可能是空白页、纯图片页或附录', [Math.round(short.chars / 10) * 10]) : '';
  return thin ? uiFormat('{0}；{1}', [said, thin]) : said;
}

const roundWord = (item) => (item.fill ? uiFormat('补做第 {0} 轮', [item.round]) : uiFormat('第 {0} 轮', [item.round]));
const triesText = (item) => (item.attempts > 0 ? uiFormat('已试 {0} 次', [item.attempts]) : '');

/**
 * The way the failing sections are explained once (the plan block of the console, the draft page): for each section what happened (「第 18 页：计划需要 3 个考点，模型只给出了 1 个 · 已试 2 次（第 1 轮、补做第 2 轮）」)
 * and why (shortWhy), then what the learner can do, only what is true for the causes present (`needs`: plan | look | protocol | retry): retry, look at the original page, change the planning, or leave them.
 * `s` is a shortfall (lib/shortfall.js): its `repeating` sections and its coverage in percent. -> { items: [{ key, name, fact, why, thin, cause, reason, sourceId?, start? }], advice: [string], needs: [string] }
 */
export function repeatingExplain(s) {
  const items = (s?.repeating || []).map((item) => {
    const rounds = Array.isArray(item.rounds) && item.rounds.length ? uiFormat('（{0}）', [item.rounds.map(roundWord).join(ui('、'))]) : '';
    const head = shortFact(item) || uiFormat('{0}：{1}', [sectionName(item), reasonWord(item.reason)]), tries = triesText(item);
    const thin = known(item.short?.chars) && item.short.chars < THIN_CHARS, cause = item.short ? shortCauseOf(item.short) : null;
    return { key: item.key, name: sectionName(item), fact: tries ? joinMeta([head, `${tries}${rounds}`]) : head, why: item.short ? shortWhy(item.short) : '', thin, cause, reason: item.reason, ...(item.sourceId ? { sourceId: item.sourceId, start: item.start } : {}) };
  });
  if (!items.length) return { items: [], advice: [], needs: [] };
  // What each section calls for: a page the model says lacks the points, or a page with very little text, is looked at; a plan that came back short otherwise is asked again (and, if it keeps failing, planned harder).
  const need = new Set();
  for (const item of items) {
    if (item.thin || item.cause === 'refused') need.add('look');
    else if (item.reason === 'review-protocol') need.add('protocol');
    else if (item.reason === 'plan-short' || item.cause) need.add('plan');
    else need.add('retry');
  }
  const LINES = {
    plan: ui('再点「为没覆盖的部分补题」试一次：模型每次的回答不同，可能就够了。总是不行，可以在 设置 › 出题偏好 把规划的推理强度调高，或换一个更强的模型。'),
    look: ui('在资料里打开这一页，用「看原页」确认它有没有内容；是空白页、附录或只有图的话，不用管它。'),
    protocol: ui('再点「为没覆盖的部分补题」补上；经常出现的话，可以在设置里换一个输出更稳定的模型。'),
    retry: ui('再点「为没覆盖的部分补题」试一次。'),
  };
  const advice = ['plan', 'look', 'protocol', 'retry'].filter((key) => need.has(key)).map((key) => LINES[key]);
  if (known(s.coveragePercent)) advice.push(uiFormat('不处理也可以：已出的题都保留，现在覆盖 {0}%，已经可以练习。', [s.coveragePercent]));
  return { items, advice, needs: [...need] };
}

/* Why a section has the questions it has: the plan of the draft (`editorial.coverageSpec`, lib/coverage-plan.js) rides on each section as `weight` { importance, kind, reason, source, quota, why }. */
const KIND_WORD = { definition: '定义', method: '方法', example: '例子', summary: '小结', chatter: '闲聊' };
const WHY_WORD = { floor: '每个小节至少一题', long: '篇幅较长', important: '重点小节' };

/** The one line under a section's name: 「重要性 4/5 · 定义 · 计划 4 题 — 这是核心定义」; a section the model did not rate says it was shared out by length. */
export function weightLine(weight) {
  if (!weight || typeof weight !== 'object') return '';
  const quota = Number.isInteger(weight.quota) ? uiFormat('计划 {0} 题', [weight.quota]) : ui('不在这次的计划内');
  // The sections of a top-up's plan (lib/coverage-round.js topUpSpec) have no weight: they cost what they cost, one question each (a section that failed before: its planned targets).
  if (weight.why === 'topup') return Number.isInteger(weight.quota) ? quota : '';
  const rated = weight.source === 'model' && weight.importance >= 1;
  const head = rated ? [uiFormat('重要性 {0}/5', [weight.importance]), KIND_WORD[weight.kind] && ui(KIND_WORD[weight.kind]), quota].filter(Boolean).join(META_DOT) : [ui('按篇幅分配'), quota].filter(Boolean).join(META_DOT);
  const why = rated && weight.reason ? weight.reason : WHY_WORD[weight.why] ? ui(WHY_WORD[weight.why]) : '';
  return why ? uiFormat('{0} — {1}', [head, why]) : head;
}

/** The plan of a draft in one line: 「出题计划：标准，约 343 题，分 12 轮（重要性由模型判断）」. */
export function planLine(spec) {
  if (!spec?.goal) return '';
  if (spec.topup) return uiFormat('补齐计划：补到每个小节都有题，共 {0} 题，分 {1} 轮', [spec.goal, spec.rounds]);
  // A small custom total is not weighed section by section on purpose (lib/coverage-plan.js weighsSections): say that, not that no model was used.
  const source = spec.weightSource === 'model' ? ui('重要性由模型判断') : spec.weightSource === 'mixed' ? ui('有的小节按篇幅分配')
    : spec.weightReason === 'small-target' ? ui('题目不多，按篇幅分配，没有逐段判断重要性') : ui('按篇幅分配，没有用模型判断重要性');
  const line = uiFormat('出题计划：{0}，约 {1} 题，分 {2} 轮（{3}）', [levelLabel(spec.level), spec.goal, spec.rounds, source]);
  return spec.fills > 0 ? uiFormat('{0}；另补做 {1} 轮', [line, spec.fills]) : line;
}

/** A section as a list names it: its title, else its page, else its ordinal. */
export function sectionName(section) {
  if (section.title) return section.title;
  if (section.page) return uiFormat('第 {0} 页', [section.page]);
  if (section.n) return uiFormat('第 {0} 段', [section.n]);
  return section.id;
}

/** What a batch that has not finished says instead of 「覆盖 0/10 小节」: its sections count as covered when its questions are saved (the batch's own result), not while it is being written. */
export const rangePendingText = (r, units) => uiFormat('{0}（出完后计入覆盖）', [countOf(units, r.leaves)]);

/** 「覆盖 3/8 小节」 (「覆盖 3/8 页」 for pages): what a range of the material has, for a part of a run. */
export const rangeCoverageText = (r, units) => (units === 'page' ? uiFormat('覆盖 {0}/{1} 页', [r.covered, r.leaves]) : uiFormat('覆盖 {0}/{1} 小节', [r.covered, r.leaves]));

/** 「没有题的小节」 for a part's strip: each with the real reason, in reading order, cut to what fits (the whole list is the tooltip). */
export function uncoveredInRange(r, { recorded = true, max = 4 } = {}) {
  // What was planned and did not come out first (it has a reason), then what was never planned, each in reading order.
  const open = [...r.sections.filter((section) => section.state === 'planned-failed'), ...r.sections.filter((section) => section.state === 'never-planned')];
  if (!open.length) return '';
  const words = open.map((section) => uiFormat('{0}（{1}）', [sectionName(section), section.state === 'planned-failed' ? reasonWord(section.reason) : stateWord(section.state, recorded, !!section.scheduled)]));
  const shown = words.slice(0, max).join(ui('、'));
  return uiFormat('没有题的小节：{0}', [open.length > max ? uiFormat('{0} 等 {1} 个', [shown, open.length]) : shown]);
}

/** One line for the reader's 做这几页的题 panel: how much of the range has no question. */
export const rangeUncoveredLine = (uncovered, leaves, units) => (units === 'page'
  ? uiFormat('这几页里有 {0} 页还没有题（共 {1} 页）', [uncovered, leaves]) : uiFormat('其中 {0} 个小节还没有题（共 {1} 个）', [uncovered, leaves]));

/* ---------- the rounds of a run (lib/coverage-run.js): what the 任务 console's header, the draft page, the home row and the log say ---------- */

/** 「自动补到完整」: the one choice between a manual run (a button for each round) and a run that goes on by itself. */
export const autoLabel = () => ui('自动补到完整');

/** What the choice means, for a plan of `rounds` rounds: the line under the checkbox on the creation form. `first` ({ level, percent }) is what the first round alone covers of the material (the estimate's
    firstRoundSections over its leaves): with 自动补到完整 off the run stops there, and the line says so with that number (精简 stops at about 12% by design). */
export const autoLine = (auto, rounds, first) => (auto
  ? uiFormat('先出第 1 轮，剩下的 {0} 轮一轮接一轮自动做完；可以随时暂停，或停在这里（已出的题都保留）。', [Math.max(0, rounds - 1)])
  : Number.isFinite(first?.percent) ? uiFormat('{0}：先出第 1 轮，覆盖约 {1}%；点「自动补到完整」继续，或在草稿页点「为没覆盖的部分补题」一次补一轮（剩下 {2} 轮）。', [levelLabel(first.level), first.percent, Math.max(0, rounds - 1)])
    : uiFormat('只出第 1 轮；其余 {0} 轮在草稿页点「为没覆盖的部分补题」，一次补一轮。', [Math.max(0, rounds - 1)]));

/** On the draft page, for a run that is not going on by itself: what ticking 「自动补到完整」 does. */
export const autoStartLine = (left) => (left === 1 ? ui('勾选后，最后 1 轮会自动补完；可以随时暂停或停下。') : uiFormat('勾选后，剩下的 {0} 轮会一轮接一轮自动补完；可以随时暂停或停下。', [left]));

/** 「第 3/12 轮」 */
export const roundOfText = (round, rounds) => uiFormat('第 {0}/{1} 轮', [round, rounds]);

/** 「1.2M tok」 */
export const tokensText = (value) => uiFormat('{0} tok', [formatCompactTokens(Math.max(0, Math.round(Number(value) || 0)))]);

const minutesText = (minutes) => (minutes >= 90 ? uiFormat('{0} 小时 {1} 分钟', [Math.floor(minutes / 60), minutes % 60]) : uiFormat('{0} 分钟', [minutes]));

/** What is left, from the rounds done (「预计还要 2.0M tok、约 25 分钟」), or, with no history yet, from the estimate made before the run, said to be that. */
export function projectionText(projection) {
  if (!projection || !(projection.tokens > 0)) return '';
  if (projection.basis === 'estimate') return uiFormat('预计还要约 {0}（出题前的估算）', [tokensText(projection.tokens)]);
  return projection.minutes ? uiFormat('预计还要 {0}、约 {1}', [tokensText(projection.tokens), minutesText(projection.minutes)]) : uiFormat('预计还要 {0}', [tokensText(projection.tokens)]);
}

/**
 * What is left of a running run, from `runForecast` (lib/coverage-run.js), with the basis said: 「预计还要约 2.7M tok（按已跑的进度估算）」, or, before this run has a pace of its own, 「…（出题前的估算）」; when the two
 * differ by more than a quarter both are said: 「… · 出题前估 3.9M tok」. '' when nothing may be said.
 */
export function forecastText(forecast) {
  const tokens = forecast?.tokens;
  if (!(tokens?.left > 0)) return '';
  const head = uiFormat(forecast.basis === 'estimate' ? '预计还要约 {0}（出题前的估算）' : '预计还要约 {0}（按已跑的进度估算）', [tokensText(tokens.left)]);
  return forecast.preRun > 0 ? joinMeta([head, uiFormat('出题前估 {0}', [tokensText(forecast.preRun)])]) : head;
}

/** The sum behind the number, to be checked by eye: 「已用 1.5M + 还要约 2.4M ≈ 共约 3.9M tok」 (the parts are rounded to two digits, the whole is their sum). '' while nothing was used or nothing is said. */
export function forecastMath(forecast) {
  const tokens = forecast?.tokens;
  if (!(tokens?.left > 0) || !(tokens.used > 0)) return '';
  const compact = (value) => formatCompactTokens(Math.round(value));
  return uiFormat('已用 {0} + 还要约 {1} ≈ 共约 {2} tok', [compact(tokens.used), compact(tokens.left), compact(tokens.total)]);
}

/** The time left: a figure or a range, or plainly why there is none (too little progress, still queued, paused, nearly done). It is the pace of THIS run, not the limit of a round. */
export function forecastTime(time) {
  switch (time?.state) {
    case 'ok': {
      if (time.lowMin === time.highMin) return uiFormat('预计还要约 {0}', [minutesText(time.lowMin)]);
      return time.highMin < 90 ? uiFormat('预计还要约 {0}–{1} 分钟', [time.lowMin, time.highMin]) : uiFormat('预计还要约 {0}–{1}', [minutesText(time.lowMin), minutesText(time.highMin)]);
    }
    case 'thin': return ui('还没有足够的进度来估计时间');
    case 'queued': return ui('开始运行后才估计时间');
    case 'paused': return ui('已暂停，继续后再估计时间');
    case 'finishing': return ui('就快做完了');
    default: return '';
  }
}

/** 「第 1 轮完成，还有 11 轮」: a run that waits for the learner. */
export const waitingText = (facts) => uiFormat('第 {0} 轮完成，还有 {1} 轮', [facts.done, facts.left]);

/**
 * The line of a run, from `runFacts` (lib/coverage-run.js): 「第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 2.0M tok、约 25 分钟」. Paused, waiting, stopped, finished and interrupted runs say
 * where they are instead of the round that is being made. `interrupted`: the host stopped while it ran (the job is restored with 接着做). `forecast` (runForecast): the console says what is left from the
 * run's own progress (forecastText) instead of the projection of the rounds done; without one (the home row) it is the projection.
 */
export function runLine(facts, { interrupted = false, forecast } = {}) {
  if (!facts?.total) return '';
  const cover = Number.isFinite(facts.percent) ? uiFormat('覆盖 {0}%', [facts.percent]) : '', used = facts.tokensUsed > 0 ? uiFormat('已用 {0} tok', [formatCompactTokens(Math.round(facts.tokensUsed))]) : '';
  if (interrupted) return [uiFormat('中断于第 {0} 轮', [facts.round]), cover, used, uiFormat('接着做会从第 {0} 轮继续', [facts.round])].filter(Boolean).join(META_DOT);
  if (facts.ended) {
    const head = facts.state === 'stopped' ? uiFormat('停在第 {0} 轮之后', [Math.max(1, facts.done)]) : uiFormat('共 {0} 轮', [facts.done]);
    // A retry (补做) that made no question is said: the rounds that were made are not only the ones counted done.
    return [head, facts.state === 'stopped' && facts.fillsFailed > 0 && uiFormat('补做 {0} 次没成功', [facts.fillsFailed]), cover, facts.tokensUsed > 0 ? uiFormat('共用 {0} tok', [formatCompactTokens(Math.round(facts.tokensUsed))]) : ''].filter(Boolean).join(META_DOT);
  }
  if (facts.waiting) return [waitingText(facts), cover, used].filter(Boolean).join(META_DOT);
  const left = forecast !== undefined && forecast !== null ? forecastText(forecast) : projectionText(facts.projection);
  if (facts.state === 'paused') return [uiFormat('暂停于第 {0} 轮之后', [facts.pausedAfter ?? facts.done]), cover, used, left].filter(Boolean).join(META_DOT);
  return [roundOfText(facts.round, facts.rounds), cover, used, left].filter(Boolean).join(META_DOT);
}

/** 「补做了 1 次（第 2 轮）后，还有 2 页没出成题（第 18、19 页），已经停下；自动补题不再重试它们。」: how many retries were made and in which rounds, which sections are left. */
function sectionsLeftStop(stop) {
  const left = countOf(stop.unit || 'part', stop.left ?? 0), names = stop.names?.length ? uiFormat('（{0}）', [refsText(stop.names)]) : '';
  if (!Array.isArray(stop.fills)) return uiFormat('重试后，还有 {0}没出成题，已经停下。', [left]);
  if (!stop.fills.length) return uiFormat('这些小节之前已经失败过多次，自动补题不再重试，已经停下；还有 {0}没出成题{1}。', [left, names]);
  return uiFormat('补做了 {0} 次（{1}）后，还有 {2}没出成题{3}，已经停下；自动补题不再重试它们。', [stop.fills.length, uiFormat('第 {0} 轮', [stop.fills.join(ui('、'))]), left, names]);
}

/** Why a run stopped, in plain words (the stop of `runFacts`: { reason, round, left?, detail?, unit?, names?, fills? }). */
export function stopText(stop) {
  if (!stop?.reason) return '';
  const round = stop.round ?? 0, left = stop.left ?? 0, cause = failedWhy(stop.code || stop.detail);
  const text = ({
    complete: () => ui('出题计划做完了：计划里的每个小节都有题了。'),
    target: () => ui('已达到这档覆盖强度的目标，剩下的轮次不用再做了。'),
    learner: () => uiFormat('你在第 {0} 轮停了下来；已通过的题都保留。', [round]),
    budget: () => uiFormat('用到了你设的花费上限，在第 {0} 轮之后停下；已通过的题都保留。', [round]),
    'no-progress': () => (stop.uncredited > 0 ? uiFormat('第 {0} 轮保留了 {1} 道题，但它们没有对上任何还没有题的小节，没有新的进展，为免一直重复，已经停下；还有 {2} 个小节没有题，可以点「为没覆盖的部分补题」再试。', [round, stop.uncredited, left])
      : left > 0 ? uiFormat('第 {0} 轮重试后仍没有补到新的小节，为免一直重复，已经停下；还有 {1} 个小节没有题，可以点「为没覆盖的部分补题」再试。', [round, left])
      : uiFormat('第 {0} 轮重试后仍没有补到新的小节，为免一直重复，已经停下。', [round])),
    'sections-left': () => sectionsLeftStop(stop),
    // The key was refused: said once, in plain words, whatever the provider printed for each part.
    refused: () => (stop.code === 'quota' ? ui('模型账户的余额或额度不足，已经停下；已通过的题都保留。') : ui('模型服务拒绝了请求（密钥无效或没有权限），已经停下；已通过的题都保留。')),
    'round-failed': () => uiFormat('第 {0} 轮出错，已经停下；已通过的题都保留。', [round]),
  })[stop.reason];
  return text ? [text(), stop.reason === 'no-progress' || stop.reason === 'round-failed' ? cause : ''].filter(Boolean).join(' ') : '';
}

/* ---------- the shortfall (lib/shortfall.js): ONE set of sentences for the home banner, the 待发布 row, the 任务 console and the draft page ---------- */

/** 「已出 174/251 题」 for a draft that is short of its goal, 「174 道题」 for one that is not. */
export const questionsText = (s) => (s.questionsMissing > 0 ? uiFormat('已出 {0}/{1} 题', [s.questionsKept, s.questionsGoal]) : uiFormat('{0} 道题', [s.questionsKept]));

/** 「还有 18 个小节没有题」; a draft whose sections all have a question but fewer than its plan gave them says so instead. Only a draft with a PLAN promised sections: a plain run asked for a
    number of questions, and the sections of its material are a fact of the coverage (「覆盖 14%」), never a shortfall it is told about. */
export function sectionsLeftText(s) {
  if (s.planned === false) return '';
  if (s.sectionsUncovered > 0) return uiFormat('还有 {0}没有题', [countOf(s.units, s.sectionsUncovered)]);
  if (s.sectionsUnderQuota > 0) return uiFormat('{0}没出满计划的题数', [countOf(s.units, s.sectionsUnderQuota)]);
  return '';
}

/** 「下一轮补 15 个小节，还剩 3 个」: the round the one button runs, and what it leaves. */
export function nextRoundText(s) {
  if (!(s.nextRoundSections > 0)) return '';
  const covered = countOf(s.units, s.nextRoundSections);
  return s.sectionsAfterNextRound > 0 ? uiFormat('下一轮补 {0}，还剩 {1} 个', [covered, s.sectionsAfterNextRound]) : uiFormat('下一轮补 {0}', [covered]);
}

/** What 接着做 does, said before the button (the same sentence on the banner, the row, the console and the draft page): a plain run keeps what it made and makes the questions it still owes,
    「已出 13/15 题保留，接着补 2 题」; a run of rounds keeps it and goes on at the round that comes next. */
export function continueLine(s) {
  if (s.continueKind === 'count' && s.questionsMissing > 0) return uiFormat('已出 {0}/{1} 题保留，接着补 {2} 题', [s.questionsKept, s.questionsGoal, s.questionsMissing]);
  if (s.round) return uiFormat('已出 {0}/{1} 题保留，接着做从第 {2} 轮继续', [s.questionsKept, s.questionsGoal, s.round]);
  return uiFormat('已出 {0}/{1} 题保留，接着做会继续', [s.questionsKept, s.questionsGoal]);
}

/** The way from here to full coverage, said before a top-up starts (and on the strip of a run): 「覆盖现在 14/108 个小节（13%）→ 本轮后约 38% → 目标 100%，还要 4 轮、约 100 题」. All of it is the
    shortfall's (lib/shortfall.js: the one function that plans a round and says what the rest of the sections cost); '' while the coverage is not known. */
export function coveragePathText(s) {
  if (!(s?.roundsToFull > 0) || !(s.questionsToFull > 0) || !Number.isFinite(s.afterRoundPercent) || !Number.isFinite(s.coveragePercent) || !(s.sectionsTotal > 0)) return '';
  const now = `${s.sectionsCovered}/${countOf(s.units, s.sectionsTotal)}`;
  return s.roundsToFull === 1 ? uiFormat('覆盖现在 {0}（{1}%）→ 本轮后约 {2}% → 目标 100%，还要 1 轮、约 {3} 题', [now, s.coveragePercent, s.afterRoundPercent, s.questionsToFull])
    : uiFormat('覆盖现在 {0}（{1}%）→ 本轮后约 {2}% → 目标 100%，还要 {3} 轮、约 {4} 题', [now, s.coveragePercent, s.afterRoundPercent, s.roundsToFull, s.questionsToFull]);
}

/** The same way, said by a run that works (its rounds are the job's): 「覆盖现在 31% → 目标 100%，还要 3 轮、约 90 题」. */
export function runPathText(run) {
  if (!run?.total || run.ended || !Number.isFinite(run.percent) || !(run.left > 0) || !(run.questionsLeft > 0)) return '';
  return run.left === 1 ? uiFormat('覆盖现在 {0}% → 目标 100%，还要 1 轮、约 {1} 题', [run.percent, run.questionsLeft])
    : uiFormat('覆盖现在 {0}% → 目标 100%，还要 {1} 轮、约 {2} 题', [run.percent, run.left, run.questionsLeft]);
}

/** 「精简：先出第 1 轮，覆盖 12%；点「自动补到完整」继续」: what a run that waits for the learner (自动补到完整 is off) has done, and how it goes on. */
export const manualLine = (s) => uiFormat('{0}：先出第 {1} 轮，覆盖 {2}%；点「自动补到完整」继续', [levelLabel(s.level), Math.max(1, s.roundsDone || 1), s.coveragePercent ?? 0]);

/** The counts of a draft in one line: 「已出 174/251 题 · 还有 18 个小节没有题」. */
export const shortfallLine = (s) => joinMeta([questionsText(s), sectionsLeftText(s)]);

/** Why it stands still: the true reason a run stopped (or that it waits for the learner), in plain words. */
export function shortfallWhy(s) {
  if (s.reason === 'manual') return manualLine(s);
  if (s.state === 'refused' || s.state === 'cancelled' || s.state === 'stopped') return stopText(s.stop);
  return '';
}

/* 这几个小节反复失败: the sections a run no longer tries by itself (lib/shortfall.js `repeating`: they failed again and again, say the review's reply that never came back usable), each with its real
   reason, so the learner can try them later. */
export const repeatingHead = (n) => uiFormat('这几个小节反复失败 · {0}', [n]);
export const repeatingItem = (item) => uiFormat('{0}（{1}）', [sectionName(item), joinMeta([needGotText(item.short) || reasonWord(item.reason), triesText(item)])]);
export const repeatingNote = () => ui('自动补题不再重试它们，免得白白花费；想再试可以点「为没覆盖的部分补题」，它们排在最后。');
/** One line for the 任务 console: 「这几个小节反复失败：第六部分：…（审阅回复格式不对…）、… 等 4 个」. */
export function repeatingLine(s, max = 2) {
  const items = s.repeating || [];
  if (!items.length) return '';
  const shown = items.slice(0, max).map(repeatingItem).join(ui('、'));
  return uiFormat('这几个小节反复失败：{0}', [items.length > max ? uiFormat('{0} 等 {1} 个', [shown, items.length]) : shown]);
}

/** The words of the ONE primary action of a shortfall (lib/shortfall.js `action`). */
export const actionLabel = (action) => ({ resume: ui('继续'), continue: ui('接着做'), 'model-settings': ui('去配置模型'), topup: ui('为没覆盖的部分补题') })[action] || '';

/** What the row's badge says a draft is: what is true, never 「已复审，待发布」 for a draft that is short, stopped, refused or interrupted. */
const STOP_WORD = { learner: '你停下了', budget: '到花费上限', 'no-progress': '没有新进展', 'sections-left': '重试后仍没出成', 'round-failed': '出错了', 'time-limit': '用时到限', 'run-failed': '出错了' };
export function shortfallTag(s, { reviewed = false } = {}) {
  switch (s.state) {
    case 'paused': return ui('已暂停');
    case 'interrupted': return ui('已中断');
    case 'refused': return ui('模型拒绝');
    // The counts are in the line beside the badge: it says only that it stopped, and why.
    case 'cancelled': case 'stopped': return s.reason === 'manual' ? ui('等你补下一轮') : s.reason === 'no-plan' ? ui('待补齐') : joinMeta([ui('已停止'), STOP_WORD[s.reason] && ui(STOP_WORD[s.reason])]);
    default: if (s.questionsMissing > 0) return joinMeta([reviewed ? ui('已复审') : ui('待发布检查'), uiFormat('少了 {0} 题', [s.questionsMissing])]);
  }
  return reviewed ? ui('已复审，待发布') : ui('待发布检查');
}

/** The word of a round's state in the list of rounds. */
export const roundStatusWord = (status) => ({ pending: ui('待做'), running: ui('进行中'), done: ui('已完成'), failed: ui('没成功'), skipped: ui('已跳过') })[status] || '';

/** One row of the list of rounds: 「第 3 轮 · 8 题 · 5 个部分」 (「补做」 for a round that writes again the sections that did not come out). */
export function roundTitle(round) {
  return [round.fill ? uiFormat('补做 · 第 {0} 轮', [round.round]) : uiFormat('第 {0} 轮', [round.round]), uiFormat('{0} 题', [round.questions]),
    round.sections !== undefined ? countOf(round.unit || 'part', round.sections) : round.sectionIds ? countOf('part', round.sectionIds.length) : ''].filter(Boolean).join(META_DOT);
}

/** 「2/4 页」 (a round that knows how many sections it tried), else 「2 个小节」: what a round newly covered. */
const gainText = (covered, tried, unit) => (Number.isFinite(tried) && tried >= 0 && unit ? `${covered ?? 0}/${countOf(unit, tried)}` : countOf('part', covered ?? 0));

/** 「5 道题通过了审阅，但没有对上任何小节」: a round that kept questions and credited no section (`uncredited`, lib/coverage-run.js): said, never a bare 「新覆盖 0」. */
export const uncreditedText = (count) => (count > 0 ? uiFormat('{0} 道题通过了审阅，但没有对上任何小节', [count]) : '');

/** What a round did, once it has run: 「保留 8 题，新覆盖 5 个部分 · 0.4M tok · 4 分钟」; a failed round says why. */
export function roundResult(round) {
  if (round.status === 'pending' || round.status === 'running') return '';
  if (round.status === 'skipped') return ui('这一轮的小节都已经有题了');
  const head = uiFormat('保留 {0} 题，新覆盖 {1}', [round.kept ?? 0, gainText(round.covered, round.sections, round.unit)]);
  const minutes = round.ms > 0 ? minutesText(Math.max(1, Math.round(round.ms / 60000))) : '';
  const word = round.code || round.reason, reason = round.status === 'failed' ? (word === 'timeout' ? ui('这一轮用时到限') : failedWhy(word)) : '';
  return [head, uncreditedText(round.uncredited), round.tokens > 0 ? tokensText(round.tokens) : '', minutes, reason].filter(Boolean).join(META_DOT);
}

/** 「没出成题：第 18 页（要 3 个考点，只给出 1 个）、第 19 页（…）」: the sections a round was asked for and still has no question for, at most three named (the count says the rest). */
function lostText(a) {
  const list = Array.isArray(a.lost) ? a.lost.filter((item) => sectionName(item)) : [];
  if (!list.length) return '';
  const total = Number.isFinite(a.lostCount) ? a.lostCount : list.length, shown = list.slice(0, 3);
  const detailed = shown.some((item) => needGotText(item) || item.reason);
  // A section with its numbers is said with them; one with only a cause, with that; the rest by name (pages together).
  const body = detailed ? shown.map((item) => { const why = needGotText(item) || (item.reason ? reasonWord(item.reason) : ''); return why ? uiFormat('{0}（{1}）', [sectionName(item), why]) : sectionName(item); }).join(ui('、')) : refsText(shown);
  return uiFormat('没出成题：{0}', [total > shown.length ? uiFormat('{0} 等 {1} 个', [body, total]) : body]);
}

/** The log lines of a run (the codes the backend records, in the same words as everywhere else). */
export function runEventText(code, a = {}) {
  switch (code) {
    case 'round-start': {
      // A record that knows its unit names what the round holds (「4 页（第 3、7、18、19 页）」); a retry says which rounds left its sections without a question.
      const what = a.unit ? `${countOf(a.unit, a.sections)}${a.names?.length ? uiFormat('（{0}）', [refsText(a.names)]) : ''}` : countOf('part', a.sections);
      if (a.fill) return a.unit && a.from?.length ? uiFormat('补做第 {0} 轮开始 · 重试{1}里没出成题的 {2}，{3} 题', [a.round, uiFormat('第 {0} 轮', [a.from.join(ui('、'))]), what, a.questions]) : uiFormat('补做第 {0} 轮开始 · {1}，{2} 题', [a.round, what, a.questions]);
      return uiFormat('第 {0}/{1} 轮开始 · {2}，{3} 题', [a.round, a.rounds, what, a.questions]);
    }
    case 'round-end': {
      const gain = gainText(a.covered, a.tried, a.unit), failed = a.status === 'failed';
      const head = a.fill ? uiFormat(failed ? '补做第 {0} 轮没做成' : '补做第 {0} 轮完成', [a.round]) : uiFormat(failed ? '第 {0}/{1} 轮没做成' : '第 {0}/{1} 轮完成', [a.round, a.rounds]);
      const result = uiFormat('{0}：保留 {1} 题，新覆盖 {2}', [head, a.kept ?? 0, gain]);
      return (failed ? [result, uncreditedText(a.uncredited), failedWhy(a.code || a.reason), lostText(a)] : [result, uncreditedText(a.uncredited), uiFormat('覆盖 {0}%', [a.percent ?? 0]), lostText(a)]).filter(Boolean).join(META_DOT);
    }
    case 'round-rerun': return uiFormat('第 {0} 轮上次没有做完，这次从头重做（半成品不采用，已通过的题保留）', [a.round]);
    case 'run-paused': return uiFormat('暂停于第 {0} 轮之后：不再开始新的一轮', [a.after]);
    case 'run-resumed': return uiFormat('继续：开始第 {0} 轮', [a.next]);
    case 'run-waiting': return uiFormat('第 {0} 轮完成，还有 {1} 轮：点「为没覆盖的部分补题」继续', [a.round, a.left]);
    case 'run-interrupted': return uiFormat('上次运行在第 {0} 轮被中断；接着做会从第 {0} 轮重新开始，已通过的题保留', [a.round]);
    case 'run-stop': return stopText(a);
    // After the last round the draft is written once more, with the plan and the record of the run: a line when it starts and one when it is done, so the time between the last call and the end is not silent.
    case 'run-closing': return a.cards > 0 ? uiFormat('正在保存草稿（{0} 题）和这次运行的记录', [a.cards]) : ui('正在保存草稿和这次运行的记录');
    case 'run-closed': return a.ms >= 1000 ? uiFormat('草稿已保存 · 用了 {0}', [formatElapsed(a.ms)]) : ui('草稿已保存');
    default: return '';
  }
}
