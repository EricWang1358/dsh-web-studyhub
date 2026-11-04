import { bodyText } from '../../../course-book.js';
import { EXEMPLAR_CHARS, SAMPLE_FROM } from './constants.js';

/* The sample slice of a review book build (#710). A build with SAMPLE_FROM or more points to write first writes two of them the whole way (write, review,
   repair, exam notes), saves them in the book with the scale of the rest, and ends; the learner reads them and builds the rest (the sample's points are kept by their
   fingerprint, never paid twice) or changes the settings and makes the sample again. The sample a learner built the rest from is the build's style anchor:
   its words and length band lead every write, review and repair request of that build and of every later one at the same detail level and language.
   The book record holds it (lib/course-book-sample.js); this file decides what a build does about it, and picks it. Pure. */

/** The anchor a sample gives: its words and band, or null when nothing was written for it. */
export const anchorOf = sample => (sample?.exemplar ? { exemplar: sample.exemplar, band: sample.band } : null);

/**
 * What a build does about the sample, decided once in stage 0. `asked`: the request's `sample` ('auto' by default; 'confirm' builds the rest after the waiting
 * sample; 'skip' writes the whole book now); `point`: the gap fill of one point; `sample`: the book's (lib/course-book-sample.js). -> { make, anchor, confirm } or
 * { stale: true } (asked to build the rest of a sample that is not the one these settings would make: refused, nothing is built).
 */
export function sampleMode({ asked = 'auto', point = null, sample = null, level, language }) {
  const fits = !!sample && sample.level === level && sample.language === language;
  const approved = fits && sample.status === 'confirmed' ? anchorOf(sample) : null;
  if (point || asked === 'skip') return { make: false, anchor: approved, confirm: false };
  if (asked === 'confirm') return fits ? { make: false, anchor: anchorOf(sample), confirm: true } : { stale: true };
  return approved ? { make: false, anchor: approved, confirm: false } : { make: true, anchor: null, confirm: false };
}

/** A knowledge point as the pick sees it: its weight (the concepts it holds first, then its anchors) and whether the sample papers test it. */
export const candidateOf = node => ({ id: node.id, weight: (node.items?.length ?? 0) * 1000 + (node.anchors?.length ?? 0), tested: !!node.exam?.evidence?.length });

/**
 * The two points of the sample, from the points to write in book order: the typical one (nearest the median weight; among the tested points when the
 * papers test any, so the sample shows exam notes too) and the heavy one (the heaviest of the rest). Ties go to the earlier point. null with fewer than
 * SAMPLE_FROM points: the build writes them all. `previous`: the book's sample; while both its points are still to write (or kept), they are the sample
 * again, so making it again at the same settings costs nothing and after a change of settings shows the same points.
 */
export function pickSample(candidates, previous = null) {
  if (candidates.length < SAMPLE_FROM) return null;
  const known = new Set(candidates.map(candidate => candidate.id));
  if (previous?.leaves?.length === 2 && previous.leaves.every(id => known.has(id))) return { typical: previous.leaves[0], heavy: previous.leaves[1] };
  const order = candidates.map((candidate, at) => ({ ...candidate, at }));
  const sorted = [...order].sort((a, b) => a.weight - b.weight || a.at - b.at), median = sorted[Math.floor((sorted.length - 1) / 2)].weight;
  const pool = order.some(candidate => candidate.tested) ? order.filter(candidate => candidate.tested) : order;
  const typical = pool.reduce((best, candidate) => (Math.abs(candidate.weight - median) < Math.abs(best.weight - median) ? candidate : best));
  const heavy = order.filter(candidate => candidate !== typical).reduce((best, candidate) => (candidate.weight > best.weight ? candidate : best));
  return { typical: typical.id, heavy: heavy.id };
}

const unmarked = body => bodyText(body).text.replace(/\s?\[\^\d{1,2}\]/g, '').trim();

/** The approved sample's words: the text without its quote marks, cut at a paragraph (else a sentence, else a word) within EXEMPLAR_CHARS. */
export function exemplarOf(body) {
  const text = unmarked(body);
  if (text.length <= EXEMPLAR_CHARS) return text;
  const head = text.slice(0, EXEMPLAR_CHARS), floor = EXEMPLAR_CHARS / 2;
  const paragraph = head.lastIndexOf('\n\n'), sentence = Math.max(...['。', '. ', '！', '？', '! ', '? '].map(mark => head.lastIndexOf(mark)));
  const end = paragraph > floor ? paragraph : sentence > floor ? sentence + 1 : head.lastIndexOf(' ') > floor ? head.lastIndexOf(' ') : EXEMPLAR_CHARS;
  return `${head.slice(0, end).trimEnd()}\n…`;
}

/** The sample's length band: the characters of explanation per must item of each sample point (a point without must items: its whole text), to the ten. */
export function bandOf(bodies) {
  const per = bodies.map(body => Math.round(unmarked(body).length / Math.max(1, body.coverage?.must ?? 0) / 10) * 10);
  return { low: Math.min(...per), high: Math.max(...per) };
}

/** The sample a build saves with the book: waiting for the learner, its points (the typical one first), its words and band, and the scale of the rest. */
export function sampleRecord({ pick, items, level, language, estimate }) {
  const byId = new Map(items.map(item => [item.id, item])), ids = [pick.typical, pick.heavy];
  const written = ids.map(id => byId.get(id)?.body).filter(body => body?.units?.some(unit => unit.text));
  return { status: 'waiting', level, language, leaves: ids, exemplar: written.length ? exemplarOf(written[0]) : '', band: written.length ? bandOf(written) : { low: 0, high: 0 },
    ...(estimate ? { estimate } : {}) };
}
