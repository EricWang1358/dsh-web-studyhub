const DECK_TIER_RULES = [
  { tier: 0, key: "foundation", re: /筑基|前置|基础|入门|导论|概览|词汇|术语|primer|foundation|basics?|intro(?:duction)?|prereq|fundamentals?/i },
  { tier: 3, key: "exam", re: /综合|大卷|模拟|真题|总复习|冲刺|押题|百科|全书|原题|套卷|exam|mock|comprehensive|final|capstone|mega/i },
  { tier: 2, key: "lab", re: /源码|实验|实战|编程|代码|动手|案例|调试|项目|lab|source\s*code|workshop|hands[- ]?on|practice|case\s*study|project/i },
  { tier: 1, key: "core", re: /精讲|第\s*\d+\s*[章讲课节单元]|chapter|ch\.?\s*\d+|lecture|unit|week|lesson|核心|原理|专题/i },
];

function extractChapterNum(title) {
  const text = String(title || "");
  const m = /(?:第\s*(\d+)\s*[章讲课节单元回部]|(?:chapter|ch|lecture|lec|unit|week|lesson|part)\s*[.#:-]?\s*(\d+)|^\s*0?(\d{1,3})\s*[.、:：\-\s])/i.exec(text);
  const raw = m?.[1] || m?.[2] || m?.[3];
  return raw ? Number(raw) : null;
}

function deckTierOf(deck) {
  const title = String(deck?.title || "");
  if (deck?.case) return { tier: 2, key: "lab" };
  for (const rule of DECK_TIER_RULES) {
    if (rule.re.test(title)) return { tier: rule.tier, key: rule.key };
  }
  return { tier: 1, key: "core" };
}

/**
 * Pure browser-safe non-destructive recommendation for ordering sibling decks of a course (#1296):
 * 0: foundation (筑基/基础) -> 1: core chapters (精讲/章节, ascending by chapter number) -> 2: lab/source/case (源码/实验/案例) -> 3: comprehensive/mock exams (综合/模拟大卷).
 * Never mutates input; callers must confirm with the learner before calling `deck.reorder`.
 */
export function suggestDeckOrder(decks = []) {
  const list = (Array.isArray(decks) ? decks : []).filter(d => d && !d.systemKind && !d.archived);
  const annotated = list.map((deck, index) => {
    const { tier, key } = deckTierOf(deck);
    return { deck, index, tier, key, chapter: extractChapterNum(deck.title) };
  });
  const sorted = [...annotated].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.chapter !== null && b.chapter !== null && a.chapter !== b.chapter) return a.chapter - b.chapter;
    if (a.chapter !== null && b.chapter === null) return -1;
    if (a.chapter === null && b.chapter !== null) return 1;
    return a.index - b.index;
  });
  const ids = sorted.map(item => item.deck.id);
  const changed = ids.some((idVal, idx) => idVal !== list[idx]?.id);
  return {
    changed,
    ids,
    items: sorted.map((item, toIndex) => ({
      id: item.deck.id,
      title: item.deck.title,
      tier: item.tier,
      tierKey: item.key,
      fromIndex: item.index,
      toIndex,
    })),
  };
}
