/* Course names as learners write them (WP14). Pure helpers, no renaming:
   a name is a path ("Course / Chapter / Part", lib/course-tree.js) and the
   pickers show the tree; names that only differ in spacing, character width or
   the spacing around "/" are flagged as possible duplicates so the learner can
   merge them with a confirmation. */
import { courseSegments, courseTree } from '../lib/course-tree.js';

const nameOf = course => typeof course === 'string' ? course : String(course?.name || '');
const PUNCTUATION = /\s*([/:;,.!?|·()[\]{}<>+&\-–—、，。：；！？（）【】《》])\s*/g;

/** A comparison key: NFKC (full-width → half-width), case-folded, single spaces, no spaces around punctuation. */
export function courseNameKey(name) {
  return nameOf(name).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(PUNCTUATION, '$1').trim();
}

/**
 * "Course / Chapter" → { parent, chapter } (the parent path and the last segment); null for an ordinary name.
 * A slash without spaces only counts when the part before it is a known course (`known`: the library's names),
 * so "TCP/IP Basics" stays one course and "Cloud Native Solution Design/01 …" joins its parent.
 */
export function splitCourseName(name, known = []) {
  // Segments keep the name as written (no NFKC on the parts: "：" stays "：").
  const segments = courseSegments(nameOf(name), known);
  if (segments.length < 2) return null;
  return { parent: segments.slice(0, -1).join(' / '), chapter: segments.at(-1) };
}

/**
 * Display entries for a course list: top-level names keep the given order, each parent is followed by its descendants
 * in natural order ("01" before "10"):
 *   { type: 'course', course }
 *   { type: 'group', key, name, parent, chapters: [{ course, chapter, depth, relative }] }
 * A parent with at least one chapter is a group. `parent` is the record named like the group, or a synthetic
 * `{ name, implicit: true }` when nothing is filed under it (it is still a scope). `chapter` is the last segment,
 * `relative` the path below the group, `depth` 1 for direct chapters. The records themselves are passed through
 * untouched; two spellings of one path stay two chapters, so both remain manageable.
 */
export function groupCourseNames(courses = []) {
  const records = new Map();
  for (const course of courses) { const name = nameOf(course).trim().replace(/\s+/g, ' '); if (name && !records.has(name)) records.set(name, course); }
  const entries = [];
  let group = null;
  for (const row of courseTree([...records.keys()])) {
    const members = row.names.length ? row.names.map(name => records.get(name)) : [{ name: row.name, implicit: true }];
    if (row.depth === 0) {
      group = null;
      if (!row.childCount) { for (const course of members) entries.push({ type: 'course', course }); continue; }
      const [parent, ...extra] = members;
      group = { type: 'group', key: row.key, name: nameOf(parent), parent, chapters: [] };
      entries.push(group);
      for (const course of extra) group.chapters.push({ course, chapter: nameOf(course), depth: 1, relative: nameOf(course) });
      continue;
    }
    const relative = row.path.slice(1).join(' / ');
    for (const course of members) group.chapters.push({ course, chapter: row.label, depth: row.depth, relative });
  }
  return entries;
}

/** Map of course id (or name) → the other courses whose names have the same key. */
export function findDuplicateCourses(courses = []) {
  const buckets = new Map();
  for (const course of courses) {
    const key = courseNameKey(course);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(course);
  }
  const found = new Map();
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (const course of list) found.set(course?.id || nameOf(course), list.filter(other => other !== course));
  }
  return found;
}

/** The edit distance of two keys where swapping two neighbouring letters counts once (a typed "Desgin"). `limit` stops early: more than that returns limit + 1. */
function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
    }
    rows.push(row);
    if (Math.min(...row) > limit) return limit + 1;
  }
  return rows[a.length][b.length];
}

/**
 * The existing courses a typed name is probably a second spelling of, for the place a course is typed (the import dialog, 新建课程): the same name in another case, width or spacing, or a
 * name one slip away (a missing, extra, wrong or swapped letter; two slips in a name of ten letters or more). Asked, never decided: the caller shows "和已有的「X」很像" with the
 * way to use that course, and the learner keeps what they typed with one click. Not suggested: the existing name itself (that IS the course), names under three letters, and names that
 * differ in their digits (CS2030 and CS2040 are two courses). `courses` are names or course records; the originals are returned, the closest first, at most three.
 */
export function similarCourses(typed, courses = []) {
  const text = nameOf(typed).trim().replace(/\s+/g, ' '), key = courseNameKey(text);
  if (key.length < 3) return [];
  const digits = value => value.replace(/\D/g, '');
  const reach = key.length >= 10 ? 2 : 1;
  return courses.map(course => {
    const own = nameOf(course).trim().replace(/\s+/g, ' '), ownKey = courseNameKey(own);
    if (!ownKey || own === text) return null;
    if (ownKey === key) return { course, distance: 0 };
    if (ownKey.length < 3 || digits(ownKey) !== digits(key)) return null;
    const distance = editDistance(key, ownKey, reach);
    return distance <= reach ? { course, distance } : null;
  }).filter(Boolean).sort((a, b) => a.distance - b.distance).slice(0, 3).map(item => item.course);
}

/** A parked course (lib/course-active.js; the snapshot lists `active: false`): pickers offer it last. */
export const isParkedCourse = course => typeof course === 'object' && course !== null && course.active === false;

const usage = course => typeof course === 'string' ? 0
  : (course.count ?? course.decks ?? 0) + (course.sourceCount ?? course.sources ?? 0) + (course.drafts ?? 0);

/**
 * Courses in the order pickers offer them (WP14): the current course first,
 * then the most recently used (`recent`: name → ISO time, or each course's
 * lastUsedAt), then the ones holding the most decks and materials, then the
 * given order; parked (inactive) courses come after all the others. Accepts names or course objects; returns objects with a
 * `name` (the originals when objects were given).
 */
export function rankCourses({ courses = [], current, recent } = {}) {
  const lookup = recent instanceof Map ? name => recent.get(name) : name => recent?.[name];
  return courses.map((course, index) => {
    const item = typeof course === 'string' ? { name: course } : course;
    return { item, index, current: current !== undefined && current !== null && item.name === current, parked: isParkedCourse(item),
      time: lookup(item.name) || item.lastUsedAt || '', used: usage(course) };
  }).sort((a, b) => (b.current - a.current) || (a.parked - b.parked) || (a.time === b.time ? 0 : a.time < b.time ? 1 : -1) || (b.used - a.used) || (a.index - b.index))
    .map(entry => entry.item);
}
