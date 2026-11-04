import { short16 } from '../sources.js';
import { KIT_QUESTION_CHARS } from '../constants.js';

/* The questions of the sample papers, as the exam answer kit reads them: every paper place the outline put on a knowledge point (its verbatim quote of the
   paper, lib/course-outline-book.js `exam.evidence`), once, in the papers' order, with the points that hold it, the label printed before it (Q1, Question 2 (a),
   第 3 题; else its number in the paper) and its text up to the next question. Pure: no model. */

const LABEL_BEFORE = [/(Q(?:uestion)?\s*\d+(?:\s*\(?[a-z]\)|[a-z])?)\s*[.:：)]?\s*$/i, /(第\s*[一二三四五六七八九十\d]+\s*题)\s*[.:：]?\s*$/,
  /(?:^|\s)(\d+(?:\.\d+)*\s*\([a-z]\)|\d+(?:\.\d+)*\.)\s*$/i, /(?:^|\s)(\([a-z]\))\s*$/i];
const LABEL_INSIDE = /^\s*(Q(?:uestion)?\s*\d+(?:\s*\(?[a-z]\)|[a-z])?|第\s*[一二三四五六七八九十\d]+\s*题)/i;
const NEXT = /\n\s*(?:Q(?:uestion)?\s*\d+|\d+\s*[.)]|\([a-z]\)|第\s*[一二三四五六七八九十\d]+\s*题)/i;
/** A bare sub-part label, (b), and the main number of a label before it (Question 1 of Question 1 (a)). */
const SUB = /^\([a-z]\)$/i;
const MAIN = /^(.*?\d+)\s*(?:\(?[a-z]\)?)?$/i;
const LABEL_CHARS = 24;
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** The label printed just before `start` on its line (or at the start of the quote), or null. */
export function questionLabel(text, start, quote = '') {
  const line = String(text ?? '').slice(Math.max(0, start - 60), start).split('\n').at(-1);
  for (const pattern of LABEL_BEFORE) { const found = pattern.exec(line); if (found) return squash(found[1]).slice(0, LABEL_CHARS); }
  const inside = LABEL_INSIDE.exec(quote);
  return inside ? squash(inside[1]).slice(0, LABEL_CHARS) : null;
}

/** The question's text: from its quote up to the next question's label (at most KIT_QUESTION_CHARS); the quote alone when its place is not known. */
function questionText(source, place) {
  const text = String(source?.text ?? '');
  if (!Number.isInteger(place.start) || text.slice(place.start, place.end) !== place.quote) return squash(place.quote);
  const rest = text.slice(place.start, place.start + KIT_QUESTION_CHARS), next = NEXT.exec(rest.slice(place.quote.length));
  return squash(next ? rest.slice(0, place.quote.length + next.index) : rest);
}

/**
 * @param items the build's points in reading order ({ id, chapter, evidence: [{ sourceId, quote, paper, start?, end? }] })
 * @param context { papers: [{ key }] in the outline's order, byId: Map(source id -> source), titles: Map(paper key -> title) }
 * @returns [{ id, paper, title, label, quote, text, sourceId, start?, end?, leaves: [point id], chapter }] in paper order, then place order
 */
export function paperQuestions(items, { papers, byId, titles }) {
  const order = new Map(papers.map((paper, at) => [paper.key, at])), found = new Map();
  for (const item of items) for (const place of item.evidence || []) {
    if (!order.has(place.paper)) continue;
    const key = JSON.stringify([place.paper, place.sourceId, place.quote]);
    if (found.has(key)) { found.get(key).leaves.push(item.id); continue; }
    const source = byId.get(place.sourceId), span = Number.isInteger(place.start) ? { start: place.start, end: place.end } : {};
    found.set(key, { id: short16(['kit-question', place.paper, place.sourceId, place.quote]).slice(0, 12), paper: place.paper, title: titles.get(place.paper) ?? '',
      label: questionLabel(source?.text, place.start ?? 0, place.quote), quote: place.quote, text: questionText(source, place), sourceId: place.sourceId, ...span,
      leaves: [item.id], chapter: item.chapter ?? 0 });
  }
  // In the paper's own order: its pages as the outline lists them, then the place on the page.
  const pages = new Map(papers.flatMap(paper => (paper.sourceIds || []).map((id, at) => [id, at])));
  const at = question => [order.get(question.paper), pages.get(question.sourceId) ?? 0, question.sourceId, question.start ?? 0];
  const list = [...found.values()].sort((a, b) => { const [x, y] = [at(a), at(b)]; return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2])) || x[3] - y[3]; });
  // A question with no label of its own is named by its number in its paper; a bare sub-part, (b), by the number of the question before it.
  const counts = new Map(), before = new Map();
  return list.map(question => {
    const n = (counts.get(question.paper) ?? 0) + 1, main = MAIN.exec(before.get(question.paper) ?? '')?.[1];
    const label = question.label === null ? `Q${n}` : SUB.test(question.label) && main ? `${main} ${question.label}` : question.label;
    counts.set(question.paper, n); before.set(question.paper, label);
    return { ...question, label };
  });
}

/** The language the papers are written in: Chinese when most of their letters are Chinese, else English. */
export function paperLanguage(questions) {
  const text = questions.map(question => question.text).join(' ');
  const han = (text.match(/[㐀-鿿]/g) || []).length, latin = (text.match(/[A-Za-z]/g) || []).length;
  return han * 2 >= latin && han > 0 ? 'zh' : 'en';
}
