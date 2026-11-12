/* A learning note written from a question (#1017): 写笔记 under a question fills the note's four headings from the card, and 存进笔记 under a Q&A adds
   that Q&A to the question's note. Deterministic: only the card's own fields, no model call. Pure, no Node modules.

   核心概念    the stem and the answer (a choice question: the right options)
   常见误区    the card's 容易混淆 and each wrong option with its explanation
   解析与例子  left for the learner
   学习记录    the explanation, 来源：第 N 页 (a link the note page opens at the cited quote), then each Q&A as quoted 追问 / 答

   A card's text is the learner's or the model's Markdown and can hold anything: an open code fence, heading lines, several lines. So each value is
   its own block under a label line, its headings put below the note's own (level 3 or deeper) and an open fence closed at its end; a list item's
   later lines are indented into the item. A Q&A is a quote, which ends whatever it opened.

   The note remembers which follow-ups it holds (`followupIds`); a Q&A counts as held while its question is still in the text (holdsQa), so one
   the learner deleted, or one a recovered draft or an AI draft wrote over, is added again. */

import { findCard } from '../../prereq.js';
import { currentFollowups } from '../../followup.js';
import { cardReadingLocation } from '../../reading-order/card-reading-order.js';
import { qaQuote } from '../../course-book-qa-text.js';
import { closeFences } from '../../course-book-links.js';
import { headingsOf, shiftLevels } from '../../book-section-ops.js';
import { validImageMarkdown } from '../../study-image-markdown.js';
import { citeHref } from './note-links.js';

const WORDS = {
  zh: { headings: ['核心概念', '常见误区', '解析与例子', '学习记录'], question: '题目', answer: '答案', sep: '：', list: '；', source: '来源',
    unit: { page: '第 {0} 页', slide: '第 {0} 张', part: '第 {0} 节', section: '第 {0} 节' }, left: n => `（还有 ${n} 条较早的问答没有放进来：笔记已到长度上限。）` },
  en: { headings: ['Core concepts', 'Common misconceptions', 'Explanation and examples', 'Study log'], question: 'Question', answer: 'Answer', sep: ': ', list: '; ', source: 'Source',
    unit: { page: 'page {0}', slide: 'slide {0}', part: 'part {0}', section: 'section {0}' },
    left: n => `(${n} earlier Q&A ${n === 1 ? 'was' : 'were'} left out: the note reached its length limit.)` },
};
const wordsOf = language => WORDS[language === 'en' ? 'en' : 'zh'];
const text = value => (typeof value === 'string' ? value.trim() : '');
const lines = value => String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
/** A bold label on its own line, `**题目：**` / `**Question:**` (the colon inside the bold: CommonMark ends no bold after a space). */
const label = (word, words) => `**${word}${words.sep.trimEnd()}**`;

/** A value of the card as a block of its own: its headings at level 3 or deeper (below the note's ##), an open code fence closed at its end. */
function block(value) {
  const rows = lines(text(value)), headings = headingsOf(rows);
  const top = headings.length ? Math.min(...headings.map(heading => heading.level)) : 3;
  return closeFences(shiftLevels(rows, Math.max(0, 3 - top)).join('\n'));
}
/** A labelled value: the label line, then the value as its own block; '' without a value. */
const labelled = (word, value, words) => (text(value) ? `${label(word, words)}\n\n${block(value)}` : '');
/** A list item whose text may run over several lines: the later lines indented into the item. */
const item = value => `- ${block(value).split('\n').map((line, at) => (at && line ? `  ${line}` : line)).join('\n')}`;

/** 来源：第 N 页 of a card: where it sits in its material (the page the practice page shows), linked to the citation on that page; '' without a page. */
function sourceLine(deckId, card, sources, words) {
  const place = cardReadingLocation(card, sources);
  if (!Number.isInteger(place?.page)) return '';
  const name = (words.unit[place.unit] || words.unit.page).replace('{0}', place.page);
  const index = (card.citations || []).findIndex(citation => citation?.sourceId === place.sourceId && text(citation.quote));
  return `${words.source}${words.sep}${index >= 0 ? `[${name}](${citeHref(deckId, card.id, index)})` : name}`;
}

const answerOf = (card, words) => {
  const right = (card.options || []).filter(option => option?.correct === true).map(option => text(option.text)).filter(Boolean);
  return right.length ? right.join(words.list) : text(card.answer);
};

/** One Q&A as the note writes it. */
export const noteQa = (followup, language) => qaQuote({ question: text(followup.question), answer: text(followup.answer) }, language);

/** Is this Q&A still in the note's text? Its question's first line is looked for (a label in either language, an edit around it, are all the same). */
export function holdsQa(markdown, followup) {
  const first = lines(text(followup?.question)).find(line => line.trim())?.trim();
  return !!first && String(markdown ?? '').includes(first);
}

/** The follow-up ids a note holds now: those recorded on it whose question is still in its text. */
export const heldFollowupIds = (note, card) => (note?.followupIds || []).filter(fid => {
  const followup = card && currentFollowups(card).find(entry => entry.id === fid);
  return followup ? holdsQa(note.markdown, followup) : false;
});

/** The note with the card's Q&A of `kept` (per card, the newest that fit) and a line for those left out. */
function compose(state, refs, title, words, language, keep) {
  const parts = [[], [], [], []], followupIds = [];
  let left = 0;
  for (const ref of refs) {
    const { deck, card } = findCard(state, ref);
    parts[0].push([labelled(words.question, card.prompt, words), labelled(words.answer, answerOf(card, words), words)].filter(Boolean).join('\n\n'));
    const wrong = (card.options || []).filter(option => option?.correct === false && text(option.explanation))
      .map(option => item(`${text(option.text)}${words.sep}${text(option.explanation)}`)).join('\n');
    parts[1].push([text(card.misconception) && block(card.misconception), wrong].filter(Boolean).join('\n\n'));
    const followups = currentFollowups(card), kept = keep(card.id, followups);
    left += followups.length - kept.length;
    followupIds.push(...kept.map(entry => entry.id));
    parts[3].push([text(card.explanation) && block(card.explanation), sourceLine(deck.id, card, state.sources || [], words), ...kept.map(entry => noteQa(entry, language))].filter(Boolean).join('\n\n'));
  }
  if (left) parts[3].push(words.left(left));
  const body = words.headings.map((heading, at) => {
    const filled = parts[at].filter(Boolean).join('\n\n');
    return `## ${heading}\n${filled ? `\n${filled}\n` : ''}`;
  }).join('\n');
  return { markdown: `# ${title}\n\n${body}`, followupIds };
}

/**
 * The Markdown of a note written from `refs` (questions), and the follow-ups it holds: { markdown, followupIds }. Within the length a note may have
 * (validImageMarkdown, the check of note.save): when every Q&A does not fit, the oldest are left out (the newest kept) and a line says how many.
 */
export function questionNote(state, refs, title, language) {
  const words = wordsOf(language);
  const all = compose(state, refs, title, words, language, (_id, followups) => followups);
  if (validImageMarkdown(all.markdown)) return all;
  // Leave out the oldest Q&A of the note, `drop` of them over all its questions (each card's are kept oldest first), the fewest that make it fit.
  const order = refs.flatMap(ref => { const { card } = findCard(state, ref); return currentFollowups(card).map((entry, at) => ({ cardId: card.id, id: entry.id, at: entry.at || '', index: at })); })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.index - b.index);
  const attempt = drop => { const gone = new Set(order.slice(0, drop).map(entry => entry.id)); return compose(state, refs, title, words, language, (_id, followups) => followups.filter(entry => !gone.has(entry.id))); };
  let low = 1, high = order.length;
  if (!validImageMarkdown(attempt(high).markdown)) throw new Error('Markdown 内容过长');
  while (low < high) { const mid = Math.floor((low + high) / 2); if (validImageMarkdown(attempt(mid).markdown)) high = mid; else low = mid + 1; }
  return attempt(low);
}

/** The follow-up `followupId` of the card as it is now; refused when it is no longer on the card (edited away). */
export function followupOf(card, followupId) {
  const found = currentFollowups(card).find(entry => entry.id === followupId);
  if (!found) throw new Error('这条问答已不在这道题上，请刷新后再试');
  return found;
}

/** The note's text with the Q&A added at its end (under 学习记录, the last heading of the template). */
export const withQa = (markdown, followup, language) => `${String(markdown ?? '').replace(/\s*$/, '')}\n\n${noteQa(followup, language)}\n`;
