/* Course as a first-class entity (WP13).

   A course used to be only a name repeated on records: sources carry
   `courses: [name]` (older ones `course` or `audio.course`), decks and drafts
   carry `course` (older ones fall back to `folder`). A course now also has a
   record of its own in the `courses` collection:

     { id, name, aliases: [], createdAt, updatedAt,
       exam?: { format, totalMarks?, writingMinutes?, readingMinutes?, minutesPerMark?, date?,
                sections: [{ title, lecturer?, marks?, topics: [] }] },
       guidanceSourceIds: [], focusTopics: [], sample? }

   and references carry its id next to the legacy name: sources `courseIds`
   beside `courses`, decks and drafts `courseId` beside `course`. The legacy
   names stay authoritative for older readers and are always written in sync:
   `syncCourseReferences` runs inside every store commit, so any writer that
   only changed a name has the matching id (and, for a new name, a course
   record) committed in the same transaction.

   Ids are `course-` + a 12-hex-digit FNV-1a hash of the normalised name (NFKC,
   whitespace collapsed, case kept), so two devices or two restores of the same
   old library derive the same ids. A rename keeps the id and moves the old
   name into `aliases`; an alias still resolves to the course.

   Sources whose course is only inferred (no `courses` array: a legacy
   `course`/`audio.course` or the decks that cite them) stay inferred: they get
   course records for the names, never an explicit assignment.

   `active` (optional boolean, lib/course-active.js): `false` parks a course so
   it stays out of due counts, the forecast, the queue and suggestions; `true`
   keeps a chapter alive inside a parked parent; no field = follow the parent,
   default active. Parking never edits a card, a run, an attempt or a schedule. */
import { sourceRelations, knownCourseNames, courseScopes } from './source-courses.js';
import { courseKnown, coursePath, courseAncestors, courseScope } from './course-tree.js';
import { courseActivityRules, activityFields, dueOf } from './course-active.js';
import { latestOutcomes } from './mastery.js';

export const EXAM_FORMATS = Object.freeze(['open-book-case', 'closed-book', 'mixed', 'other']);
/** One accepted range for saved course settings and per-paper overrides. */
export const EXAM_SETTING_LIMITS = Object.freeze({
  totalMarks: Object.freeze({ min: 1, max: 1000 }), writingMinutes: Object.freeze({ min: 1, max: 1440 }),
  readingMinutes: Object.freeze({ min: 0, max: 600 }), minutesPerMark: Object.freeze({ min: 0.1, max: 60 }),
});
export const COURSE_CARRIERS = Object.freeze(['sources', 'audioResults', 'decks', 'drafts']);
/** Default pacing when an exam profile leaves it open: 3 minutes per mark, 2 hours of writing. */
export const DEFAULT_MINUTES_PER_MARK = 3;
export const DEFAULT_WRITING_MINUTES = 120;
/** Reading time defaults to 1/5 of the writing time, kept within 5-30 minutes: an open-book final with
 * 150 writing minutes gets 30 minutes of reading, as the course lecturer describes. One rule for courses and case papers. */
export const READING_FRACTION = 1 / 5;
export const defaultReadingFor = (writingMinutes) => Math.min(30, Math.max(5, Math.round((Number(writingMinutes) || 0) * READING_FRACTION)));

/* The same few dozen names are normalised for every source, deck and course on every snapshot (hundreds of thousands of times on a
   big library), so the pure result is remembered. The cache is bounded: it is dropped whole when it would pass 4 096 names. */
const keys = new Map();
export const courseKey = name => {
  if (typeof name !== 'string') return '';
  let key = keys.get(name);
  if (key === undefined) {
    key = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (keys.size >= 4096) keys.clear();
    keys.set(name, key);
  }
  return key;
};

/** UTF-8 bytes without TextEncoder (some host sandboxes lack it). */
function* utf8(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) yield code;
    else if (code < 0x800) { yield 0xc0 | code >> 6; yield 0x80 | code & 63; }
    else if (code < 0x10000) { yield 0xe0 | code >> 12; yield 0x80 | code >> 6 & 63; yield 0x80 | code & 63; }
    else { yield 0xf0 | code >> 18; yield 0x80 | code >> 12 & 63; yield 0x80 | code >> 6 & 63; yield 0x80 | code & 63; }
  }
}
const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK = (1n << 64n) - 1n;
/** Deterministic id for a course name (isomorphic: no node:crypto). */
export function courseIdFor(name) {
  let hash = FNV_OFFSET;
  for (const byte of utf8(courseKey(name))) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK;
  return `course-${hash.toString(16).padStart(16, '0').slice(0, 12)}`;
}
const allocateId = (name, taken) => {
  const base = courseIdFor(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
};

const validEntity = course => course && typeof course === 'object' && typeof course.id === 'string' && course.id &&
  typeof course.name === 'string' && courseKey(course.name);
const unique = values => [...new Set(values)];
const nameOf = record => record?.course ?? record?.folder;
const listOf = value => Array.isArray(value) ? value : [];
const timeOf = record => [record?.createdAt, record?.publishedAt].find(value => typeof value === 'string' && Date.parse(value)) || null;

/** Every course name a record states (explicit or legacy), in library order. */
function referencedNames(state) {
  const names = [];
  for (const field of ['decks', 'drafts']) for (const deck of listOf(state[field])) {
    const name = nameOf(deck);
    if (typeof name === 'string' && courseKey(name)) names.push(name);
  }
  for (const field of ['sources', 'audioResults']) for (const source of listOf(state[field])) {
    if (!source || typeof source !== 'object') continue;
    if (Array.isArray(source.courses)) names.push(...source.courses.filter(name => typeof name === 'string' && courseKey(name)));
    for (const name of [source.course, source.audio?.course]) if (typeof name === 'string' && courseKey(name)) names.push(name);
  }
  return names;
}

function keyMap(courses) {
  const keys = new Map();
  for (const course of courses) if (!keys.has(courseKey(course.name))) keys.set(courseKey(course.name), course);
  for (const course of courses) for (const alias of course.aliases || []) {
    const key = courseKey(alias);
    if (key && !keys.has(key)) keys.set(key, course);
  }
  return keys;
}

/** Stored course records plus virtual ones for names no record holds yet (`virtual: true`). */
export function courseEntities(state) {
  const stored = (Array.isArray(state?.courses) ? state.courses : []).filter(validEntity);
  const keys = keyMap(stored), taken = new Set(stored.map(course => course.id)), virtual = [];
  for (const name of referencedNames(state || {})) {
    const key = courseKey(name);
    if (keys.has(key)) continue;
    const course = { id: allocateId(name, taken), name: name.trim(), aliases: [], createdAt: null, updatedAt: null,
      guidanceSourceIds: [], focusTopics: [], virtual: true };
    taken.add(course.id); keys.set(key, course); virtual.push(course);
  }
  return [...stored, ...virtual];
}

/** One lookup structure for loops; helpers accept it in place of the state. */
export function courseIndex(state) {
  if (state?.isCourseIndex) return state;
  const entities = courseEntities(state);
  const byId = new Map(entities.map(course => [course.id, course])), byKey = keyMap(entities);
  return Object.freeze({ isCourseIndex: true, state, entities, byId,
    resolve: name => byKey.get(courseKey(name)) || null,
    find: ({ id, courseId, name } = {}) => (id ?? courseId) !== undefined ? byId.get(id ?? courseId) || null : name !== undefined ? byKey.get(courseKey(name)) || null : null });
}

/** The course name of a deck or draft. Without the state this is the legacy rule. */
export function courseOf(record, state) {
  const name = nameOf(record);
  if (!state) return name ?? '';
  const index = courseIndex(state);
  if (name === undefined) return index.byId.get(record?.courseId)?.name ?? '';
  if (!courseKey(name)) return '';
  return index.resolve(name)?.name ?? name;
}

/** The course id of a deck or draft, or null when it is unassigned. */
export function courseIdOf(record, state) {
  const name = nameOf(record), index = courseIndex(state);
  if (name === undefined) return index.byId.get(record?.courseId)?.id ?? null;
  if (!courseKey(name)) return null;
  return index.resolve(name)?.id ?? courseIdFor(name);
}

/* Which decks cite which source, built once per index. Reading it per source meant a pass over every card for each
   source and each course in the course list: seconds of synchronous work on a big library, in every snapshot poll. */
const relationsOfIndex = new WeakMap();
function citingDecks(index, source) {
  let relations = relationsOfIndex.get(index);
  if (!relations) relationsOfIndex.set(index, relations = sourceRelations(index.state));
  // A record the library does not hold is related from its own id, as before.
  return relations.has(source?.id) ? relations.get(source.id) : sourceRelations({ ...index.state, sources: [source] }).get(source?.id);
}

/** Course ids of a source: explicit assignments, else those inferred from legacy names and citing decks. */
export function courseIdsOf(source, state) {
  const index = courseIndex(state);
  const idOf = name => index.resolve(name)?.id ?? courseIdFor(name);
  if (Array.isArray(source?.courses)) return unique(source.courses.filter(courseKey).map(idOf));
  if (Array.isArray(source?.courseIds)) return unique(source.courseIds.filter(id => index.byId.has(id)));
  const citing = citingDecks(index, source) || [];
  return unique([source?.course, source?.audio?.course, ...citing.map(deck => deck.course)].filter(name => typeof name === 'string' && courseKey(name)).map(idOf));
}

/** A course record (or one created on the fly) that has knowledge of its own beyond its name. */
export const hasCourseKnowledge = course => !!(course?.exam || course?.guidanceSourceIds?.length || course?.focusTopics?.length);

/* ---------- referential sync: runs in every store commit ---------- */

/**
 * Bring ids in line with the (authoritative) legacy names on the carriers that
 * may be written, and create course records for new names when `courses` may be
 * written. Returns the changed record ids per field and whether courses changed.
 */
export function syncCourseReferences(state, writable = null, now = () => new Date().toISOString()) {
  const can = field => !writable || writable.has(field);
  const result = { fields: {}, courses: false };
  if (!COURSE_CARRIERS.some(field => can(field) && Array.isArray(state[field]))) return result;
  if (!Array.isArray(state.courses)) {
    if (!can('courses')) return result;
    state.courses = [];
  }
  const stored = state.courses.filter(validEntity), keys = keyMap(stored), taken = new Set(stored.map(course => course.id));
  const ensure = name => {
    const key = courseKey(name);
    const known = keys.get(key);
    if (known) return known;
    const course = { id: allocateId(name, taken), name: name.trim(), aliases: [], createdAt: now(), updatedAt: now(), guidanceSourceIds: [], focusTopics: [] };
    taken.add(course.id); keys.set(key, course);
    if (can('courses')) { state.courses.push(course); result.courses = true; }
    return course;
  };
  const mark = (field, record) => (result.fields[field] ||= new Set()).add(record.id);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (const field of ['sources', 'audioResults']) if (can(field) && Array.isArray(state[field])) for (const source of state[field]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of [source.course, source.audio?.course]) if (typeof name === 'string' && courseKey(name)) ensure(name);
    let courses = source.courses;
    if (!Array.isArray(courses) && Array.isArray(source.courseIds)) {
      // Written by a reader that only knew ids: restore the names.
      const byId = new Map([...keys.values()].map(course => [course.id, course]));
      courses = source.courseIds.map(id => byId.get(id)?.name).filter(Boolean);
    }
    if (!Array.isArray(courses)) continue;
    const entities = unique(courses.filter(name => typeof name === 'string' && courseKey(name)).map(ensure));
    const names = entities.map(course => course.name), ids = entities.map(course => course.id);
    if (!same(source.courses, names) || !same(source.courseIds, ids)) { source.courses = names; source.courseIds = ids; mark(field, source); }
  }
  for (const field of ['decks', 'drafts']) if (can(field) && Array.isArray(state[field])) for (const deck of state[field]) {
    if (!deck || typeof deck !== 'object') continue;
    const name = nameOf(deck);
    if (name === undefined) {
      if (deck.courseId === undefined) continue;
      const course = [...keys.values()].find(item => item.id === deck.courseId);
      if (course) deck.course = course.name; else delete deck.courseId;
      mark(field, deck);
      continue;
    }
    if (typeof name !== 'string' || !courseKey(name)) {
      if (deck.courseId !== undefined) { delete deck.courseId; mark(field, deck); }
      continue;
    }
    const course = ensure(name);
    let changed = false;
    if (name !== course.name && (deck.course !== undefined || courseKey(deck.folder) !== courseKey(course.name))) { deck.course = course.name; changed = true; }
    if (deck.courseId !== course.id) { deck.courseId = course.id; changed = true; }
    if (changed) mark(field, deck);
  }
  return result;
}

/** Store migration 3 → 4: course records for every name, ids on every explicit reference. */
export function materializeCourses(state) {
  const earliest = new Map();
  for (const field of ['decks', 'drafts', 'sources', 'audioResults']) for (const record of listOf(state[field])) {
    const time = timeOf(record);
    if (!time) continue;
    const names = [nameOf(record), ...(Array.isArray(record.courses) ? record.courses : []), record.course, record.audio?.course];
    for (const name of names) if (typeof name === 'string' && courseKey(name)) {
      const key = courseKey(name), seen = earliest.get(key);
      if (!seen || Date.parse(time) < Date.parse(seen)) earliest.set(key, time);
    }
  }
  const next = { ...state, courses: Array.isArray(state.courses) ? state.courses : [] };
  syncCourseReferences(next, null, () => null);
  for (const course of next.courses) if (course.createdAt === null) {
    course.createdAt = earliest.get(courseKey(course.name)) || null;
    course.updatedAt = course.createdAt;
  }
  return next;
}

/* ---------- validation and profile ---------- */

const fail = message => { throw new Error(message); };
const checkedName = value => {
  if (typeof value !== 'string' || !courseKey(value) || value.trim().length > 200) fail('课程名称需为 1–200 字');
  return value.trim();
};
const checkedText = (value, limit, message) => {
  if (typeof value !== 'string' || value.trim().length > limit) fail(message);
  return value.trim();
};
const checkedNumber = (value, min, max, message) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(message);
  return value;
};
const checkedTopics = (value, limit = 50) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit || value.some(topic => typeof topic !== 'string' || topic.trim().length > 200))
    fail('知识点需为不超过 50 项的列表，每项不超过 200 字');
  return unique(value.map(topic => topic.trim()).filter(Boolean));
};

/** A stored exam profile: only what the learner stated, nothing derived. */
export function checkedExam(exam) {
  if (exam === undefined || exam === null) return exam;
  if (typeof exam !== 'object' || Array.isArray(exam)) fail('考试信息格式不对');
  const format = exam.format ?? 'other';
  if (!EXAM_FORMATS.includes(format)) fail('考试形式需为开卷案例、闭卷、混合或其他');
  const out = { format };
  const totalMarks = checkedNumber(exam.totalMarks, EXAM_SETTING_LIMITS.totalMarks.min, EXAM_SETTING_LIMITS.totalMarks.max, '总分需为 1–1000');
  const writingMinutes = checkedNumber(exam.writingMinutes, EXAM_SETTING_LIMITS.writingMinutes.min, EXAM_SETTING_LIMITS.writingMinutes.max, '作答时间需为 1–1440 分钟');
  const readingMinutes = checkedNumber(exam.readingMinutes, EXAM_SETTING_LIMITS.readingMinutes.min, EXAM_SETTING_LIMITS.readingMinutes.max, '阅读时间需为 0–600 分钟');
  const minutesPerMark = checkedNumber(exam.minutesPerMark, EXAM_SETTING_LIMITS.minutesPerMark.min, EXAM_SETTING_LIMITS.minutesPerMark.max, '每分用时需为 0.1–60 分钟');
  Object.assign(out, Object.fromEntries(Object.entries({ totalMarks, writingMinutes, readingMinutes, minutesPerMark }).filter(([, value]) => value !== undefined)));
  if (exam.date !== undefined && exam.date !== null && exam.date !== '') {
    if (typeof exam.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exam.date) || Number.isNaN(Date.parse(`${exam.date}T00:00:00Z`))) fail('考试日期需为 YYYY-MM-DD');
    out.date = exam.date;
  }
  const sections = exam.sections ?? [];
  if (!Array.isArray(sections) || sections.length > 20) fail('考试部分最多 20 个');
  out.sections = sections.map(section => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) fail('考试部分格式不对');
    const item = { title: checkedText(section.title ?? '', 200, '部分标题过长或格式不对'), topics: checkedTopics(section.topics ?? []) };
    if (!item.title) fail('每个考试部分都需要标题');
    if (section.lecturer !== undefined && section.lecturer !== null && String(section.lecturer).trim()) item.lecturer = checkedText(section.lecturer, 200, '讲师名过长或格式不对');
    const marks = checkedNumber(section.marks, 0, 1000, '部分分值需为 0–1000');
    if (marks !== undefined) item.marks = marks;
    return item;
  });
  return out;
}

/** Exam profile with defaults filled (documented at the top of this file). */
export function examProfile(exam) {
  const stated = exam && typeof exam === 'object' ? exam : {};
  const sections = Array.isArray(stated.sections) ? structuredClone(stated.sections) : [];
  const sectionMarks = sections.reduce((sum, section) => sum + (Number(section.marks) || 0), 0);
  let totalMarks = stated.totalMarks ?? (sectionMarks > 0 ? sectionMarks : undefined);
  let writingMinutes = stated.writingMinutes;
  const minutesPerMark = stated.minutesPerMark ?? (totalMarks && writingMinutes ? Math.round(writingMinutes / totalMarks * 100) / 100 : DEFAULT_MINUTES_PER_MARK);
  if (totalMarks === undefined) totalMarks = Math.max(1, Math.round((writingMinutes ?? DEFAULT_WRITING_MINUTES) / minutesPerMark));
  if (writingMinutes === undefined) writingMinutes = Math.round(totalMarks * minutesPerMark);
  const readingMinutes = stated.readingMinutes ?? defaultReadingFor(writingMinutes);
  return { format: EXAM_FORMATS.includes(stated.format) ? stated.format : 'other', totalMarks, writingMinutes, readingMinutes, minutesPerMark,
    ...(stated.date ? { date: stated.date } : {}), sections };
}

/** Whole days from today to the exam date (local calendar), or null. */
export function daysUntilExam(exam, now = new Date()) {
  if (!exam?.date || !/^\d{4}-\d{2}-\d{2}$/.test(exam.date)) return null;
  const [year, month, day] = exam.date.split('-').map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(year, month - 1, day) - today) / 86400000);
}

/* ---------- reads ---------- */

export function findCourse(state, ref = {}) {
  const course = courseIndex(state).find(ref);
  if (!course) fail('课程不存在');
  return course;
}

/** A course with how much of the library it holds, and whether it counts (`active`; `explicit`: its own setting; `inactiveBy`: the parked parent). */
export function courseView(state, course, index = courseIndex(state), counts = null, rules = courseActivityRules(state)) {
  const count = list => (list || []).filter(deck => !deck.archived && !deck.systemKind && courseIdOf(deck, index) === course.id).length;
  const { virtual, active: _own, ...stored } = course;
  return { ...structuredClone(stored), ...(virtual ? { virtual: true } : {}), decks: counts ? counts.decks.get(course.id) || 0 : count(state.decks),
    drafts: counts ? counts.drafts.get(course.id) || 0 : count(state.drafts),
    sources: counts ? counts.sources.get(course.id) || 0 : (state.sources || []).filter(source => courseIdsOf(source, index).includes(course.id)).length,
    ...activityFields(rules, course.name) };
}

/** Courses in library order (as the course switcher lists them), then the rest. */
export function courseList(state, order = []) {
  const index = courseIndex(state);
  const ranked = unique(order.map(name => index.resolve(name)).filter(Boolean));
  const rules = courseActivityRules(state);
  // One pass over decks, drafts and sources counts them per course (a view used to filter all of them for each course).
  const counts = { decks: new Map(), drafts: new Map(), sources: new Map() };
  const tally = (map, id) => map.set(id, (map.get(id) || 0) + 1);
  for (const [field, list] of [['decks', state.decks], ['drafts', state.drafts]])
    for (const deck of list || []) if (!deck.archived && !deck.systemKind) tally(counts[field], courseIdOf(deck, index));
  const sourceIds = (state.sources || []).map(source => courseIdsOf(source, index));
  for (const ids of sourceIds) for (const id of new Set(ids)) tally(counts.sources, id);
  const views = unique([...ranked, ...index.entities]).map(course => courseView(state, course, index, counts, rules));
  // A parent course also holds what its chapters hold ("含子课程"): decksTotal / sourcesTotal add the whole subtree.
  const known = courseKnown(knownCourseNames(state)), totals = new Map();
  const bump = (name, field) => { for (const path of courseAncestors(name, known)) { const row = totals.get(path) || { decks: 0, sources: 0 }; row[field]++; totals.set(path, row); } };
  for (const deck of state.decks || []) if (!deck.archived && !deck.systemKind) { const name = courseOf(deck, index); if (name) bump(name, 'decks'); }
  for (const ids of sourceIds) {
    const names = ids.map(id => index.byId.get(id)?.name).filter(Boolean);
    for (const path of new Set(names.flatMap(name => courseAncestors(name, known)))) { const row = totals.get(path) || { decks: 0, sources: 0 }; row.sources++; totals.set(path, row); }
  }
  return views.map(view => ({ ...view, decksTotal: totals.get(coursePath(view.name, known))?.decks || 0, sourcesTotal: totals.get(coursePath(view.name, known))?.sources || 0 }));
}

export function courseProfile(course) {
  return { courseId: course.id, name: course.name, exam: examProfile(course.exam),
    guidanceSourceIds: [...(course.guidanceSourceIds || [])], focusTopics: [...(course.focusTopics || [])] };
}

/* ---------- writes (pure: callers run them inside one store transaction) ---------- */

const persist = (state, course) => {
  if (!Array.isArray(state.courses)) state.courses = [];
  let stored = state.courses.find(item => item.id === course.id);
  if (!stored) {
    const { virtual: _virtual, ...rest } = structuredClone(course);
    stored = { ...rest, createdAt: rest.createdAt || new Date().toISOString() };
    state.courses.push(stored);
  }
  return stored;
};

export function saveCourse(state, args = {}) {
  const name = checkedName(args.name);
  const index = courseIndex(state);
  let course;
  if (args.id !== undefined) {
    course = index.byId.get(args.id) || fail('课程不存在');
    if (courseKey(course.name) !== courseKey(name)) fail('课程改名请使用「改名」（course.rename），以便同步更新题组和资料');
  } else course = index.resolve(name) || { id: allocateId(name, new Set(index.byId.keys())), name, aliases: [], createdAt: null, guidanceSourceIds: [], focusTopics: [] };
  const exam = args.exam === undefined ? undefined : checkedExam(args.exam);
  let guidanceSourceIds;
  if (args.guidanceSourceIds !== undefined) {
    if (!Array.isArray(args.guidanceSourceIds) || args.guidanceSourceIds.length > 50 || args.guidanceSourceIds.some(id => typeof id !== 'string' || !id))
      fail('考官指引资料最多 50 份');
    guidanceSourceIds = unique(args.guidanceSourceIds);
    if (Array.isArray(state.sources) && guidanceSourceIds.some(id => !state.sources.some(source => source.id === id)))
      fail('考官指引里有资料不存在，请刷新后重选');
  }
  const focusTopics = checkedTopics(args.focusTopics);
  const stored = persist(state, course);
  if (stored.name !== name && courseKey(stored.name) === courseKey(name)) stored.name = name;
  if (exam === null) delete stored.exam; else if (exam !== undefined) stored.exam = exam;
  if (guidanceSourceIds !== undefined) stored.guidanceSourceIds = guidanceSourceIds;
  if (focusTopics !== undefined) stored.focusTopics = focusTopics;
  stored.aliases ||= []; stored.guidanceSourceIds ||= []; stored.focusTopics ||= [];
  stored.updatedAt = new Date().toISOString();
  return stored;
}

/** The stored record of a course (created when only a name or an implicit parent existed), for writers that must keep a setting on it. */
function ensureCourse(state, name) {
  const index = courseIndex(state);
  const course = index.resolve(name) || { id: allocateId(name, new Set(index.byId.keys())), name: name.trim(), aliases: [], createdAt: null, guidanceSourceIds: [], focusTopics: [] };
  const stored = persist(state, course);
  stored.aliases ||= []; stored.guidanceSourceIds ||= []; stored.focusTopics ||= [];
  return stored;
}

/**
 * Park or revive a course (`active` false / true). Idempotent; never touches a card, run, attempt or schedule.
 * - parking writes `active: false` on the course; its chapters follow it unless they carry their own setting, and
 *   `withSubCourses: false` keeps the chapters going by giving each one an explicit `active: true`;
 * - activating removes the setting, or, when a parked parent would still park the course, writes `active: true`.
 * Reports how much it changes: `decks`, `due`, `overdue` (cards due now, before today began) of the decks whose state
 * flipped, the `subCourses` that went with it, and whether the learner's `current` course is inside it.
 */
export function setCourseActive(state, args = {}, now = Date.now()) {
  if (typeof args.active !== 'boolean') fail('有效状态需为 true 或 false');
  if (args.withSubCourses !== undefined && typeof args.withSubCourses !== 'boolean') fail('连同子课程需为 true 或 false');
  const index = courseIndex(state), ref = args.id ?? args.courseId;
  let found = ref !== undefined ? index.byId.get(ref) : args.name !== undefined ? index.resolve(args.name) : fail('请指定课程');
  // A parent nobody filed anything under is a course too ("Lone" for "Lone / ch 1").
  if (!found && ref === undefined && typeof args.name === 'string' && courseKey(args.name) && courseScopes(state).some(name => courseKey(name) === courseKey(args.name)))
    found = { id: allocateId(args.name.trim(), new Set(index.byId.keys())), name: args.name.trim(), aliases: [], createdAt: null, guidanceSourceIds: [], focusTopics: [] };
  if (!found) fail('课程不存在');
  const name = found.name, before = courseActivityRules(state), known = courseKnown(knownCourseNames(state));
  const own = typeof found.active === 'boolean' ? found.active : undefined;
  const self = coursePath(name, known), within = courseScope(name, known), seen = new Set([self]);
  const below = courseScopes(state).filter(item => courseKey(item) && within(item) && !seen.has(coursePath(item, known)) && seen.add(coursePath(item, known)));
  let desired;
  if (!args.active) desired = false;
  else {
    const bare = { ...state, courses: (state.courses || []).map(course => course.id === found.id ? Object.fromEntries(Object.entries(course).filter(([field]) => field !== 'active')) : course) };
    desired = courseActivityRules(bare).status(name).active ? undefined : true;
  }
  const kept = !args.active && args.withSubCourses === false ? below.filter(item => { const status = before.status(item); return status.active && status.explicit === undefined; }) : [];
  const changed = desired !== own || kept.length > 0;
  const wasActive = new Map((state.decks || []).map(deck => [deck.id, before.deckActive(deck)]));
  if (changed) {
    const stamp = new Date(now).toISOString();
    if (desired !== own) {
      const stored = ensureCourse(state, name);
      if (desired === undefined) delete stored.active; else stored.active = desired;
      stored.updatedAt = stamp;
    }
    for (const item of kept) { const stored = ensureCourse(state, item); stored.active = true; stored.updatedAt = stamp; }
  }
  const after = courseActivityRules(state);
  const flipped = (state.decks || []).filter(deck => !deck.archived && !deck.systemKind && wasActive.get(deck.id) !== after.deckActive(deck));
  const focus = state.focus?.course;
  return { id: found.id, name, active: after.status(name).active, explicit: changed ? desired : own, changed,
    decks: flipped.length, ...dueOf(flipped, latestOutcomes(state.attempts || []), now),
    subCourses: below.filter(item => before.status(item).active !== after.status(item).active), kept,
    current: typeof focus === 'string' && !!courseKey(focus) && within(focus) };
}

/** Point every record that belongs to one of `fromIds` at `target` (name and id). */
function relabel(state, belongs, target) {
  const updated = {};
  const count = field => { updated[field] = (updated[field] || 0) + 1; };
  for (const field of ['sources', 'audioResults']) for (const source of state[field] || []) {
    let touched = false;
    if (Array.isArray(source.courses) && source.courses.some(belongs)) {
      source.courses = unique(source.courses.map(name => belongs(name) ? target.name : name));
      touched = true;
    }
    if (belongs(source.course)) { source.course = target.name; touched = true; }
    if (belongs(source.audio?.course)) { source.audio = { ...source.audio, course: target.name }; touched = true; }
    if (touched) count(field);
  }
  for (const field of ['decks', 'drafts']) for (const deck of state[field] || []) {
    let touched = false;
    if (belongs(nameOf(deck))) { deck.course = target.name; deck.courseId = target.id; touched = true; }
    if (belongs(deck.editorial?.generation?.course)) { deck.editorial.generation.course = target.name; touched = true; }
    if (touched) count(field);
  }
  for (const run of state.runs || []) if (belongs(run.course)) { run.course = target.name; count('runs'); }
  for (const session of state.workflowSessions || []) if (belongs(session.course?.name)) { session.course.name = target.name; count('workflowSessions'); }
  if (state.focus && belongs(state.focus.course)) { state.focus = { ...state.focus, course: target.name }; updated.focus = 1; }
  return updated;
}

export function renameCourse(state, args = {}) {
  const name = checkedName(args.name);
  const index = courseIndex(state);
  const course = index.byId.get(args.id) || fail('课程不存在');
  const clash = index.resolve(name);
  if (clash && clash.id !== course.id) fail('已有同名课程，如需并为一门请用合并');
  const belongs = value => typeof value === 'string' && index.resolve(value)?.id === course.id;
  const stored = persist(state, course);
  const previous = stored.name;
  stored.aliases = unique([...(stored.aliases || []), previous]).filter(alias => courseKey(alias) !== courseKey(name));
  stored.name = name;
  stored.updatedAt = new Date().toISOString();
  stored.guidanceSourceIds ||= []; stored.focusTopics ||= [];
  const updated = relabel(state, belongs, stored);
  syncCourseReferences(state);
  return { course: courseView(state, stored), previousName: previous, updated };
}

export function mergeCourses(state, args = {}) {
  const index = courseIndex(state);
  if (!Array.isArray(args.from) || !args.from.length || args.from.length > 20 || args.from.some(id => typeof id !== 'string'))
    fail('请选择 1–20 门要合并的课程');
  const into = index.byId.get(args.into) || fail('课程不存在');
  const from = unique(args.from).map(id => index.byId.get(id) || fail('课程不存在'));
  if (from.some(course => course.id === into.id)) fail('不能把课程合并到它自己，请选择要合并的其他课程');
  const fromIds = new Set(from.map(course => course.id));
  const belongs = value => typeof value === 'string' && fromIds.has(index.resolve(value)?.id);
  const stored = persist(state, into);
  stored.aliases = unique([...(stored.aliases || []), ...from.flatMap(course => [course.name, ...(course.aliases || [])])])
    .filter(alias => courseKey(alias) !== courseKey(stored.name));
  stored.guidanceSourceIds = unique([...(stored.guidanceSourceIds || []), ...from.flatMap(course => course.guidanceSourceIds || [])]);
  stored.focusTopics = unique([...(stored.focusTopics || []), ...from.flatMap(course => course.focusTopics || [])]);
  if (!stored.exam) { const exam = from.find(course => course.exam)?.exam; if (exam) stored.exam = structuredClone(exam); }
  stored.updatedAt = new Date().toISOString();
  state.courses = state.courses.filter(course => !fromIds.has(course.id));
  const updated = relabel(state, belongs, stored);
  syncCourseReferences(state);
  return { course: courseView(state, stored), merged: [...fromIds], updated };
}
