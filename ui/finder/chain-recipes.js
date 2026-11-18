// @ts-check
/* Situation-aware learning-chain recipes for 找功能 (#1143): pure 0-token mapping from current library state onto real Finder entries. */
import { countDocuments } from '../../lib/source-groups.js';

export const CHAIN_RECIPE_SPECS = Object.freeze([
  Object.freeze({
    id: 'kickoff',
    title: '刚加新资料，先搭起第一轮练习',
    steps: Object.freeze([
      Object.freeze({ entryId: 'page-sources', why: '先把讲义、课件或课堂笔记放进资料库，长 PDF 也能按章打开。' }),
      Object.freeze({ entryId: 'interactive-companions', why: '难啃的章节先做成逐句互动伴学课，边调参数或看反例边读懂。' }),
      Object.freeze({ entryId: 'page-generate', why: '选好刚读完的资料出题，发布后马上进入第一轮练习。' }),
    ]),
  }),
  Object.freeze({
    id: 'reading-loop',
    title: '边读讲义边提问，读完几页当场自测',
    steps: Object.freeze([
      Object.freeze({ entryId: 'selection-ask', why: '读到卡壳的段落直接划词追问，把关键解释存成批注留在原处。' }),
      Object.freeze({ entryId: 'practice-pages', why: '刚读完这几页就趁热练关联题；还没有题时原处直接补出。' }),
      Object.freeze({ entryId: 'reader-wrong', why: '集中回看这份资料里还没巩固的题，点一下跳回它考的那一段。' }),
    ]),
  }),
  Object.freeze({
    id: 'clear-mistakes',
    title: '刚刷完题有错漏，集中清掉薄弱点',
    steps: Object.freeze([
      Object.freeze({ entryId: 'retrain', why: '把待巩固的错题连同题库里的同类题排成一轮，趁余温再闯一遍。' }),
      Object.freeze({ entryId: 'leech', why: '反复答错的题拆开处理：交给后台修题、补一道前置基础题或回看原文。' }),
      Object.freeze({ entryId: 'variants', why: '换个问法再考一次同一个考点，确认是真懂而不是背下了原题。' }),
    ]),
  }),
  Object.freeze({
    id: 'exam-sprint',
    title: '考前突击查漏，限时模考检验底线',
    steps: Object.freeze([
      Object.freeze({ entryId: 'page-book', why: '把整门课的考点、问答与易错点串成一本书通读，顺手查漏补缺。' }),
      Object.freeze({ entryId: 'book-cheat-sheet', why: '把易混对照、公式与术语卡收成两栏速查页，考前快速过一遍。' }),
      Object.freeze({ entryId: 'page-exam', why: '按真实题型与时限做一套笔试、案例卷或口头面试，交卷看逐题解析。' }),
    ]),
  }),
]);

/** Summarize library readiness into a deterministic situation recommendation (zero model calls). */
export function summarizeChainState(data) {
  const ownSources = (Array.isArray(data?.sources) ? data.sources : []).filter((src) => src && !src.sample);
  const docCount = countDocuments(ownSources);
  const activeDecks = (Array.isArray(data?.decks) ? data.decks : []).filter(
    (deck) => deck && !deck.archived && !deck.inactive && !deck.sample,
  );
  const questionCount = activeDecks.reduce((sum, deck) => sum + (Number(deck?.available ?? deck?.count) || 0), 0);
  const wrongCount = activeDecks.reduce((sum, deck) => sum + (Number(deck?.wrong) || 0), 0);
  const deckDue = activeDecks.reduce((sum, deck) => sum + (Number(deck?.due) || 0), 0);
  const todayDue = (Number(data?.today?.due) || 0) + (Number(data?.today?.elsewhere) || 0);
  const dueCount = todayDue > 0 ? todayDue : deckDue;

  if (docCount === 0 || questionCount === 0) {
    return { docCount, questionCount, wrongCount, dueCount, recommendedId: 'kickoff', reason: '先搭题库' };
  }
  if (wrongCount > 0) {
    return { docCount, questionCount, wrongCount, dueCount, recommendedId: 'clear-mistakes', reason: '有待巩固错题' };
  }
  if (dueCount > 0) {
    return { docCount, questionCount, wrongCount, dueCount, recommendedId: 'reading-loop', reason: '边读边巩固' };
  }
  return { docCount, questionCount, wrongCount, dueCount, recommendedId: 'exam-sprint', reason: '适合自检冲刺' };
}

/** Build ordered scenario recipes backed by real marked Finder entries (skips recipes whose entries are absent). */
export function buildChainRecipes(marked, data) {
  const byId = new Map((Array.isArray(marked) ? marked : []).map((entry) => [entry.id, entry]));
  const state = summarizeChainState(data);
  const built = [];
  for (const spec of CHAIN_RECIPE_SPECS) {
    const steps = spec.steps
      .map((step, index) => {
        const base = byId.get(step.entryId);
        if (!base) return null;
        return { ...base, what: step.why, stepNumber: index + 1 };
      })
      .filter(Boolean);
    if (steps.length > 0) built.push({ id: spec.id, title: spec.title, steps });
  }
  if (!built.length) return [];
  const recIndex = built.findIndex((recipe) => recipe.id === state.recommendedId);
  const chosenIndex = recIndex >= 0 ? recIndex : 0;
  const chosen = built[chosenIndex];
  const rest = built.filter((_, idx) => idx !== chosenIndex);
  return [
    { ...chosen, recommended: true, reason: recIndex >= 0 ? state.reason : '' },
    ...rest.map((recipe) => ({ ...recipe, recommended: false, reason: '' })),
  ];
}
