/* 今日 「重读 N 段」 (#1018): the highlighter and bold marks the learner made in the reader come back where they are weak, so highlighting turns
   into re-reading. No scheduler of its own: a mark waits REST_DAYS after it was made or last re-read (rereadAt, kept on the mark by
   materials.marks.seen), and its weight is the risk of its section as the 资料 page already counts it (lib/material-mastery.js: the chapter the
   passage is in, else its page): due plus weak questions. A section with neither offers nothing. At most DAILY a day, fewer after some were
   re-read today. Only marks of a document's current revision whose words are still there (materials' currentMarks) are read; an archived
   material offers nothing. Pure.

   The host has one event loop, so this stays cheap on a large library: the answer is kept per library revision (asked again: nothing to do),
   the documents are grouped without hashing their texts, and that grouping and the courses of the sources are kept with the store's shared,
   frozen lists they came from (a write that leaves the sources alone, such as an answer, reuses them; so does one that changed only the
   learner's own records on a source, such as 已重读 on a mark). */
import { currentMarks } from '../materials/contracts.js';
import { chapterIndexOf, materialMasteryOf } from '../../material-mastery.js';
import { groupSourcesByDocument } from '../../source-groups.js';
import { segmentationViews, stampSegmentations } from '../../document-outline.js';
import { courseScope } from '../../course-tree.js';
import { libraryCourses, sourcesWithCourses } from '../../source-courses.js';

export const REREAD = Object.freeze({ styles: ['highlight', 'bold'], restDays: 3, daily: 3 });
const DAY = 86400000;
const time = value => { const at = Date.parse(value); return Number.isFinite(at) ? at : 0; };
const midnight = now => { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime(); };
const NONE = Object.freeze({ items: [], count: 0, total: 0 });
const list = value => (Array.isArray(value) ? value : []);

/** `make()` kept with the frozen lists it was made from (`keys`); made afresh when one of them is a working copy. */
const kept = new Map();
function keptWith(name, keys, make) {
  if (!keys.every(key => Object.isFrozen(key))) return make();
  if (!kept.has(name)) kept.set(name, new WeakMap());
  let level = kept.get(name);
  for (const key of keys.slice(0, -1)) { if (!level.has(key)) level.set(key, new WeakMap()); level = level.get(key); }
  const last = keys.at(-1);
  if (!level.has(last)) level.set(last, make());
  return level.get(last);
}

/* The learner's own records kept on a source (the reader's marks, notes, translations, place): changing them changes no document, page or course. */
const OWN_RECORDS = new Set(['marks', 'annotations', 'translations', 'reading']);
const apartFromOwn = source => JSON.stringify(Object.entries(source || {}).filter(([key]) => !OWN_RECORDS.has(key)));
/** The key the grouping is kept under: the frozen source list, or the one before it when they differ only in the learner's own records. */
let lastSources = null, lastKey = null;
function sourcesKey(sources) {
  if (!Object.isFrozen(sources)) return sources;
  if (sources === lastSources) return lastKey;
  const same = lastSources && sources.length === lastSources.length && sources.every((source, at) => source === lastSources[at] || apartFromOwn(source) === apartFromOwn(lastSources[at]));
  if (!same) lastKey = Object.freeze({});
  lastSources = sources;
  return lastKey;
}

/* The documents as the 资料 page lists them (the same keys, pages and chapters as lib/material-mastery.js), grouped without the texts: only their
   fingerprints need them, and nothing here reads one. */
const listingOf = state => keptWith('listing', [sourcesKey(list(state.sources)), list(state.documents)], () =>
  groupSourcesByDocument(stampSegmentations(list(state.sources), segmentationViews(state)).map(source => ({ ...source, text: undefined, chars: typeof source.text === 'string' ? source.text.length : source.chars })),
    { documents: state.documents }));
const coursesOf = state => keptWith('courses', [sourcesKey(list(state.sources)), list(state.decks), list(state.drafts)], () => new Map(sourcesWithCourses(state).map(source => [source.id, source.courses])));
const knownCoursesOf = state => keptWith('known', [sourcesKey(list(state.sources)), list(state.decks), list(state.drafts), list(state.courses)], () => libraryCourses(state));

function compute(state, { course, now, todayStart }, root) {
  const units = currentMarks(state, { groupsOf: () => listingOf(state) });
  if (!units.length) return { ...NONE, items: [] };
  const listing = listingOf(state);
  const scoped = typeof course === 'string' && course.trim() ? courseScope(course, knownCoursesOf(state)) : null;
  const courses = coursesOf(state);
  const mastery = materialMasteryOf(state, { root, now });
  let doneToday = 0;
  const candidates = [];
  for (const unit of units) {
    const item = listing.find(entry => entry.sourceIds.includes(unit.sourceIds[0]));
    if (!item || item.archived) continue;
    if (scoped && !unit.sourceIds.some(id => (courses.get(id) || []).some(scoped))) continue;
    const entry = mastery[item.key];
    for (const mark of unit.items) {
      if (!REREAD.styles.includes(mark.style)) continue;
      if (time(mark.rereadAt) >= todayStart) doneToday++;
      const seen = Math.max(time(mark.at), time(mark.rereadAt));
      if (now - seen < REREAD.restDays * DAY || !entry) continue;
      const chapter = chapterIndexOf(item, mark.sourceId, mark.start), page = entry.pages[mark.sourceId];
      const section = chapter !== null ? entry.chapters[chapter] : page;
      const risk = { due: section?.due || 0, weak: section?.weak || 0 };
      if (!risk.due && !risk.weak) continue;
      const pageNumber = mark.page || (item.totalPages ? item.pages.find(place => place.sourceId === mark.sourceId)?.page : undefined);
      candidates.push({ id: mark.id, documentId: unit.documentId, revision: unit.revision, style: mark.style, title: item.title,
        section: chapter !== null ? item.chapters.find(each => each.index === chapter)?.title || '' : '',
        ...(pageNumber ? { page: pageNumber } : {}),
        // The passage as a citation names it (its revision too: the reader warns about a quote of another revision)
        selection: { ...(unit.documentId ? { documentId: unit.documentId } : {}), revision: unit.revision, sourceId: mark.sourceId, start: mark.start, end: mark.end, quote: mark.quote, prefix: mark.prefix || '', suffix: mark.suffix || '', ...(pageNumber ? { page: pageNumber } : {}) },
        risk, seenAt: new Date(seen).toISOString(), rank: [risk.due + risk.weak, (page?.due || 0) + (page?.weak || 0), -seen] });
    }
  }
  candidates.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2]);
  const items = candidates.slice(0, Math.max(0, REREAD.daily - doneToday)).map(({ rank: _rank, ...candidate }) => candidate);
  return { items, count: items.length, total: candidates.length };
}

const memo = { key: '', value: null };
/**
 * materials.marks.reread: `{ items, count, total }`. Computed once per library revision, course, day and minute (due dates move with time) and
 * kept, so 今日 asking again costs nothing; a library with no marks answers at once.
 */
export function markReread(state, args = {}, { root = '' } = {}) {
  const now = Number.isFinite(args.now) ? args.now : Date.now(), todayStart = Number.isFinite(args.todayStart) ? args.todayStart : midnight(now);
  const course = typeof args.course === 'string' ? args.course : '';
  const key = state?.revision === undefined ? '' : JSON.stringify([root, state.revision, course, todayStart, Math.floor(now / 60000)]);
  if (key && memo.key === key) return structuredClone(memo.value);
  const value = compute(state, { course, now, todayStart }, root);
  if (key) Object.assign(memo, { key, value });
  return structuredClone(value);
}
