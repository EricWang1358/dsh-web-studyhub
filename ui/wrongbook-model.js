import { ui, uiFormat } from './i18n.js';
import { normalizeTopic, deckShortTitles } from '../lib/recommend-text.js';
import { queryTokens } from './components/option-list.js';
import { plainPrompt } from './shared.js';
import { leechMisses } from '../lib/leech.js';
import { browserSession, browserStorage, readJSON, readText, removeKey, writeJSON, writeText } from './storage.js';

/* Pure helpers behind the wrong-book page: grouping, filtering, variant state,
   retrain options and the plain-language copy for recommendation reasons. */

export const VARIANT_BATCH_CAP = 8;
/** Matches lib/prereq.js SCOPE_LIMIT so WrongBook never sends an over-limit scope list into review.start (#928). */
export const PRACTICE_SCOPE_CAP = 200;
export const RECS_PREVIEW = 3;

export function capPracticeScope(refs = [], limit = PRACTICE_SCOPE_CAP) {
  const list = Array.isArray(refs) ? refs : [];
  return { scope: list.slice(0, limit), total: list.length, capped: list.length > limit, limit };
}

export function practiceCappedText(total, { group = false, limit = PRACTICE_SCOPE_CAP } = {}) {
  return group
    ? uiFormat('这一组有 {0} 道题，一次最多 {1} 道：先练前 {1} 道。', [total, limit])
    : uiFormat('共选了 {0} 道题，一次最多 {1} 道：先练前 {1} 道。', [total, limit]);
}
export const DEFAULT_GROUP_BY = 'deck';
/** From this many mistakes on the page offers its filter bar, grouping switch and fold-all; a shorter list is read as it stands. */
export const FILTER_MIN = 10;

/** What the page reads of a list to know it has changed: the counts and the newest row (the service sorts newest first, so a new, repeated or corrected
 * mistake always moves the first row or a count). A probe of one row and the full first page read the same. */
export function readSignature(res) {
  if (!res) return '';
  const first = res.items?.[0];
  return JSON.stringify([res.view, res.total, res.counts?.weak, res.counts?.history, res.gradedTotal, res.selfTotal, res.oralTotal, res.rubricTotal,
    first?.cardId ?? null, first?.recoveredAt ?? first?.lastAt ?? null]);
}

/** Short deck names, trimmed per course so "课程｜卷名｜90题" reads as "卷名". */
export function shortDeckNames(items, decks = []) {
  const courseOf = new Map(decks.map((deck) => [deck.id, deck.course ?? deck.folder ?? '']));
  const byCourse = new Map();
  for (const item of items) {
    const course = courseOf.get(item.deckId) ?? '';
    if (!byCourse.has(course)) byCourse.set(course, new Set());
    byCourse.get(course).add(item.deckTitle || item.deckId);
  }
  const names = new Map();
  for (const [course, titles] of byCourse) {
    const short = deckShortTitles([...titles], course);
    for (const title of titles) names.set(title, short.get(title));
  }
  return (title) => names.get(title || '') || title;
}

/**
 * Rows grouped by topic (merging the same topic across decks) or by deck.
 * Server order (newest miss first) is kept inside a group; larger groups first.
 */
export function groupRows(items = [], mode = 'topic', decks = []) {
  const short = shortDeckNames(items, decks);
  const map = new Map();
  for (const item of items) {
    const topicKey = normalizeTopic(item.topic);
    const key = mode === 'deck' ? `deck:${item.deckId}` : `topic:${topicKey || '*'}`;
    if (!map.has(key)) {
      map.set(key, { key, mode, title: mode === 'deck' ? short(item.deckTitle) : String(item.topic || '').trim() || ui('未分类'),
        unclassified: mode === 'topic' && !topicKey, rows: [], deckTitles: [], deckIds: [], latest: '' });
    }
    const group = map.get(key);
    group.rows.push(item);
    if (!group.deckIds.includes(item.deckId)) group.deckIds.push(item.deckId);
    const label = short(item.deckTitle);
    if (!group.deckTitles.includes(label)) group.deckTitles.push(label);
    if (item.lastAt > group.latest) group.latest = item.lastAt;
  }
  return [...map.values()].sort((a, b) => (mode === 'topic' ? b.rows.length - a.rows.length : 0) || (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
}

/** One card's variant state from the coach status. */
export function variantState(coach, cardId, pending) {
  const ready = (coach?.readyCards || []).filter((variant) => variant.originCardId === cardId);
  if (ready.length) return { kind: 'ready', count: ready.length, prompts: ready.map((variant) => variant.prompt) };
  if (pending?.has(cardId) || (coach?.preparingCards || []).includes(cardId)) return { kind: 'preparing' };
  const failed = (coach?.failedCards || []).find((entry) => entry.cardId === cardId);
  if (failed) return { kind: 'failed', message: failed.message };
  return { kind: 'none' };
}

/** The open rows whose detail nobody has asked for yet (after 刷新 dropped what was read): the page asks again, once per card, and never for one that is loading or failed. */
export const rowsAwaitingDetail = (items = [], expanded = new Set(), details = {}) =>
  items.filter((item) => expanded.has(item.cardId) && details[item.cardId] === undefined).map(({ deckId, cardId }) => ({ deckId, cardId }));

/** A backend failure sentence mapped to words the learner can act on. */
export function variantFailureText(message = '') {
  const text = String(message);
  if (/校验/.test(text)) return ui('这批变式没有通过质量检查。可以再试一次。');
  if (/备满|攒满/.test(text)) return ui('已备好的变式题已满，先去练掉一些');
  if (/超时|没有响应/.test(text)) return ui('模型这次没有响应。等一两分钟再试一次。');
  if (/限流|太频繁/.test(text)) return ui('模型请求太频繁。等一两分钟再试一次。');
  if (/后台执行器/.test(text)) return ui('后台服务这次没有回应。等一两分钟再试一次。');
  if (/暂时不可用|没有返回内容/.test(text)) return ui('服务这次不可用。等一两分钟再试一次。');
  return ui('这次没有生成成功。可以再试一次。');
}

/** Why a similar question is recommended, as one short phrase. */
export function reasonText(reason) {
  switch (reason?.type) {
    case 'topic': return uiFormat('同主题：{0}', [reason.topic]);
    case 'page': return uiFormat('引用同一页：{0} 第 {1} 页', [reason.sourceTitle, reason.page]);
    case 'near': return uiFormat('引用相邻页：{0} 第 {1} 页', [reason.sourceTitle, reason.page]);
    case 'terms': return uiFormat('关键词相近：{0}', [(reason.terms || []).join('、')]);
    case 'source': return uiFormat('引用同一份资料：{0}', [reason.sourceTitle]);
    default: return '';
  }
}

/**
 * The three ways to retrain. Extras that do not exist are disabled, with the reason the page gives on hover and focus; the
 * default is the richest one available: your own variants, then similar questions.
 */
export function retrainOptions({ mistakes, similar, variants, paged }) {
  const options = [
    { value: 'wrong', count: mistakes, extra: 0,
      label: uiFormat(paged ? '只练本页错题 ({0})' : '只练错题 ({0})', [mistakes]) },
    { value: 'similar', count: mistakes + similar, extra: similar,
      label: uiFormat(paged ? '本页错题 + 同类题 ({0}+{1})' : '错题 + 同类题 ({0}+{1})', [mistakes, similar]),
      ...(similar ? {} : { disabled: true, reason: ui('题库里没有找到合适的同类题') }) },
    { value: 'variants', count: mistakes + variants, extra: variants,
      label: uiFormat(paged ? '本页错题 + 变式 ({0}+{1})' : '错题 + 变式 ({0}+{1})', [mistakes, variants]),
      ...(variants ? {} : { disabled: true, reason: ui('还没有生成变式') }) },
  ];
  const fallback = variants ? 'variants' : similar ? 'similar' : 'wrong';
  return { options, fallback };
}

/* ---- status, filters and what a folded group says about itself ---- */

/** The kinds of low outcome a row can carry, in display order: 答错 (auto-graded), 未掌握 (self-rated), then oral and rubric. */
export const STATUS_KINDS = ['graded', 'self', 'oral', 'rubric'];

/** A row's kind: the one its label has always shown. Anything that is not graded, oral or rubric reads as 未掌握. */
export function statusOf(item) {
  return item?.assessment === 'oral' ? 'oral' : item?.assessment === 'rubric' ? 'rubric' : item?.assessment === 'graded' ? 'graded' : 'self';
}

export function statusLabel(kind) {
  switch (kind) {
    case 'graded': return ui('答错');
    case 'oral': return ui('口头评估');
    case 'rubric': return ui('批改未达标');
    default: return ui('未掌握');
  }
}

/** How many rows of each kind. */
export function statusCounts(rows = []) {
  const counts = { graded: 0, self: 0, oral: 0, rubric: 0 };
  for (const item of rows) counts[statusOf(item)]++;
  return counts;
}

/** The kinds present in a group, as [{ kind, count }] without zeros. */
export const groupSummary = (rows = []) => {
  const counts = statusCounts(rows);
  return STATUS_KINDS.filter((kind) => counts[kind] > 0).map((kind) => ({ kind, count: counts[kind] }));
};

/** "答错 2 · 未掌握 1". */
export const groupSummaryText = (rows = []) => groupSummary(rows).map(({ kind, count }) => `${statusLabel(kind)} ${count}`).join(' · ');

/** The page's filter: one deck, one status ('all' or a kind), words that must all appear in the question or its topic, and `leech`: only the 顽固题. */
export const NO_FILTER = Object.freeze({ deck: '', status: 'all', query: '', leech: false, only: null });

export const filterActive = (filter) => !!filter && (!!filter.deck || (!!filter.status && filter.status !== 'all') || !!filter.leech || Array.isArray(filter.only) || queryTokens(filter.query).length > 0);

/** The rows a filter lets through, in their order. Cloze markers are not question text; the same rule as the list. */
export function filterRows(rows = [], filter = NO_FILTER) {
  if (!filterActive(filter)) return rows;
  const words = queryTokens(filter.query);
  const only = Array.isArray(filter.only) ? new Set(filter.only.map(refKey)) : null;
  return rows.filter((item) => {
    if (filter.deck && item.deckId !== filter.deck) return false;
    if (filter.status && filter.status !== 'all' && statusOf(item) !== filter.status) return false;
    if (filter.leech && !item.leech) return false;
    if (only && !only.has(refKey(item))) return false;
    if (!words.length) return true;
    const text = `${plainPrompt(item.prompt)}
${item.topic ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/* ---- 顽固题 (lib/leech.js): the service marks a row `leech`; these are the page's words and count for it ---- */

const ARRIVAL_KEY = (root) => `study-wrongbook-arrival:v1:${JSON.stringify([root || ''])}`;
/** A question as the page and the service name it, one key for a set of them. */
export const refKey = ({ deckId, cardId }) => JSON.stringify([deckId, cardId]);

/** Another page (the result page of a round, ui/Review.jsx) asks the wrong book to open on exactly these questions (`refs`: [{ deckId, cardId }], the 顽固题 it just
 *  counted): written before navigating, kept for this tab. Nothing is written without a library root or without questions. */
export function askForLeeches(root, refs, storage = browserSession()) {
  const list = (refs || []).map(({ deckId, cardId }) => ({ deckId, cardId }));
  return !!root && list.length > 0 && writeJSON(ARRIVAL_KEY(root), { refs: list }, storage);
}
/** The wrong book, on opening: the questions it was asked to open on (`{ refs }`, or `{}`), and forgets the request, so the next visit starts clean. Without a root
 *  (the library is still loading) it reads and takes nothing: the request waits under the real root. */
export function takeArrival(root, storage = browserSession()) {
  if (!root) return {};
  const saved = readJSON(ARRIVAL_KEY(root), null, storage);
  if (saved === null) return {};
  removeKey(ARRIVAL_KEY(root), storage);
  const refs = Array.isArray(saved?.refs) ? saved.refs.filter((ref) => ref && typeof ref.deckId === 'string' && typeof ref.cardId === 'string') : [];
  return refs.length ? { refs } : {};
}

/** How many of these rows are 顽固题. */
export const leechCount = (rows = []) => (rows || []).filter((item) => item.leech).length;

/** What the 顽固 mark says, from the learner's own thresholds ({ failures, window, rate } of lib/leech.js leechLimits): one sentence, and what follows from it. */
export const leechWords = ({ failures, window, rate }) => ({
  sentence: uiFormat('累计答错 {0} 次，或最近 {1} 次作答里答错 {2} 次以上（{3}%；作答不满 {1} 次时也这样算）。', [failures, window, leechMisses({ window, rate }), rate]),
  consequence: uiFormat('最近 {0} 次全部答对后，这个标记就会消失。题目本身也可能有问题：展开这一行，有几个办法。', [window]),
});

/** Whether a 顽固题 rescue click can run right now, or should first offer inline model setup / inline background-prep consent (#963). */
export function rescueGate(kind, { modelReady = true, consent = false } = {}) {
  if (kind === 'pause') return { type: 'run' };
  if (!modelReady) {
    return {
      type: 'no-model',
      kind,
      text: kind === 'fix'
        ? ui('还没有可用的 AI 模型，修题要先配好模型；配好后回到这里再点一次。')
        : ui('还没有可用的 AI 模型，补前置小卡要先配好模型；配好后回到这里再点一次。'),
    };
  }
  if (kind === 'easier' && consent !== true) return { type: 'consent', kind: 'easier' };
  return { type: 'run' };
}

/** The service call of each of 顽固题's rescue actions, each one that already exists elsewhere: the 👎 record that starts the background repair (no `rewriteVia`: this
 *  page has no 修题 box to open, so the silent repair of the coach is what "this question has a problem" is here), the same record for "too hard" (it prepares a
 *  prerequisite card once preparation is agreed), and the suspend of the manage page. `ref`: { deckId, cardId }. */
export const rescueCall = (kind, ref, { consent = false, flush = false } = {}) => kind === 'pause'
  ? { action: 'card.suspend', args: { ...ref, suspended: true } }
  : {
    action: 'coach.feedback',
    args: {
      ...ref,
      vote: 'down',
      tags: [kind === 'fix' ? 'general-quality' : 'too-hard'],
      ...(consent ? { consent: true } : {}),
      ...(flush ? { flush: true } : {}),
    },
  };

/** The way back from a suspend: the same call with the flag off (the manage page's 恢复学习). */
export const undoPauseCall = (ref) => ({ action: 'card.suspend', args: { ...ref, suspended: false } });

/** What to tell the learner after a rescue click, from what the service answered: { tone, text }. Only what happened is said. */
export function rescueNote(kind, result) {
  if (kind === 'pause') return { tone: 'success', text: ui('已暂停这道题：它不再出现在练习和错题里。在题组的管理页点「恢复学习」可以恢复。') };
  const recorded = (result?.tags || []).length > 0, scheduled = result?.scheduled || [];
  if (kind === 'fix') {
    if (scheduled.includes('rewrite')) return { tone: 'success', text: ui('已交给后台修这道题，会直接改这张卡。完成时信箱会提醒你，在信箱里可以一步撤销。') };
    return { tone: 'info', text: recorded ? ui('已记下这个反馈，但当前没有可用的模型，所以没有开始修题。') : ui('刚刚已经为这道题记过同样的反馈，不会重复修题。') };
  }
  if (scheduled.includes('prep')) return { tone: 'success', text: ui('已记下，会为这道题准备一张更基础的前置小卡，写好后放进「为你定制」。') };
  return { tone: 'info', text: recorded ? ui('已记下这个反馈。要准备前置小卡，需要先在「设置 › 学习画像与导览」同意后台准备，并且有可用的模型。') : ui('刚刚已经为这道题记过同样的反馈。') };
}

/** The decks that have mistakes, for the deck picker: [{ value, label, count }], newest miss first. */
export function deckChoices(rows = [], decks = []) {
  return groupRows(rows, 'deck', decks).map((group) => ({ value: group.deckIds[0], label: group.title, count: group.rows.length }));
}

/** The filter of `state` ({ scope, filter }) when it was made in this scope; another course scope starts clean. */
export const scopedFilter = (state, scope) => (state && state.scope === scope ? state.filter : NO_FILTER);

/** Two variant states that say the same thing (a poll builds a new object every time). */
export function sameVariantState(a, b) {
  if (a === b) return true;
  return a.kind === b.kind && a.count === b.count && a.message === b.message
    && (a.prompts === b.prompts || (a.prompts?.length === b.prompts?.length && (a.prompts || []).every((prompt, index) => prompt === b.prompts[index])));
}

/* ---- what the learner chose, kept in the browser ---- */

const GROUP_BY_KEY = 'study-wrongbook-groupby';
const OPEN_CAP = 500;

/** The grouping the learner chose last time (kept per viewer), else by deck. A missing, blocked or corrupt store is the default. */
export function readGroupBy(storage = browserStorage()) {
  const saved = readText(GROUP_BY_KEY, '', storage);
  return saved === 'topic' || saved === 'deck' ? saved : DEFAULT_GROUP_BY;
}

export const saveGroupBy = (value, storage = browserStorage()) => writeText(GROUP_BY_KEY, value, storage);

/** The ids of the groups the learner opened in this tab (kept for the session under `key`). */
export function readOpenGroups(key, storage = browserSession()) {
  const saved = key ? readJSON(key, [], storage) : [];
  return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string').slice(0, OPEN_CAP) : []);
}

export const saveOpenGroups = (key, open, storage = browserSession()) => !!key && writeJSON(key, [...open].slice(0, OPEN_CAP), storage);
