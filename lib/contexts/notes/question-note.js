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

/** Is this Q&A still in the note's text? Its quoted label line is looked for (`> **Follow-up:** <first line>` in either language): a bare question such as
    "Why" also appears in the stem, so the line alone would keep a deleted Q&A counted as saved. An edit after the line is still the same Q&A. */
export function holdsQa(markdown, followup) {
  const first = lines(text(followup?.question)).find(line => line.trim())?.trim();
  if (!first) return false;
  const note = String(markdown ?? '');
  return ['zh', 'en'].some(language => note.includes(qaQuote({ question: first, answer: '' }, language).split('\n')[0]));
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
  return { markdown: `# ${title}\n\n${body}`, body, followupIds };
}

/**
 * The Markdown of a note written from `refs` (questions), and the follow-ups it holds: { markdown, followupIds }. Within the length a note may have
 * (validImageMarkdown, the check of note.save): when every Q&A does not fit, the oldest are left out (the newest kept) and a line says how many.
 */
export function questionNote(state, refs, title, language) {
  const words = wordsOf(language);
  const all = compose(state, refs, title, words, language, (_id, followups) => followups);
  if (validImageMarkdown(all.markdown)) return { markdown: all.markdown, followupIds: all.followupIds };
  // Leave out the oldest Q&A of the note, `drop` of them over all its questions (each card's are kept oldest first), the fewest that make it fit.
  const order = refs.flatMap(ref => { const { card } = findCard(state, ref); return currentFollowups(card).map((entry, at) => ({ cardId: card.id, id: entry.id, at: entry.at || '', index: at })); })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.index - b.index);
  const attempt = drop => { const gone = new Set(order.slice(0, drop).map(entry => entry.id)); return compose(state, refs, title, words, language, (_id, followups) => followups.filter(entry => !gone.has(entry.id))); };
  let low = 1, high = order.length;
  if (!validImageMarkdown(attempt(high).markdown)) throw new Error('Markdown 内容过长');
  while (low < high) { const mid = Math.floor((low + high) / 2); if (validImageMarkdown(attempt(mid).markdown)) high = mid; else low = mid + 1; }
  const fit = attempt(low);
  return { markdown: fit.markdown, followupIds: fit.followupIds };
}

/** Append newly added question(s) onto an existing daily course note separated by `\n\n---\n\n`, without repeating `# title` or duplicating blocks. */
export function appendQuestionEntries(state, existingMarkdown, existingFollowupIds, newRefs, language) {
  const words = wordsOf(language);
  let nextMarkdown = String(existingMarkdown ?? '').replace(/\s*$/, '');
  const nextFollowups = [...(existingFollowupIds || [])];
  const recordFollowup = fid => { if (!nextFollowups.includes(fid)) nextFollowups.push(fid); };
  for (const ref of newRefs) {
    const { deck, card } = findCard(state, ref);
    const stemBlock = labelled(words.question, card.prompt, words);
    const citeMarker = `#studyhub-cite/${deck.id}/${card.id}/`;
    if ((stemBlock && nextMarkdown.includes(stemBlock)) || nextMarkdown.includes(citeMarker)) continue;
    const entry = compose(state, [ref], '', words, language, (_id, followups) => followups);
    const addition = entry.body.trim();
    if (!addition) continue;
    const candidate = nextMarkdown ? `${nextMarkdown}\n\n---\n\n${addition}\n` : `${addition}\n`;
    if (validImageMarkdown(candidate)) {
      nextMarkdown = candidate.replace(/\s*$/, '');
      for (const fid of entry.followupIds) recordFollowup(fid);
    } else {
      const bare = compose(state, [ref], '', words, language, () => []);
      const bareCandidate = nextMarkdown ? `${nextMarkdown}\n\n---\n\n${bare.body.trim()}\n` : `${bare.body.trim()}\n`;
      if (validImageMarkdown(bareCandidate)) nextMarkdown = bareCandidate.replace(/\s*$/, '');
    }
  }
  return { markdown: `${nextMarkdown}\n`, followupIds: nextFollowups };
}

const pad2 = n => String(n).padStart(2, '0');
function normalizeDateToken(raw) {
  const token = String(raw ?? '').trim();
  let match = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(token);
  if (match) {
    const y = Number(match[1]), m = Number(match[3]), d = Number(match[4]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { day: `${y}-${pad2(m)}-${pad2(d)}`, slash: match[2] === '/' };
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(token);
  if (match) {
    const m = Number(match[1]), d = Number(match[2]), y = Number(match[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { day: `${y}-${pad2(m)}-${pad2(d)}`, slash: true };
  }
  return null;
}

const dayFormatters = new Map();
/** Calendar day `YYYY-MM-DD` in the library's daily-recap timezone (falling back to local calendar day). */
export function noteStudyDay(state, value = Date.now()) {
  const stamp = value instanceof Date ? value : new Date(value);
  const valid = Number.isFinite(stamp.getTime()) ? stamp : new Date();
  const tz = typeof state?.settings?.dailyRecap?.timeZone === 'string' && state.settings.dailyRecap.timeZone.trim()
    ? state.settings.dailyRecap.timeZone.trim() : '';
  if (tz) {
    try {
      let fmt = dayFormatters.get(tz);
      if (!fmt) {
        fmt = new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        if (dayFormatters.size >= 32) dayFormatters.clear();
        dayFormatters.set(tz, fmt);
      }
      const parts = fmt.formatToParts(valid);
      const getPart = kind => parts.find(p => p.type === kind)?.value;
      const y = getPart('year'), m = getPart('month'), d = getPart('day');
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch { /* fall back to local calendar date */ }
  }
  return `${valid.getFullYear()}-${pad2(valid.getMonth() + 1)}-${pad2(valid.getDate())}`;
}

/** Parse auto-generated study-note titles (`学习笔记 · 2026/11/17`, `Study notes · 11/17/2026`, `2026-11-17 · Java 八股 · 学习笔记`, etc.); null for custom titles. */
export function parseAutoQuestionNoteTitle(title) {
  const raw = text(title);
  if (!raw) return null;
  let match = /^(学习笔记|Study notes)\s*·\s*(.+)$/i.exec(raw);
  if (match) {
    const parsed = normalizeDateToken(match[2]);
    if (!parsed) return null;
    const lang = /^study notes$/i.test(match[1]) ? 'en' : 'zh';
    return { day: parsed.day, course: '', language: lang, legacy: parsed.slash, prefixDate: false };
  }
  match = /^(\d{4}[/-]\d{1,2}[/-]\d{1,2})\s*·\s*(?:(.+?)\s*·\s*)?(学习笔记|Study notes)$/i.exec(raw);
  if (match) {
    const parsed = normalizeDateToken(match[1]);
    if (!parsed) return null;
    const lang = /^study notes$/i.test(match[3]) ? 'en' : 'zh';
    return { day: parsed.day, course: text(match[2]), language: lang, legacy: parsed.slash, prefixDate: true };
  }
  return null;
}

/** Canonical daily course study-note title (`YYYY-MM-DD · <course> · 学习笔记` or `YYYY-MM-DD · 学习笔记`). */
export function formatDailyQuestionNoteTitle({ day, course = '', language = 'zh' }) {
  const label = language === 'en' ? 'Study notes' : '学习笔记';
  const cleanCourse = text(course);
  return (cleanCourse ? `${day} · ${cleanCourse} · ${label}` : `${day} · ${label}`).slice(0, 200);
}

/** Single shared course of `cards` (`''` when unassigned, `null` when cards span multiple distinct courses or all refs are deleted without a title course). */
export function inferNoteCardsCourse(state, cards, fallbackTitle = '') {
  const list = Array.isArray(cards) ? cards : [];
  const courses = new Set();
  let resolved = 0;
  for (const ref of list) {
    const deck = (state?.decks || []).find(item => item.id === ref?.deckId && (!ref?.cardId || (item.cards || []).some(card => card.id === ref.cardId)))
      || (state?.decks || []).find(item => (item.cards || []).some(card => card.id === ref?.cardId));
    if (!deck) continue;
    resolved++;
    const name = text(deck?.course ?? deck?.folder ?? '');
    if (name) courses.add(name);
  }
  if (list.length > 0 && resolved === 0) {
    const parsed = parseAutoQuestionNoteTitle(fallbackTitle);
    return parsed?.course ? parsed.course : null;
  }
  if (courses.size > 1) return null;
  return courses.size === 1 ? [...courses][0] : '';
}

/** Strip a redundant top `# <auto title>` line from a fragment body before concatenating fragments. */
export function stripLeadingAutoNoteHeading(markdown, ownTitle = '') {
  const raw = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const firstBreak = raw.indexOf('\n');
  const firstLine = (firstBreak >= 0 ? raw.slice(0, firstBreak) : raw).trim();
  if (firstLine.startsWith('# ')) {
    const headingText = firstLine.slice(2).trim();
    if ((ownTitle && headingText === text(ownTitle)) || parseAutoQuestionNoteTitle(headingText)) {
      return (firstBreak >= 0 ? raw.slice(firstBreak + 1) : '').trim();
    }
  }
  return raw.trim();
}

/** The follow-up `followupId` of the card as it is now; refused when it is no longer on the card (edited away). */
export function followupOf(card, followupId) {
  const found = currentFollowups(card).find(entry => entry.id === followupId);
  if (!found) throw new Error('这条问答已不在这道题上，请刷新后再试');
  return found;
}

/** The note's text with the Q&A added at its end (under 学习记录, the last heading of the template). */
export const withQa = (markdown, followup, language) => `${String(markdown ?? '').replace(/\s*$/, '')}\n\n${noteQa(followup, language)}\n`;
