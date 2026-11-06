/* The levels of headings a converter wrote all at one level (MinerU gives every title `text_level: 1`), read from the titles' own numbering. Pure, no I/O,
   no Node modules (the browser bundle may import it).

   Each title's numbering has a rank, from the outermost to the innermost, the usual order of Chinese and English documents:
     part      第一部分 / 第一篇 / Part I
     chapter   第一章 / 第一讲 / 第一课 / 第一单元 / 第一周 / Chapter 1 / Lecture 3 / Lesson / Unit / Week / Module / Topic / Appendix A / 附录
     section   第一节 / Section 1 / 1.1   (1.1.1 and 1.1.1.1 one and two ranks deeper)
     一、 and I. (roman) > （一） and A. > 1. / 1、 > （1） / 1) > ① > a)
   A bare number (1 / 1.) is the chapter rank when the document numbers its sections with decimals (1.1) and has no chapter word; otherwise it is the list rank.
   A title's level is how deep its rank sits under the titles open above it (a stack: a title closes every open title of its rank or deeper), so a document that
   mixes schemes, or uses only some ranks, still gets levels 1, 2, 3 … without gaps. An unnumbered title sits one level under the numbered title before it
   (学习目标 under 第一章); before any numbered title it is at level 1 (the document's own title). Levels stop at 6 (Markdown has no deeper heading).
   Fewer than two numbered titles is no numbering signal: null, and the caller keeps the levels it has.

   Sections numbered N—M (also N-M, N–M, N－M, spaced or not) are sections of chapter N, the rank of 1.1; a caption (表1-1, 图2-3, [资料1- 1]) is not, it does
   not start with the number. A book that numbers its sections so and has no chapter word (附录 / Appendix aside) and no decimals gives its chapter titles
   no number: between the previous section and chapter N's first N—* section, chapter N opens at the title before its FIRST lead-in (本章要点, 本章纲要,
   学习目标 …; the content titles after it, such as [资料5-1] … or 本章内容是关于…, are never its title), else at the title before that section. A title
   "N 标题" with the chapter's own N is the title, its name without the number; a bare "N" before the title opens the chapter and the title after it names
   it. A caption or a chapter's end (本章提要, 关键术语, 问题, 操作题 …) is no chapter title: the chapter then opens at its first lead-in, else at its first
   section; a title before the chapter's own (泰勒规则 after the previous chapter's 操作题) stays in the previous chapter. There, the titles before the
   first chapter are front matter, under the chapters (level 2), and a 附录 after a section is that chapter's own, a sibling of its sections (owner's book
   2026-11-06: 64 "chapters", three 附录 holding pages 81-513). inferHeadings also says what such a chapter is called when that is not its title as written. */

const ZH = '[一二三四五六七八九十百零〇两]+';
const ZH_OR_DIGITS = `(?:${ZH}|\\d{1,3})`;
const DECIMAL = /^\d{1,2}((?:\.\d{1,2}){1,3})\.?(?:\s+|(?=[^\d.\s]))/;
const RANKS = [
  [0, new RegExp(`^第\\s*${ZH_OR_DIGITS}\\s*(?:部分|篇|编)`)],
  [0, /^part\s+(?:[ivxlc]+|\d{1,2})\b/i],
  [1, new RegExp(`^第\\s*${ZH_OR_DIGITS}\\s*(?:章|讲|課|课|单元|周)`)],
  [1, /^(?:chapter|lecture|lesson|unit|week|module|topic)\s*(?:[ivxlc]+|\d{1,3})\b/i],
  [1, /^(?:appendix\s+[a-z]\b|附录)/i],
  [2, new RegExp(`^第\\s*${ZH_OR_DIGITS}\\s*节`)],
  [2, /^section\s+\d/i],
  [5, new RegExp(`^${ZH}\\s*[、.．]`)],
  [5, /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)\.\s/i],
  [6, new RegExp(`^[（(]\\s*${ZH}\\s*[）)]`)],
  [6, /^[A-H][.)]\s/],
  [8, /^(?:[（(]\s*\d{1,2}\s*[）)]|\d{1,2}[）)])/],
  [9, /^[①-⑳]/],
  [10, /^[（(]?[a-h][）)]\s/],
];
const BARE = /^\d{1,2}(?:\s*[、.．](?!\d)\s*|\s+)(?=\D)/;
// N—M: no third digit, and not a quantity, a range of exercises, a score or a time (3-5 分钟, 1-2 周, 1-2 题, 3-0 胜, 8-10 am).
const DASHED = /^(\d{1,2})\s*[-‐‑‒–—―－]\s*(\d{1,2})(?!\d)(?!\s*(?:[周月年日天号次页章节课讲时分秒岁个人%％题点胜负平]|[ap]\.?m))(?=\s|$|[^\d.．,，])/i;
const LIST_ITEM = /^\d{1,3}\s*[、.．](?!\d)/;
const CONTENTS = /^(?:目\s*录|目\s*次|contents|table\s+of\s+contents)\s*[:：]?$/i;
const APPENDIX = /^(?:appendix\s+[a-z]|附录)/i;
// Not 导读 or 内容提要 alone: front matter is called so too.
const LEAD_IN = /^(?:本章(?:要点|纲要|导读|导言|导引|概要|重点|目标|学习目标)|学习(?:目标|要点)|learning\s+(?:objectives|goals|outcomes)|chapter\s+(?:overview|highlights|objectives|outline|preview)|highlights|key\s+points|objectives)\s*[:：]?$/i;
const CHAPTER_END = /^(?:本章(?:提要|小结|总结)|小结|总结|关键(?:术语|词|概念)|(?:概念|技术|操作|复习|思考|练习|讨论|计算|应用|选择|判断|填空|简答|论述)题|问题|习题|练习|参考文献|延伸阅读|summary|key\s+(?:terms|concepts)|problems|questions|exercises|review\s+questions|references|further\s+reading)\s*[:：]?$/i;
const CAPTION = /^[[［【(（]?\s*(?:表|图|资料|专栏|案例|例|插图|figure|fig\.?|table|box|exhibit)\s*\d/i;
const CHAPTER = 1, SECTION = 2, LIST = 7, MAX_LEVEL = 6;

/** The rank of one title's numbering ('bare' for a lone number, decided per document), or null when it is not numbered. */
function rankOf(text) {
  const decimal = DECIMAL.exec(text);
  if (decimal) return 1 + decimal[1].split('.').length - 1;
  for (const [rank, pattern] of RANKS) if (pattern.test(text)) return rank;
  return BARE.test(text) ? 'bare' : null;
}

/** The dash-numbered sections of a document ({ sections: Map(index -> chapter number), contents: Set(index) }), or null when its dash numbers are no section
    numbering: that takes two chapters each with two sections or more, numbered from 1 or 2 (not 1-2 题 / 3-5 题, 9-15 Lecture / 10-20 Midterm). An entry
    whose number comes again later, after the chapter numbers went back down, is a contents entry (目录 written as headings), not a section, when its run is
    contents: right after a 目录 / Contents heading, or (`places`: whether text follows each title) headings with no text under them. Otherwise the first run
    is the body (an answer key at the end repeats the numbers too). */
function dashNumbering(list, places) {
  const found = list.map(title => { const match = DASHED.exec(title); return match ? { chapter: Number(match[1]), key: `${Number(match[1])}-${Number(match[2])}`, section: Number(match[2]) } : null; });
  const pass = [], lastPass = new Map();
  let at = 0, previous = -1;
  found.forEach((entry, index) => {
    if (!entry) return;
    if (entry.chapter < previous) at += 1;
    previous = entry.chapter; pass[index] = at; lastPass.set(entry.key, at);
  });
  const runs = new Map();
  found.forEach((entry, index) => { if (entry) runs.set(pass[index], [...(runs.get(pass[index]) ?? []), index]); });
  const dense = new Map([...runs].map(([run, members]) => {
    let before = members[0] - 1;
    while (before >= 0 && !found[before]) before--;
    const headed = list.slice(before + 1, members[0]).some(title => CONTENTS.test(title));
    const bare = Array.isArray(places) && members.filter(index => places[index]?.body).length <= 1;
    return [run, headed || bare];
  }));
  const contents = new Set(), sections = new Map(), byChapter = new Map();
  found.forEach((entry, index) => {
    if (!entry) return;
    if (pass[index] < lastPass.get(entry.key) && dense.get(pass[index])) { contents.add(index); return; }
    sections.set(index, entry.chapter);
    if (!byChapter.has(entry.chapter)) byChapter.set(entry.chapter, new Set());
    byChapter.get(entry.chapter).add(entry.section);
  });
  const numbered = [...byChapter.values()].filter(numbers => numbers.size >= 2 && Math.min(...numbers) <= 2).length;
  return numbered >= 2 ? { sections, contents } : null;
}

/** The name a title "N 名称" gives chapter N (null: it is not chapter N's; a list item "1. 定义" never is). */
const ownTitle = (text, number) => {
  const found = /^(\d{1,3})\s+(\S.*)$/.exec(text);
  return found && found[1] === number ? found[2].trim() : null;
};
/** The name a list-numbered title "N. 名称" / "N、名称" gives chapter N (a book that numbers its chapter titles so: dashedChapterStarts). */
const listTitle = (text, number) => {
  const found = /^(\d{1,3})\s*[、.．](?!\d)\s*(\S.*)$/.exec(text);
  return found && found[1] === number ? found[2].trim() : null;
};
const bareNumber = (text, number) => new RegExp(`^${number}\\s*[、.．]?$`).test(text);
const titleLike = (text, rank) => rank === null && !CHAPTER_END.test(text) && !CAPTION.test(text) && !LEAD_IN.test(text);

/** The run before chapter N's first section at `at`: { lo (the previous section), anchor (its first lead-in, else the section) }. */
function runBefore(list, ranks, sections, at) {
  let lo = at - 1;
  while (lo >= 0 && !sections.has(lo)) lo--;
  let lead = -1;
  for (let index = lo + 1; index < at && lead < 0; index++) if (ranks[index] === null && LEAD_IN.test(list[index])) lead = index;
  return { lo, anchor: lead >= 0 ? lead : at };
}

/** Where chapter N opens ({ at, title? }: the index of its first title, and its name when that is not the title as written), its first section at `at`.
    `numbered`: the book titles its chapters "N. 名称", so that title, right before the chapter, is the chapter. */
function chapterStart(list, ranks, sections, at, number, numbered) {
  const { lo, anchor } = runBefore(list, ranks, sections, at);
  let before = anchor - 1;
  if (numbered && before > lo && listTitle(list[before], number)) return { at: before, title: listTitle(list[before], number) };
  // Otherwise a list item ("1. 定义") is the chapter's content, never its title.
  while (before > lo && LIST_ITEM.test(list[before]) && !bareNumber(list[before], number)) before--;
  if (before > lo) {
    const own = ownTitle(list[before], number);
    if (own) return { at: before, title: own };
    if (titleLike(list[before], ranks[before])) return before - 1 > lo && bareNumber(list[before - 1], number) ? { at: before - 1, title: list[before] } : { at: before };
  }
  return { at: anchor };
}

/** Where each chapter of a book numbered N—M without chapter words opens (see above), for each chapter number in order. */
function dashedChapterStarts(list, ranks, sections) {
  const firsts = [], seen = new Set();
  for (const [at, chapter] of sections) if (!seen.has(chapter)) { seen.add(chapter); firsts.push([at, String(chapter)]); }
  // Chapter titles numbered "N. 名称" when most chapters (two at least) have one right before them; one such title alone is a list item of the lead-in.
  const listed = firsts.filter(([at, number]) => { const { lo, anchor } = runBefore(list, ranks, sections, at); return anchor - 1 > lo && listTitle(list[anchor - 1], number); }).length;
  const numbered = listed >= 2 && listed * 2 >= firsts.length;
  const starts = [];
  for (const [at, number] of firsts) {
    const start = chapterStart(list, ranks, sections, at, number, numbered);
    starts.push(starts.some(item => item.at === start.at) ? { at } : start);
  }
  return starts;
}

/** The ranks of a book numbered N—M without chapter words (null: the book is not one): its chapter titles at the chapter rank, a 附录 after a section at
    the section rank; with the names of the chapters whose title is not their name as written. */
function dashedRanks(list, ranks, sections) {
  if (list.some(title => DECIMAL.test(title)) || ranks.some((rank, at) => (rank === 0 || rank === CHAPTER) && !APPENDIX.test(list[at]))) return null;
  const starts = dashedChapterStarts(list, ranks, sections), opens = new Set(starts.map(start => start.at)), first = Math.min(...opens);
  let sectioned = false;
  const out = ranks.map((rank, at) => {
    if (opens.has(at)) return CHAPTER;
    if (sections.has(at)) sectioned = true;
    else if (rank === CHAPTER && sectioned) return SECTION;
    return rank;
  });
  return { ranks: out, front: first, names: new Map(starts.filter(start => start.title).map(start => [start.at, start.title])) };
}

/** The level of each title (1 to 6), or null when the titles carry no numbering signal. */
export const inferHeadingLevels = titles => inferHeadings(titles)?.levels ?? null;

/** { levels (as inferHeadingLevels), names: Map(index -> the name of the chapter that title opens, when it is not the title as written) }, or null.
    `places`, when known: [{ body }] for each title, whether text follows it before the next title (contents written as headings have none). */
export function inferHeadings(titles, { places } = {}) {
  const list = (Array.isArray(titles) ? titles : []).map(title => String(title ?? '').trim()), own = list.map(rankOf);
  // Dash-numbered sections (and contents entries, unnumbered) only where the document numbers its sections so; elsewhere 1-2 题 reads as it did.
  const dashes = dashNumbering(list, places);
  if (dashes) { for (const at of dashes.sections.keys()) own[at] = SECTION; for (const at of dashes.contents) own[at] = null; }
  if (own.filter(rank => rank !== null).length < 2) return null;
  const dashed = dashes ? dashedRanks(list, own, dashes.sections) : null, ranks = dashed ? dashed.ranks : own;
  const decimals = list.some(title => DECIMAL.test(title));
  const chapterWord = ranks.some(rank => rank === 0 || rank === CHAPTER);
  const bare = decimals && !chapterWord ? CHAPTER : LIST;
  const open = [];
  let last = 0;
  const levels = ranks.map((found, at) => {
    // Front matter of a dash-numbered book: under the chapters, so it is no chapter of its own.
    if (found === null && dashed && at < dashed.front) return 2;
    if (found === null) return Math.min(MAX_LEVEL, last + 1);
    const rank = found === 'bare' ? bare : found;
    while (open.length && open.at(-1) >= rank) open.pop();
    open.push(rank);
    last = Math.min(MAX_LEVEL, open.length);
    return last;
  });
  return { levels, names: dashed ? dashed.names : new Map() };
}
