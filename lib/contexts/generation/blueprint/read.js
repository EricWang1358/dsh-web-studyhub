import { parseJson } from '../../../generation.js';
import { BLUEPRINT_LIMITS } from '../../../exam-blueprint-material.js';
import { POINTS_PER_QUESTION, POINTS_PER_WINDOW, QUOTE_CHARS, SLIDE_PLACES } from './constants.js';
import { locateIn, locateQuote } from './quote.js';

/* Reading the model's answers. Nothing the model says is trusted: a quote must be found in the material (quote.js), a point id must be one that was asked about. */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function parse(text) { try { const value = parseJson(String(text)); return object(value) ? value : null; } catch { return null; } }
const clean = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const labelOf = value => clean(typeof value === 'number' && Number.isFinite(value) ? String(value) : value, 40);
const pointOf = entry => {
  const title = clean(entry?.title, BLUEPRINT_LIMITS.titleChars), parent = clean(entry?.parent, BLUEPRINT_LIMITS.titleChars);
  return title ? { title, ...(parent ? { parent } : {}) } : null;
};

/**
 * @returns null when the answer is not the shape asked for, else `{ questions: [{ qid, label, type?, marks?, sourceId?, quote?, points: [{ title, parent? }] }] }`.
 * EVERY question the model returned is kept, whatever its printed label: `qid` (chunk number and order) is what tells two questions apart, `label` is only what is shown.
 * A quote that is not in the paper is not kept (the question keeps its points but has no place to show).
 */
export function readPaper(text, piece) {
  const value = parse(text);
  if (!value || !Array.isArray(value.questions)) return null;
  const questions = [];
  value.questions.forEach((raw, index) => {
    if (!object(raw)) return;
    const home = locateIn(piece.sources, clean(raw.quote, QUOTE_CHARS));
    const points = (Array.isArray(raw.points) ? raw.points : []).slice(0, POINTS_PER_QUESTION).map(pointOf).filter(Boolean);
    questions.push({ qid: `${piece.number}.${index + 1}`, label: labelOf(raw.label) || `#${index + 1}`, ...(clean(raw.type, 40) ? { type: clean(raw.type, 40) } : {}),
      ...(Number.isFinite(raw.marks) && raw.marks >= 0 ? { marks: raw.marks } : {}), ...(home ? { sourceId: home.sourceId, quote: home.quote } : {}), points });
  });
  return { questions };
}

/** @returns null when it is not an object with a list of groups, else the groups as the model gave them (repairGroups checks them). */
export function readMerge(text) {
  const value = parse(text);
  return value && Array.isArray(value.groups) ? { groups: value.groups } : null;
}

/** At most one place per slide, in the order given. */
const onePerSlide = places => places.filter((place, at) => places.findIndex(other => other.sourceId === place.sourceId) === at);

/**
 * @returns null when it is not an object; else the places of the listed points and the extra points, each place as the slide's own words (one per slide).
 * A quote that is not on its slide, or too short to be a place, is dropped and counted in `dropped.evidence`.
 */
export function readSlides(text, window, ids) {
  const value = parse(text);
  if (!value) return null;
  const slides = new Map(window.slides.map(slide => [slide.id, slide]));
  let dropped = 0;
  const place = raw => {
    const slide = slides.get(raw?.slideId), found = slide && locateQuote(slide.text, clean(raw?.quote, QUOTE_CHARS));
    if (found) return { sourceId: slide.id, quote: found.quote };
    dropped++; return null;
  };
  const evidence = [];
  for (const raw of Array.isArray(value.evidence) ? value.evidence : []) {
    const found = typeof raw?.pointId === 'string' && ids.has(raw.pointId) ? place(raw) : (dropped++, null);
    if (found && !evidence.some(item => item.pointId === raw.pointId && item.sourceId === found.sourceId)) evidence.push({ pointId: raw.pointId, ...found });
  }
  const extra = [];
  for (const raw of (Array.isArray(value.extra) ? value.extra : []).slice(0, POINTS_PER_WINDOW)) {
    const point = pointOf(raw);
    if (point) extra.push({ ...point, evidence: onePerSlide((Array.isArray(raw.evidence) ? raw.evidence : []).slice(0, SLIDE_PLACES).map(place).filter(Boolean)) });
  }
  return { evidence, extra, dropped: { evidence: dropped } };
}
