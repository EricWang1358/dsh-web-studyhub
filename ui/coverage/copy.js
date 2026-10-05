import { ui, uiFormat } from '../i18n.js';
import { META_DOT } from '../format.js';
import { formatCompactTokens } from '../../lib/token-usage.js';

/* 覆盖: the words of coverage, written ONCE (README docs/plans/coverage-generation). The 任务 console's 资料部分, the draft page, the 资料 row, the reader's toolbar, outline and
   practice popover all say it through these functions, so one fact has one wording on every screen. Coverage is "asked" (a section has a question), mastery is "learned"
   (how the learner did on it): the words never mix the two. */

/* How many of a unit: the unit is what lib/coverage.js says the sections are (units). English has a singular, so each is two literals. */
const COUNT = {
  part: [() => ui('1 个部分'), (n) => uiFormat('{0} 个部分', [n])],
  page: [() => ui('1 页'), (n) => uiFormat('{0} 页', [n])],
  chapter: [() => ui('1 个章节'), (n) => uiFormat('{0} 个章节', [n])],
  heading: [() => ui('1 个小节'), (n) => uiFormat('{0} 个小节', [n])],
  window: [() => ui('1 个片段'), (n) => uiFormat('{0} 个片段', [n])],
  section: [() => ui('1 个小节'), (n) => uiFormat('{0} 个小节', [n])],
};

/** "80 个部分" / "80 parts": `n` of the units a coverage counts. */
export const countOf = (units, n) => { const [one, many] = COUNT[units] || COUNT.section; return n === 1 ? one() : many(n); };

/** What a coverage level is called (lib/coverage-strength.js): the three words of the 覆盖强度 choice. */
export function levelLabel(value) { return ({ lean: ui('精简'), standard: ui('标准'), full: ui('完整') })[value] || ''; }

/** The head of the list of what has no question, and what is said when nothing is left, in the unit of the material. */
const UNCOVERED = { part: (n) => uiFormat('没覆盖的部分 · {0}', [n]), page: (n) => uiFormat('没覆盖的页 · {0}', [n]), chapter: (n) => uiFormat('没覆盖的章节 · {0}', [n]),
  heading: (n) => uiFormat('没覆盖的小节 · {0}', [n]), window: (n) => uiFormat('没覆盖的片段 · {0}', [n]), section: (n) => uiFormat('没覆盖的小节 · {0}', [n]) };
export const uncoveredHead = (units, n) => (UNCOVERED[units] || UNCOVERED.section)(n);
const ALL = { part: () => ui('每个部分都有题了。'), page: () => ui('每一页都有题了。'), chapter: () => ui('每个章节都有题了。'), heading: () => ui('每个小节都有题了。'),
  window: () => ui('每个片段都有题了。'), section: () => ui('每个小节都有题了。') };
export const allCoveredText = (units) => (ALL[units] || ALL.section)();

/** 「覆盖 7/80 个部分（9%）」 */
export const coverageHead = (c) => uiFormat('覆盖 {0}/{1}（{2}%）', [c.covered, countOf(c.units, c.leaves), c.percentLeaves]);

/** 「3 个计划了没出成」, 「70 个没计划到」: the rest of the line. A draft from before plans were kept says 「没有记录」 for what it cannot tell. */
export const plannedFailedText = (n) => uiFormat('{0} 个计划了没出成', [n]);
export const neverPlannedText = (n, recorded = true) => (recorded ? uiFormat('{0} 个没计划到', [n]) : uiFormat('{0} 个没有记录', [n]));

/** 「70 个排在后面的轮次」: the sections the draft's plan (editorial.coverageSpec) puts in a later round, which has not been run yet. They are planned, not "never planned". */
export const scheduledText = (n) => uiFormat('{0} 个排在后面的轮次', [n]);

/** 「覆盖 7/80 个部分（9%）· 3 个计划了没出成 · 70 个没计划到」; a draft with a plan says 「… · 60 个排在后面的轮次 · 10 个没计划到」. */
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
const REASON_WORD = { 'plan-short': '这一节能出的考点不够数', quote: '引用在资料里找不到', plan: '考点规划未通过检查', quality: '题没有通过质量审阅', 'review-protocol': '审阅回复格式不对，重新审阅后仍不行',
  timeout: '模型长时间没有回应', 'rate-limit': '被模型服务限流', 'no-reply': '模型没有返回内容', quota: '模型账户余额或额度不足', credential: '模型密钥缺失或被拒绝',
  budget: '生成用时到限', cancelled: '被停止', unavailable: '模型服务暂时不可用', other: '其他原因' };
export const reasonWord = (code) => ui(REASON_WORD[code] || REASON_WORD.other);

/* Why a section has the questions it has: the plan of the draft (`editorial.coverageSpec`, lib/coverage-plan.js) rides on each section as `weight` { importance, kind, reason, source, quota, why }. */
const KIND_WORD = { definition: '定义', method: '方法', example: '例子', summary: '小结', chatter: '闲聊' };
const WHY_WORD = { floor: '每个部分至少一题', long: '篇幅较长', important: '重点部分' };

/** The one line under a section's name: 「重要性 4/5 · 定义 · 计划 4 题 — 这是核心定义」; a section the model did not rate says it was shared out by length. */
export function weightLine(weight) {
  if (!weight || typeof weight !== 'object') return '';
  const quota = Number.isInteger(weight.quota) ? uiFormat('计划 {0} 题', [weight.quota]) : ui('不在这次的计划内');
  const rated = weight.source === 'model' && weight.importance >= 1;
  const head = rated ? [uiFormat('重要性 {0}/5', [weight.importance]), KIND_WORD[weight.kind] && ui(KIND_WORD[weight.kind]), quota].filter(Boolean).join(META_DOT) : [ui('按篇幅分配'), quota].filter(Boolean).join(META_DOT);
  const why = rated && weight.reason ? weight.reason : WHY_WORD[weight.why] ? ui(WHY_WORD[weight.why]) : '';
  return why ? uiFormat('{0} — {1}', [head, why]) : head;
}

/** The plan of a draft in one line: 「出题计划：标准，约 343 题，分 12 轮（重要性由模型判断）」. */
export function planLine(spec) {
  if (!spec?.goal) return '';
  const source = spec.weightSource === 'model' ? ui('重要性由模型判断') : spec.weightSource === 'mixed' ? ui('部分按篇幅分配') : ui('按篇幅分配，没有用模型判断重要性');
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

/** What the choice means, for a plan of `rounds` rounds: the line under the checkbox on the creation form and on the draft page. */
export const autoLine = (auto, rounds) => (auto
  ? uiFormat('先出第 1 轮，剩下的 {0} 轮一轮接一轮自动做完；可以随时暂停，或停在这里（已出的题都保留）。', [Math.max(0, rounds - 1)])
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

/** 「第 1 轮完成，还有 11 轮」: a run that waits for the learner. */
export const waitingText = (facts) => uiFormat('第 {0} 轮完成，还有 {1} 轮', [facts.done, facts.left]);

/**
 * The line of a run, from `runFacts` (lib/coverage-run.js): 「第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 2.0M tok、约 25 分钟」. Paused, waiting, stopped, finished and interrupted runs say
 * where they are instead of the round that is being made. `interrupted`: the host stopped while it ran (the job is restored with 接着做).
 */
export function runLine(facts, { interrupted = false } = {}) {
  if (!facts?.total) return '';
  const cover = Number.isFinite(facts.percent) ? uiFormat('覆盖 {0}%', [facts.percent]) : '', used = facts.tokensUsed > 0 ? uiFormat('已用 {0} tok', [formatCompactTokens(Math.round(facts.tokensUsed))]) : '';
  if (interrupted) return [uiFormat('中断于第 {0} 轮', [facts.round]), cover, used, uiFormat('接着做会从第 {0} 轮继续', [facts.round])].filter(Boolean).join(META_DOT);
  if (facts.ended) {
    const head = facts.state === 'stopped' ? uiFormat('停在第 {0} 轮之后', [Math.max(1, facts.done)]) : uiFormat('共 {0} 轮', [facts.done]);
    return [head, cover, facts.tokensUsed > 0 ? uiFormat('共用 {0} tok', [formatCompactTokens(Math.round(facts.tokensUsed))]) : ''].filter(Boolean).join(META_DOT);
  }
  if (facts.waiting) return [waitingText(facts), cover, used].filter(Boolean).join(META_DOT);
  if (facts.state === 'paused') return [uiFormat('暂停于第 {0} 轮之后', [facts.pausedAfter ?? facts.done]), cover, used, projectionText(facts.projection)].filter(Boolean).join(META_DOT);
  return [roundOfText(facts.round, facts.rounds), cover, used, projectionText(facts.projection)].filter(Boolean).join(META_DOT);
}

/** Why a run stopped, in plain words (the stop of `runFacts`: { reason, round, left?, detail? }). */
export function stopText(stop) {
  if (!stop?.reason) return '';
  const round = stop.round ?? 0, detail = stop.detail ? uiFormat('原因：{0}', [stop.detail]) : '';
  const text = ({
    complete: () => ui('出题计划做完了：计划里的每个部分都有题了。'),
    target: () => ui('已达到这档覆盖强度的目标，剩下的轮次不用再做了。'),
    learner: () => uiFormat('你在第 {0} 轮停了下来；已通过的题都保留。', [round]),
    budget: () => uiFormat('用到了你设的花费上限，在第 {0} 轮之后停下；已通过的题都保留。', [round]),
    'no-progress': () => uiFormat('第 {0} 轮重试后仍没有补到新的部分，为免一直重复，已经停下。', [round]),
    'sections-left': () => uiFormat('重试了几轮，还有 {0} 个部分没出成题，已经停下。', [stop.left ?? 0]),
    refused: () => ui('模型服务拒绝了请求（密钥或额度），已经停下；已通过的题都保留。'),
    'round-failed': () => uiFormat('第 {0} 轮出错，已经停下；已通过的题都保留。', [round]),
  })[stop.reason];
  return text ? [text(), stop.reason === 'no-progress' || stop.reason === 'round-failed' || stop.reason === 'refused' ? detail : ''].filter(Boolean).join(' ') : '';
}

/** The word of a round's state in the list of rounds. */
export const roundStatusWord = (status) => ({ pending: ui('待做'), running: ui('进行中'), done: ui('已完成'), failed: ui('没成功'), skipped: ui('已跳过') })[status] || '';

/** One row of the list of rounds: 「第 3 轮 · 8 题 · 5 个部分」 (「补做」 for a round that writes again the sections that did not come out). */
export function roundTitle(round) {
  return [round.fill ? uiFormat('补做 · 第 {0} 轮', [round.round]) : uiFormat('第 {0} 轮', [round.round]), uiFormat('{0} 题', [round.questions]),
    round.sections !== undefined ? countOf('part', round.sections) : round.sectionIds ? countOf('part', round.sectionIds.length) : ''].filter(Boolean).join(META_DOT);
}

/** What a round did, once it has run: 「保留 8 题，新覆盖 5 个部分 · 0.4M tok · 4 分钟」; a failed round says why. */
export function roundResult(round) {
  if (round.status === 'pending' || round.status === 'running') return '';
  if (round.status === 'skipped') return ui('这一轮的部分都已经有题了');
  const head = uiFormat('保留 {0} 题，新覆盖 {1} 个部分', [round.kept ?? 0, round.covered ?? 0]);
  const minutes = round.ms > 0 ? minutesText(Math.max(1, Math.round(round.ms / 60000))) : '';
  const reason = round.status === 'failed' ? (round.reason === 'timeout' ? ui('这一轮用时到限') : round.reason === 'cancelled' ? ui('被停止') : round.reason ? uiFormat('原因：{0}', [round.reason]) : '') : '';
  return [head, round.tokens > 0 ? tokensText(round.tokens) : '', minutes, reason].filter(Boolean).join(META_DOT);
}

/** The log lines of a run (the codes the backend records, in the same words as everywhere else). */
export function runEventText(code, a = {}) {
  switch (code) {
    case 'round-start': return a.fill ? uiFormat('补做第 {0} 轮开始 · {1}，{2} 题', [a.round, countOf('part', a.sections), a.questions]) : uiFormat('第 {0}/{1} 轮开始 · {2}，{3} 题', [a.round, a.rounds, countOf('part', a.sections), a.questions]);
    case 'round-end': return a.status === 'failed'
      ? [uiFormat('第 {0}/{1} 轮没做成：保留 {2} 题，新覆盖 {3} 个部分', [a.round, a.rounds, a.kept ?? 0, a.covered ?? 0]), a.reason ? uiFormat('原因：{0}', [a.reason === 'timeout' ? ui('这一轮用时到限') : a.reason]) : ''].filter(Boolean).join(META_DOT)
      : uiFormat('第 {0}/{1} 轮完成：保留 {2} 题，新覆盖 {3} 个部分 · 覆盖 {4}%', [a.round, a.rounds, a.kept ?? 0, a.covered ?? 0, a.percent ?? 0]);
    case 'round-rerun': return uiFormat('第 {0} 轮上次没有做完，这次从头重做（半成品不采用，已通过的题保留）', [a.round]);
    case 'run-paused': return uiFormat('暂停于第 {0} 轮之后：不再开始新的一轮', [a.after]);
    case 'run-resumed': return uiFormat('继续：开始第 {0} 轮', [a.next]);
    case 'run-waiting': return uiFormat('第 {0} 轮完成，还有 {1} 轮：点「为没覆盖的部分补题」继续', [a.round, a.left]);
    case 'run-interrupted': return uiFormat('上次运行在第 {0} 轮被中断；接着做会从第 {0} 轮重新开始，已通过的题保留', [a.round]);
    case 'run-stop': return stopText(a);
    default: return '';
  }
}
