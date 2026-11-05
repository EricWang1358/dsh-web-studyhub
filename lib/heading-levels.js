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
   Fewer than two numbered titles is no numbering signal: null, and the caller keeps the levels it has. */

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
const CHAPTER = 1, LIST = 7, MAX_LEVEL = 6;

/** The rank of one title's numbering ('bare' for a lone number, decided per document), or null when it is not numbered. */
function rankOf(text) {
  const decimal = DECIMAL.exec(text);
  if (decimal) return 1 + decimal[1].split('.').length - 1;
  for (const [rank, pattern] of RANKS) if (pattern.test(text)) return rank;
  return BARE.test(text) ? 'bare' : null;
}

/** The level of each title (1 to 6), or null when the titles carry no numbering signal. */
export function inferHeadingLevels(titles) {
  const list = (Array.isArray(titles) ? titles : []).map(title => String(title ?? '').trim()), ranks = list.map(rankOf);
  if (ranks.filter(rank => rank !== null).length < 2) return null;
  const decimals = list.some(title => DECIMAL.test(title));
  const chapterWord = ranks.some(rank => rank === 0 || rank === CHAPTER);
  const bare = decimals && !chapterWord ? CHAPTER : LIST;
  const open = [];
  let last = 0;
  return ranks.map(found => {
    if (found === null) return Math.min(MAX_LEVEL, last + 1);
    const rank = found === 'bare' ? bare : found;
    while (open.length && open.at(-1) >= rank) open.pop();
    open.push(rank);
    last = Math.min(MAX_LEVEL, open.length);
    return last;
  });
}
