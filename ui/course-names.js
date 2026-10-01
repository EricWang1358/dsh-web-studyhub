/* Course names as learners write them (WP14). Pure helpers, no renaming:
   "Course / Chapter" names are grouped for display, and names that only differ
   in spacing, character width or the spacing around "/" are flagged as
   possible duplicates so the learner can merge them with a confirmation. */

const nameOf = course => typeof course === 'string' ? course : String(course?.name || '');
const PUNCTUATION = /\s*([/:;,.!?|·()[\]{}<>+&\-–—、，。：；！？（）【】《》])\s*/g;

/** A comparison key: NFKC (full-width → half-width), case-folded, single spaces, no spaces around punctuation. */
export function courseNameKey(name) {
  return nameOf(name).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(PUNCTUATION, '$1').trim();
}

/**
 * "Course / Chapter" → { parent, chapter }; null for an ordinary name. A slash
 * without spaces only counts when the part before it is several words
 * ("Cloud Native Solution Design/01 …"), so "TCP/IP Basics" stays one course.
 */
export function splitCourseName(name) {
  // Split the name as written (no NFKC on the parts: "：" stays "：").
  const text = nameOf(name);
  const at = text.search(/[/／]/);
  if (at < 0) return null;
  const before = text.slice(0, at), after = text.slice(at + 1);
  const parent = before.replace(/\s+/g, ' ').trim(), chapter = after.replace(/\s+/g, ' ').trim();
  if (!parent || !chapter) return null;
  const spaced = /\s$/.test(before) || /^\s/.test(after);
  if (!spaced && !/\s/.test(parent)) return null;
  return { parent, chapter };
}

const byChapter = (a, b) => a.chapter.localeCompare(b.chapter, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Display entries for a course list, in the given order:
 *   { type: 'course', course }
 *   { type: 'group', key, name, parent?: course, chapters: [{ course, chapter }] }
 * A group needs two or more chapters; a course named exactly like the group
 * heads it as `parent`. The records themselves are passed through untouched.
 */
export function groupCourseNames(courses = []) {
  const parts = courses.map(course => ({ course, split: splitCourseName(course) }));
  const members = new Map();
  for (const { course, split } of parts) {
    if (!split) continue;
    const key = courseNameKey(split.parent);
    if (!members.has(key)) members.set(key, { name: split.parent, chapters: [] });
    members.get(key).chapters.push({ course, chapter: split.chapter });
  }
  for (const [key, group] of members) if (group.chapters.length < 2) members.delete(key);
  const heads = new Map();
  for (const { course, split } of parts) {
    const key = courseNameKey(course);
    if (!split && members.has(key) && !heads.has(key)) heads.set(key, course);
  }
  const entries = [], placed = new Set();
  for (const { course, split } of parts) {
    const key = split ? courseNameKey(split.parent) : courseNameKey(course);
    const group = members.get(key);
    if (group && (split || heads.get(key) === course)) {
      if (placed.has(key)) continue;
      placed.add(key);
      const parent = heads.get(key);
      entries.push({ type: 'group', key, name: parent ? nameOf(parent) : group.name, ...(parent ? { parent } : {}),
        chapters: [...group.chapters].sort(byChapter) });
    } else entries.push({ type: 'course', course });
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

const usage = course => typeof course === 'string' ? 0
  : (course.count ?? course.decks ?? 0) + (course.sourceCount ?? course.sources ?? 0) + (course.drafts ?? 0);

/**
 * Courses in the order pickers offer them (WP14): the current course first,
 * then the most recently used (`recent`: name → ISO time, or each course's
 * lastUsedAt), then the ones holding the most decks and materials, then the
 * given order. Accepts names or course objects; returns objects with a
 * `name` (the originals when objects were given).
 */
export function rankCourses({ courses = [], current, recent } = {}) {
  const lookup = recent instanceof Map ? name => recent.get(name) : name => recent?.[name];
  return courses.map((course, index) => {
    const item = typeof course === 'string' ? { name: course } : course;
    return { item, index, current: current !== undefined && current !== null && item.name === current,
      time: lookup(item.name) || item.lastUsedAt || '', used: usage(course) };
  }).sort((a, b) => (b.current - a.current) || (a.time === b.time ? 0 : a.time < b.time ? 1 : -1) || (b.used - a.used) || (a.index - b.index))
    .map(entry => entry.item);
}
