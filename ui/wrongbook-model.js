import { ui, uiFormat } from './i18n.js';
import { normalizeTopic, deckShortTitles } from '../lib/recommend-text.js';
import { queryTokens } from './components/option-list.js';
import { plainPrompt } from './shared.js';
import { browserSession, browserStorage, readJSON, readText, writeJSON, writeText } from './storage.js';

/* Pure helpers behind the wrong-book page: grouping, filtering, variant state,
   retrain options and the plain-language copy for recommendation reasons. */

export const VARIANT_BATCH_CAP = 8;
export const RECS_PREVIEW = 3;
export const DEFAULT_GROUP_BY = 'deck';

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

/** A backend failure sentence mapped to words the learner can act on. */
export function variantFailureText(message = '') {
  const text = String(message);
  if (/校验/.test(text)) return ui('这批变式没有通过质量校验，重试一次通常就好');
  if (/备满|攒满/.test(text)) return ui('已备好的变式题已满，先去练掉一些');
  if (/超时|没有响应/.test(text)) return ui('模型长时间没有响应，可以稍后重试');
  if (/限流|太频繁/.test(text)) return ui('模型请求太频繁，稍等一会儿再试');
  if (/暂时不可用|没有返回内容/.test(text)) return ui('模型服务暂时不可用，稍后重试');
  return ui('这次没有生成成功，可以重试');
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
 * The three ways to retrain. Extras that do not exist are disabled; the default
 * is the richest one available: your own variants, then similar questions.
 */
export function retrainOptions({ mistakes, similar, variants, paged }) {
  const options = [
    { value: 'wrong', count: mistakes, extra: 0,
      label: uiFormat(paged ? '只练本页错题 ({0})' : '只练错题 ({0})', [mistakes]) },
    { value: 'similar', count: mistakes + similar, extra: similar,
      label: uiFormat(paged ? '本页错题 + 同类题 ({0}+{1})' : '错题 + 同类题 ({0}+{1})', [mistakes, similar]),
      ...(similar ? {} : { disabled: true, title: ui('题库里暂时没有合适的同类题') }) },
    { value: 'variants', count: mistakes + variants, extra: variants,
      label: uiFormat(paged ? '本页错题 + 变式 ({0}+{1})' : '错题 + 变式 ({0}+{1})', [mistakes, variants]),
      ...(variants ? {} : { disabled: true, title: ui('还没有备好的变式，先点「生成变式」') }) },
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

/** The page's filter: one deck, one status ('all' or a kind), and words that must all appear in the question or its topic. */
export const NO_FILTER = Object.freeze({ deck: '', status: 'all', query: '' });

export const filterActive = (filter) => !!filter && (!!filter.deck || (!!filter.status && filter.status !== 'all') || queryTokens(filter.query).length > 0);

/** The rows a filter lets through, in their order. Cloze markers are not question text; the same rule as the list. */
export function filterRows(rows = [], filter = NO_FILTER) {
  if (!filterActive(filter)) return rows;
  const words = queryTokens(filter.query);
  return rows.filter((item) => {
    if (filter.deck && item.deckId !== filter.deck) return false;
    if (filter.status && filter.status !== 'all' && statusOf(item) !== filter.status) return false;
    if (!words.length) return true;
    const text = `${plainPrompt(item.prompt)}
${item.topic ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
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
