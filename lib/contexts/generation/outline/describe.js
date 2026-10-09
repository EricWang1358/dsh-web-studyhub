import { buildOutlineIndex, chapterKey, restKey } from '../../../course-outline-index.js';
import { displayTitle } from '../../../document-title.js';
import { suggestRoles } from '../../../exam-prep-roles.js';
import { normTitle } from '../blueprint/title.js';
import { CHAPTERS_PER_MATERIAL, PROMPTS_PER_UNIT, PROMPT_CHARS, SYLLABUS_CHARS, TOPICS_PER_UNIT } from './constants.js';

/* What the model is shown of a course: compact descriptors, never the texts (the syllabus excepted). A material is its name, format, numbering and date hints,
   how many questions it holds and the topics and first prompts of those questions, per chapter when it has chapters. The ids the model answers with are
   short aliases (m3, m3.2) that the program maps back to the outline engine's own row keys (lib/course-outline-index.js); a rest row is never shown.
   Copies with the same name and the same chapters are one descriptor (`copies`), so they can only land together. Pure: no model, no clock. */

// Written with escapes: \u7b2c is the ordinal prefix, the class after it the units (lecture, chapter, week, lesson, section, day); \u5e74 and \u6708 are year and month.
const NUMBER = new RegExp(['(?:^|[^a-z0-9])(?:lecture|lec|week|wk|day|chapter|ch|unit|topic|part|session|module|l|w)[\\s._-]*(\\d{1,3})(?![0-9])',
  '^\\s*(\\d{1,3})(?=[.\\s_\\u3001-])', '\\u7b2c\\s*(\\d{1,3})\\s*[\\u8bb2\\u7ae0\\u5468\\u8bfe\\u8282\\u5929]'].join('|'), 'i');
const DATE = new RegExp('(20\\d{2})[-_./\\u5e74]?(0?[1-9]|1[0-2])[-_./\\u6708]?(0?[1-9]|[12]\\d|3[01])(?![0-9])');
const VERSION = /(?:^|[^a-z])v(\d+(?:\.\d+)*)(?!\d|\.\d)/i;

/** The ordering hints a name carries: a number (01., Lecture 3, Day1, 第 2 讲), a version (v2.1) and a date (2026-09-03, 20260903, 2026年9月3日). */
export function nameHints(name) {
  const text = String(name ?? ''), number = NUMBER.exec(text), date = DATE.exec(text), version = VERSION.exec(text);
  const value = number ? Number(number[1] ?? number[2] ?? number[3]) : null;
  return { ...(Number.isInteger(value) ? { number: value } : {}), ...(version ? { version: version[1] } : {}),
    ...(date ? { date: `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` } : {}) };
}

const clipped = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

/** The topics (most frequent first) and the first prompts of the questions in some engine nodes. */
function questionsOf(index, nodes) {
  const refs = new Map();
  for (const node of nodes) for (const [ref, order] of index.nodes.get(node) || []) if (!refs.has(ref)) refs.set(ref, order);
  const entries = [...refs.keys()].map(ref => index.cards.get(ref)).filter(Boolean);
  const counts = new Map();
  for (const entry of entries) if (entry.topic) counts.set(entry.topic, (counts.get(entry.topic) || 0) + 1);
  const topics = [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOPICS_PER_UNIT).map(([topic]) => topic);
  const samples = entries.slice(0, PROMPTS_PER_UNIT).map(entry => clipped(entry.prompt, PROMPT_CHARS)).filter(Boolean);
  return { questions: entries.length, ...(topics.length ? { topics } : {}), ...(samples.length ? { samples } : {}) };
}

const chapterTitles = item => (item.chapters || []).map(chapter => normTitle(chapter.title)).join('\u0001');

/**
 * The course as the model sees it.
 * @returns { index, documents, descriptors: [{ id, title, format, ... }], aliases: Map(alias -> [anchor key]), units: [key], unitDoc: Map(key -> document key),
 *            syllabus: { titles, text } | null, roles: Map(document key -> role) }
 */
export function describeCourse(state, course, { papers = [] } = {}) {
  const index = buildOutlineIndex(state, { course });
  const documents = index.allDocuments, byId = new Map((state.sources || []).map(source => [source.id, source]));
  const roles = new Map(suggestRoles(documents).map((suggestion, at) => [documents[at].key, suggestion.role]));
  const paperKeys = new Set(papers);
  const units = [], unitDoc = new Map(), aliases = new Map(), descriptors = [];
  const unitsOf = item => (item.chapters?.length ? item.chapters.map(chapter => chapterKey(item.key, chapter.index)) : [item.key]);
  for (const item of documents) for (const unit of unitsOf(item)) { units.push(unit); unitDoc.set(unit, item.key); }
  // Copies: the same name and the same chapters (a converted copy, the same file imported again) are described once.
  const groups = new Map();
  for (const item of documents) {
    const key = `${normTitle(displayTitle(item.title))}\u0000${chapterTitles(item)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const copies of groups.values()) {
    const [first] = copies, id = `m${descriptors.length + 1}`, name = displayTitle(first.title);
    aliases.set(id, copies.map(item => item.key));
    const audio = byId.get(first.sourceIds[0])?.audio?.batch;
    const own = questionsOf(index, copies.flatMap(item => unitsOf(item).concat(item.chapters?.length ? [restKey(item.key)] : [])));
    const descriptor = { id, title: clipped(name, 160), format: first.format, ...nameHints(`${first.title} ${first.filename ?? ''}`),
      ...(audio?.volumes > 1 ? { part: `${audio.volume}/${audio.volumes}` } : {}), ...(copies.length > 1 ? { copies: copies.length } : {}),
      ...(roles.get(first.key) === 'syllabus' ? { role: 'syllabus' } : copies.some(item => paperKeys.has(item.key)) ? { role: 'sample paper' } : {}) };
    if (first.chapters?.length) {
      descriptor.questions = own.questions;
      descriptor.chapters = first.chapters.slice(0, CHAPTERS_PER_MATERIAL).map((chapter, at) => {
        const alias = `${id}.${at + 1}`;
        aliases.set(alias, copies.map(item => chapterKey(item.key, item.chapters[at].index)));
        return { id: alias, title: clipped(chapter.title || '', 120), ...questionsOf(index, aliases.get(alias)) };
      });
      // Chapters past the shown ones go with the material as a whole.
      if (first.chapters.length > CHAPTERS_PER_MATERIAL) descriptor.moreChapters = first.chapters.length - CHAPTERS_PER_MATERIAL;
    } else Object.assign(descriptor, own);
    descriptors.push(descriptor);
  }
  const syllabi = documents.filter(item => roles.get(item.key) === 'syllabus');
  const text = syllabi.map(item => `## ${displayTitle(item.title)}\n${item.sourceIds.map(id => byId.get(id)?.text ?? '').join('\n')}`).join('\n\n').slice(0, SYLLABUS_CHARS);
  return { index, documents, descriptors, aliases, units, unitDoc, roles,
    syllabus: syllabi.length && text.trim() ? { titles: syllabi.map(item => displayTitle(item.title)), text } : null };
}
