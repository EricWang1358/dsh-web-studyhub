/* The Q&A blocks of the 复习全书 (M3, docs/plans/review-book.md): a follow-up kept on a card, put into the book by 「加入复习全书」, as a quoted block in
   the point's `<leaf>.qa.md` (or 未归位), under the card's link. Pure text rules, browser-safe; lib/course-book-qa.js writes them.

     <!-- sh:qa card=<cardId> fid=<followupId> -->
     > **追问：** the question
     >
     > **答：** the answer
     <!-- /sh:qa -->

   Once written, the block is the learner's text like any other (editing the card later does not change it). Only book.qa.add / book.qa.remove write
   or remove a whole block; the preview hides the two marker lines.

   The 分析题答案卡 of a case question (M5, lib/answer-card.js) goes in the same way, once per card, as its rendered Markdown (not quoted: it holds a
   table; bold labels, no headings):

     <!-- sh:card card=<cardId> -->
     **分析题答案卡**
     …the card…
     <!-- /sh:card --> */

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const QA = /<!-- sh:qa card=(\S+) fid=(\S+) -->\n((?:(?!<!-- sh:qa )[\s\S])*?)\n<!-- \/sh:qa -->/g;
const CARD = /<!-- sh:card card=(\S+) -->\n((?:(?!<!-- sh:card )[\s\S])*?)\n<!-- \/sh:card -->/g;
export const QA_MARKER_LINE = /^<!-- \/?sh:(?:qa|card)\b[^>]*-->$/;

/** The Q&A blocks of a text: [{ cardId, fid, start, end, raw }]. */
export function qaBlocks(text) {
  return [...String(text ?? '').matchAll(QA)].map(match => ({ cardId: match[1], fid: match[2], start: match.index, end: match.index + match[0].length, raw: match[0] }));
}
/** Does the text hold the block of this follow-up? */
export const holdsFollowup = (text, fid) => String(text ?? '').includes(`fid=${fid} -->`);
/** Is there a link to this card in the text? */
export const linksCard = (text, cardId) => new RegExp(`\\]\\(studyhub://card/[^/)\\s]+/${escape(encodeURIComponent(cardId))}\\)`).test(String(text ?? ''));

const WORDS = { zh: { asked: '追问', answer: '答', sep: '：' }, en: { asked: 'Follow-up', answer: 'Answer', sep: ': ' } };
const quoted = text => String(text ?? '').trim().split('\n').map(line => (line.trim() ? `> ${line}` : '>')).join('\n');
/** One follow-up as a block. */
export function qaBlock({ cardId, followupId, question, answer }, language) {
  const words = WORDS[language === 'en' ? 'en' : 'zh'];
  return `<!-- sh:qa card=${cardId} fid=${followupId} -->\n${quoted(`**${words.asked}${words.sep}** ${question}`)}\n>\n${quoted(`**${words.answer}${words.sep}** ${answer}`)}\n<!-- /sh:qa -->`;
}

/** A block under the first link to `cardId` in the text (after the blocks already there, in the order they were added); at the end without such a link. */
export function placeBlock(text, cardId, block) {
  const source = String(text ?? ''), link = new RegExp(`\\]\\(studyhub://card/[^/)\\s]+/${escape(encodeURIComponent(cardId))}\\)`).exec(source);
  if (!link) return source.trim() ? `${source.replace(/\n*$/, '')}\n\n${block}\n` : `${block}\n`;
  const end = source.indexOf('\n', link.index);
  let tail = end < 0 ? source.length : end;
  for (let match; (match = /^\n\n?<!-- sh:(qa|card) card=[^\n]*-->\n[\s\S]*?\n<!-- \/sh:\1 -->/.exec(source.slice(tail)));) tail += match[0].length;
  return `${source.slice(0, tail)}\n\n${block}${tail === source.length ? '\n' : ''}${source.slice(tail)}`;
}

/** The text without the block of `fid` (and the blank line before it); null when it holds none. */
export function removeBlock(text, fid) {
  const source = String(text ?? ''), block = qaBlocks(source).find(item => item.fid === fid);
  if (!block) return null;
  const from = source.slice(0, block.start).replace(/\n{1,2}$/, '').length;
  return source.slice(0, from) + source.slice(block.end);
}

/** The answer-card blocks of a text: [{ cardId, start, end, raw }]. */
export function cardBlocks(text) {
  return [...String(text ?? '').matchAll(CARD)].map(match => ({ cardId: match[1], start: match.index, end: match.index + match[0].length, raw: match[0] }));
}
/** Does the text hold the answer card of this question? */
export const holdsAnswerCard = (text, cardId) => String(text ?? '').includes(`<!-- sh:card card=${cardId} -->`);
/** One answer card as a block: its rendered Markdown (lib/answer-card.js renderAnswerCard) under a bold title. */
export function answerCardBlock({ cardId, markdown }, language) {
  return `<!-- sh:card card=${cardId} -->\n**${language === 'en' ? 'Answer card' : '分析题答案卡'}**\n\n${String(markdown ?? '').trim()}\n<!-- /sh:card -->`;
}
/** The text without the answer card of `cardId` (and the blank line before it); null when it holds none. */
export function removeCardBlock(text, cardId) {
  const source = String(text ?? ''), block = cardBlocks(source).find(item => item.cardId === cardId);
  if (!block) return null;
  const from = source.slice(0, block.start).replace(/\n{1,2}$/, '').length;
  return source.slice(0, from) + source.slice(block.end);
}

/** The text as the preview shows it: the two marker lines of each block taken out (the quote stays). */
export const withoutQaMarkers = text => String(text ?? '').split('\n').filter(line => !QA_MARKER_LINE.test(line.trim())).join('\n');
