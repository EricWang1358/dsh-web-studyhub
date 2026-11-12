/* 今日 「重读 N 段」 (#1018): the highlighter and bold marks the learner made in the reader come back where they are weak, so highlighting turns
   into re-reading. No scheduler of its own: a mark waits REST_DAYS after it was made or last re-read (rereadAt, kept on the mark by
   materials.marks.seen), and its weight is the risk of its section as the 资料 page already counts it (lib/material-mastery.js: the chapter the
   passage is in, else its page): due plus weak questions. A section with neither offers nothing. At most DAILY a day, fewer after some were
   re-read today. Only marks of a document's current revision whose words are still there (materials' currentMarks) are read. Pure. */
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

function compute(state, { course, now, todayStart }, root) {
  const units = currentMarks(state);
  if (!units.length) return { ...NONE, items: [] };
  const scoped = typeof course === 'string' && course.trim() ? courseScope(course, libraryCourses(state)) : null;
  const courses = new Map(sourcesWithCourses(state).map(source => [source.id, source.courses]));
  const listed = groupSourcesByDocument(stampSegmentations(Array.isArray(state.sources) ? state.sources : [], segmentationViews(state)), { documents: state.documents });
  const mastery = materialMasteryOf(state, { root, now });
  let doneToday = 0;
  const candidates = [];
  for (const unit of units) {
    const item = listed.find(entry => entry.sourceIds.includes(unit.sourceIds[0]));
    if (!item) continue;
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
        selection: { sourceId: mark.sourceId, start: mark.start, end: mark.end, quote: mark.quote, prefix: mark.prefix || '', suffix: mark.suffix || '', ...(pageNumber ? { page: pageNumber } : {}) },
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
