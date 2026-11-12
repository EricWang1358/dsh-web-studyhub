/* A learning note written from a question (#1017): 写笔记 under a question fills the note's four headings from the card, and 存进笔记 under a Q&A adds
   that Q&A to the question's note. Deterministic: only the card's own fields, no model call. Pure, no Node modules.

   核心概念    the stem and the answer (a choice question: the right options)
   常见误区    the card's 容易混淆 and each wrong option with its explanation
   解析与例子  left for the learner
   学习记录    the explanation, 来源：第 N 页 (a link the note page opens at the cited quote), then each Q&A as quoted 追问 / 答

   The note remembers which follow-ups it holds (`followupIds`), so a Q&A saved again is never added twice, even after the learner edited the text. */

import { findCard } from '../../prereq.js';
import { currentFollowups } from '../../followup.js';
import { cardReadingLocation } from '../../reading-order/card-reading-order.js';
import { qaQuote } from '../../course-book-qa-text.js';
import { citeHref } from './note-links.js';

const WORDS = {
  zh: { headings: ['核心概念', '常见误区', '解析与例子', '学习记录'], question: '题目', answer: '答案', sep: '：', list: '；', source: '来源',
    unit: { page: '第 {0} 页', slide: '第 {0} 张', part: '第 {0} 节', section: '第 {0} 节' } },
  en: { headings: ['Core concepts', 'Common misconceptions', 'Explanation and examples', 'Study log'], question: 'Question', answer: 'Answer', sep: ': ', list: '; ', source: 'Source',
    unit: { page: 'page {0}', slide: 'slide {0}', part: 'part {0}', section: 'section {0}' } },
};
const wordsOf = language => WORDS[language === 'en' ? 'en' : 'zh'];
const text = value => (typeof value === 'string' ? value.trim() : '');
/** A bold label, `**题目：** ` / `**Question:** `, as the book's 追问 / 答: the colon inside the bold and a space after it (CommonMark ends no bold
    between a colon and a letter, nor after a space). */
const label = (word, words) => `**${word}${words.sep.trimEnd()}** `;

/** 来源：第 N 页 of a card: where it sits in its material (the page the practice page shows), linked to the citation on that page; '' without a page. */
function sourceLine(deckId, card, sources, words) {
  const place = cardReadingLocation(card, sources);
  if (!Number.isInteger(place?.page)) return '';
  const label = (words.unit[place.unit] || words.unit.page).replace('{0}', place.page);
  const index = (card.citations || []).findIndex(citation => citation?.sourceId === place.sourceId && text(citation.quote));
  return `${words.source}${words.sep}${index >= 0 ? `[${label}](${citeHref(deckId, card.id, index)})` : label}`;
}

const answerOf = (card, words) => {
  const right = (card.options || []).filter(option => option?.correct === true).map(option => text(option.text)).filter(Boolean);
  return right.length ? right.join(words.list) : text(card.answer);
};

/** One Q&A as the note writes it. */
export const noteQa = (followup, language) => qaQuote({ question: text(followup.question), answer: text(followup.answer) }, language);

/** The Markdown of a note written from `refs` (questions), and the follow-ups it holds: { markdown, followupIds }. */
export function questionNote(state, refs, title, language) {
  const words = wordsOf(language), parts = [[], [], [], []], followupIds = [];
  for (const ref of refs) {
    const { deck, card } = findCard(state, ref);
    const stem = text(card.prompt), answer = answerOf(card, words);
    parts[0].push([stem && `${label(words.question, words)}${stem}`, answer && `${label(words.answer, words)}${answer}`].filter(Boolean).join('\n\n'));
    const wrong = (card.options || []).filter(option => option?.correct === false && text(option.explanation))
      .map(option => `- ${text(option.text)}${words.sep}${text(option.explanation)}`).join('\n');
    parts[1].push([text(card.misconception), wrong].filter(Boolean).join('\n\n'));
    const followups = currentFollowups(card);
    followupIds.push(...followups.map(item => item.id));
    parts[3].push([text(card.explanation), sourceLine(deck.id, card, state.sources || [], words), ...followups.map(item => noteQa(item, language))].filter(Boolean).join('\n\n'));
  }
  const body = words.headings.map((heading, at) => {
    const filled = parts[at].filter(Boolean).join('\n\n');
    return `## ${heading}\n${filled ? `\n${filled}\n` : ''}`;
  }).join('\n');
  return { markdown: `# ${title}\n\n${body}`, followupIds };
}

/** The follow-up `followupId` of the card as it is now; refused when it is no longer on the card (edited away). */
export function followupOf(card, followupId) {
  const found = currentFollowups(card).find(item => item.id === followupId);
  if (!found) throw new Error('这条问答已不在这道题上，请刷新后再试');
  return found;
}

/** The note's text with the Q&A added at its end (under 学习记录, the last heading of the template). */
export const withQa = (markdown, followup, language) => `${String(markdown ?? '').replace(/\s*$/, '')}\n\n${noteQa(followup, language)}\n`;
