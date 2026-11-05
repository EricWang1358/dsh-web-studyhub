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
   no number: chapter N's title is the unnumbered title before its first N—* section, past the lead-ins between them (本章要点, 学习目标 …). A title that is
   a caption or a chapter's end (本章提要, 关键术语, 问题, 操作题 …) is no chapter title: the chapter then opens at its first lead-in, else at its first
   section. There, the titles before the first chapter are front matter, under the chapters (level 2), and a 附录 after a section is that chapter's own, a
   sibling of its sections (owner's book 2026-11-06: 64 "chapters", three 附录 holding pages 81-513). */

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
// N—M: no third digit, and not a quantity (3-5 分钟, 1-2 周).
const DASHED = /^(\d{1,2})\s*[-‐‑‒–—―－]\s*\d{1,2}(?!\d)(?!\s*[周月年日天号次页章节课讲时分秒岁个人%％])(?=\s|$|[^\d.．,，])/;
const APPENDIX = /^(?:appendix\s+[a-z]|附录)/i;
const LEAD_IN = /^(?:本章(?:要点|导读|导言|导引|概要|重点|目标|学习目标)|学习(?:目标|要点)|内容提要|导读|learning\s+(?:objectives|goals|outcomes)|chapter\s+(?:overview|highlights|objectives|outline|preview)|highlights|key\s+points|objectives)\s*[:：]?$/i;
const CHAPTER_END = /^(?:本章(?:提要|小结|总结)|小结|总结|关键(?:术语|词|概念)|[一-鿿]{0,3}题|练习|参考文献|延伸阅读|summary|key\s+(?:terms|concepts)|problems|questions|exercises|review\s+questions|references|further\s+reading)\s*[:：]?$/i;
const CAPTION = /^[[［【(（]?\s*(?:表|图|资料|专栏|案例|例|插图|figure|fig\.?|table|box|exhibit)\s*\d/i;
const CHAPTER = 1, SECTION = 2, LIST = 7, MAX_LEVEL = 6;

/** The rank of one title's numbering ('bare' for a lone number, decided per document), or null when it is not numbered. */
function rankOf(text) {
  const decimal = DECIMAL.exec(text);
  if (decimal) return 1 + decimal[1].split('.').length - 1;
  if (DASHED.test(text)) return SECTION;
  for (const [rank, pattern] of RANKS) if (pattern.test(text)) return rank;
  return BARE.test(text) ? 'bare' : null;
}

/** Where each chapter of a book numbered N—M without chapter words starts: the index of its title (see above), for each chapter number in order. */
function dashedChapterStarts(list, ranks) {
  const starts = [], seen = new Set();
  list.forEach((title, at) => {
    const number = DASHED.exec(title)?.[1];
    if (number === undefined || seen.has(number)) return;
    seen.add(number);
    let before = at - 1, leadIn = -1;
    while (before >= 0 && ranks[before] === null && LEAD_IN.test(list[before])) leadIn = before--;
    const titled = before >= 0 && ranks[before] === null && !CHAPTER_END.test(list[before]) && !CAPTION.test(list[before]) && !starts.includes(before);
    starts.push(titled ? before : leadIn >= 0 ? leadIn : at);
  });
  return starts;
}

/** The ranks of a book numbered N—M without chapter words (null: the book is not one): its chapter titles at the chapter rank, a 附录 after a section at the section rank. */
function dashedRanks(list, ranks) {
  const dashed = list.filter(title => DASHED.test(title)).length;
  if (dashed < 2 || list.some(title => DECIMAL.test(title)) || ranks.some((rank, at) => (rank === 0 || rank === CHAPTER) && !APPENDIX.test(list[at]))) return null;
  const starts = dashedChapterStarts(list, ranks), first = Math.min(...starts);
  let sectioned = false;
  const out = ranks.map((rank, at) => {
    if (starts.includes(at)) return CHAPTER;
    if (DASHED.test(list[at])) sectioned = true;
    else if (rank === CHAPTER && sectioned) return SECTION;
    return rank;
  });
  return { ranks: out, front: first };
}

/** The level of each title (1 to 6), or null when the titles carry no numbering signal. */
export function inferHeadingLevels(titles) {
  const list = (Array.isArray(titles) ? titles : []).map(title => String(title ?? '').trim()), own = list.map(rankOf);
  if (own.filter(rank => rank !== null).length < 2) return null;
  const dashed = dashedRanks(list, own), ranks = dashed ? dashed.ranks : own;
  const decimals = list.some(title => DECIMAL.test(title));
  const chapterWord = ranks.some(rank => rank === 0 || rank === CHAPTER);
  const bare = decimals && !chapterWord ? CHAPTER : LIST;
  const open = [];
  let last = 0;
  return ranks.map((found, at) => {
    // Front matter of a dash-numbered book: under the chapters, so it is no chapter of its own.
    if (found === null && dashed && at < dashed.front) return 2;
    if (found === null) return Math.min(MAX_LEVEL, last + 1);
    const rank = found === 'bare' ? bare : found;
    while (open.length && open.at(-1) >= rank) open.pop();
    open.push(rank);
    last = Math.min(MAX_LEVEL, open.length);
    return last;
  });
}
