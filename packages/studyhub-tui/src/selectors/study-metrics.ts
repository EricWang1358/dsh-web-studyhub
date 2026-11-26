/**
 * Single Source of Truth for StudyHub TUI study metrics (#1354 D9).
 *
 * Pure TypeScript (zero React, Ink, or Node I/O imports) so every UI view, shell chrome widget,
 * and fast-path CLI command (`--stats`, `--due`) computes identical numbers for:
 * - Course normalization & matching (`normalizeCourseKey`, `courseEntryKey`, `matchesCourse` — a course holds its sub-courses)
 * - Active study deck filtering for lists (`isActiveStudyDeck` — excludes archived & `systemKind` decks)
 * - Which decks a scope's numbers count (`selectCourseScope` + `countsInScope` — the backend's parked-course and
 *   system-deck rules)
 * - Per-deck metrics (`selectDeckMetrics` — prefers backend `progress[deck.id]` over loose fields
 *   and mirrors `lib/mastery.js` weighted mastery when `progress.mastery` is omitted)
 * - Snapshot aggregate metrics (`selectStudySummary` — due, weak/wrong, new, mastered, FSRS buckets,
 *   and weighted mastery %)
 * - Per-course metrics (`selectCourseMetrics` — course picker, command palette, dashboard, CLI)
 */

/** Weighted mastery coefficients mirrored 1:1 from `lib/mastery.js` (`LEVEL_WEIGHT`). */
export const MASTERY_LEVEL_WEIGHT = Object.freeze({
  new: 0,
  weak: 0.15,
  learning: 0.45,
  familiar: 0.75,
  mastered: 1,
});

export interface DeckProgressCounts {
  new?: unknown;
  weak?: unknown;
  learning?: unknown;
  familiar?: unknown;
  mastered?: unknown;
}

export interface DeckProgressTopic {
  name: string;
  total: number;
  mastery: number;
  due: number;
  status: string;
}

export interface DeckProgressLike {
  total?: unknown;
  mastery?: unknown;
  due?: unknown;
  counts?: DeckProgressCounts;
  topics?: DeckProgressTopic[];
}

export interface DeckLike {
  id?: string;
  title?: unknown;
  name?: unknown;
  course?: unknown;
  archived?: unknown;
  systemKind?: unknown;
  /** Set by the backend when the deck's course (or a parent, or the course an alias names) is parked. */
  inactive?: unknown;
  count?: unknown;
  cardCount?: unknown;
  /** Unsuspended cards (host deck row); the population `progress[id]` is computed over. */
  available?: unknown;
  due?: unknown;
  dueCount?: unknown;
  wrong?: unknown;
  wrongCount?: unknown;
  newCount?: unknown;
  masteredCount?: unknown;
  mastery?: unknown;
  flagged?: unknown;
  suspended?: unknown;
  lastStudiedAt?: unknown;
  updatedAt?: unknown;
  publishedAt?: unknown;
  createdAt?: unknown;
}

export interface CourseLike {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  active?: unknown;
  aliases?: unknown;
  deckCount?: unknown;
  decks?: unknown;
  cardCount?: unknown;
  dueCount?: unknown;
}

export interface StudySnapshotLike {
  decks?: ReadonlyArray<DeckLike> | null;
  courses?: ReadonlyArray<CourseLike> | null;
  drafts?: ReadonlyArray<unknown> | null;
  sources?: ReadonlyArray<unknown> | null;
  progress?: Record<string, unknown> | null;
  today?: { due?: unknown; weak?: unknown; reviewed?: unknown; goal?: unknown } | null;
  focus?: { course?: unknown } | null;
}

export interface DeckMetrics {
  /** Learnable (unsuspended) cards: the population due/new/weak/mastery are counted over (`lib/mastery.js` `deckProgress`). */
  total: number;
  due: number;
  newCount: number;
  weak: number;
  mastered: number;
  familiar: number;
  learning: number;
  mastery: number;
  flagged: number;
  suspended: number;
  lastStudied: string | number | undefined;
  topics: DeckProgressTopic[] | undefined;
}

export interface FsrsBucketSummary {
  newCount: number;
  learningCount: number;
  reviewCount: number;
  relearningCount: number;
  total: number;
  masteryPct: number;
}

export interface StudySummary {
  activeDecks: DeckLike[];
  archivedDecks: number;
  deckCount: number;
  totalCards: number;
  due: number;
  weak: number;
  newCount: number;
  learning: number;
  familiar: number;
  mastered: number;
  masteryPct: number;
  fsrsBuckets: FsrsBucketSummary;
}

export interface CourseMetrics {
  key: string;
  label: string;
  deckCount: number;
  totalCards: number;
  dueCount: number;
  weakCount: number;
  masteredCount: number;
  masteryPct: number;
}

export interface ActiveDeckFilterOptions {
  /** Substring case-insensitive course match (used only for CLI `--course` filter). */
  fuzzy?: boolean;
  /** The library's course names (`selectCourseNames`), for the no-space slash rule of sub-course paths. */
  knownCourses?: ReadonlyArray<unknown>;
}

/**
 * Which decks the numbers of one scope count: everything (`all`), or what `within(course)` holds, and whether the
 * chosen course is itself parked. Built by `selectCourseScope`, read by `countsInScope`.
 */
export interface CourseScope {
  all: boolean;
  within: (course: unknown) => boolean;
  parked: boolean;
}

function finiteNonNegInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Normalize any course identifier / label to a single trimmed string key. */
export function normalizeCourseKey(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Canonical course key for a `snapshot.courses` entry. */
export function courseEntryKey(c: CourseLike | null | undefined): string {
  if (!c) return '';
  return normalizeCourseKey(c.name) || normalizeCourseKey(c.id) || normalizeCourseKey(c.title);
}

/*
 * Course paths, the rule of lib/course-tree.js (`courseScope`): a course holds its sub-courses ("OS / Lab" is in
 * "OS"); " / " always separates, a slash without spaces only after a known course name ("TCP/IP" stays one name);
 * names compare trimmed, whitespace-collapsed and NFKC. The TUI bundle never imports the backend's lib/ (the host
 * loads it at runtime through host/desktop-deps.ts, and dist/ is rebuilt from src/ only), so the rule is mirrored
 * here once; tests/d9-study-metrics-consistency.test.mjs test 6 compares it with the backend on a real library.
 */
const squashCourse = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
const foldCourse = (value: unknown): string => squashCourse(value).normalize('NFKC');
const COURSE_SLASHES = new Set(['/', '／']);
const COURSE_SEPARATOR = ' / ';

function courseKnownKeys(known: ReadonlyArray<unknown> | undefined): Set<string> {
  const keys = new Set<string>();
  for (const item of known ?? []) {
    if (typeof item !== 'string') continue;
    const text = squashCourse(item);
    keys.add(foldCourse(text));
    for (let i = 0; i < text.length; i++) {
      if (!COURSE_SLASHES.has(text[i]) || (text[i - 1] !== ' ' && text[i + 1] !== ' ')) continue;
      if (text.slice(0, i).trim() && text.slice(i + 1).trim()) keys.add(foldCourse(text.slice(0, i)));
    }
  }
  return keys;
}

function courseSegments(text: string, keys: Set<string>): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!COURSE_SLASHES.has(text[i])) continue;
    const head = text.slice(start, i).trim();
    const rest = text.slice(i + 1).trim();
    if (!head || !rest) continue;
    const spaced = text[i - 1] === ' ' || text[i + 1] === ' ';
    if (spaced || keys.has(foldCourse(text.slice(0, i)))) {
      parts.push(head);
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.map(foldCourse);
}

/** `name` -> its comparison paths from the top-level course down to itself ("OS", "OS / Lab"); cached per prepared library. */
type CoursePaths = (name: unknown) => readonly string[];

function coursePaths(known: ReadonlyArray<unknown> | undefined): CoursePaths {
  const keys = courseKnownKeys(known);
  const cache = new Map<string, readonly string[]>();
  return (name) => {
    const text = squashCourse(name);
    if (!text) return [];
    let chain = cache.get(text);
    if (!chain) {
      const segments = courseSegments(text, keys);
      chain = segments.map((_, index) => segments.slice(0, index + 1).join(COURSE_SEPARATOR));
      cache.set(text, chain);
    }
    return chain;
  };
}

/** The library's course names (deck, draft, source and course records), as lib/source-courses.js `knownCourseNames`. */
export function selectCourseNames(snapshot: StudySnapshotLike | null | undefined): string[] {
  const names = new Set<string>();
  const add = (name: unknown) => {
    if (typeof name === 'string' && name.trim()) names.add(name);
  };
  const list = (value: unknown): ReadonlyArray<Record<string, unknown> | null> =>
    Array.isArray(value) ? (value as Array<Record<string, unknown> | null>) : [];
  for (const item of [...list(snapshot?.decks), ...list(snapshot?.drafts)]) add(item?.course ?? item?.folder);
  for (const source of list(snapshot?.sources)) {
    for (const name of Array.isArray(source?.courses) ? source.courses : []) add(name);
    add(source?.course);
  }
  for (const course of list(snapshot?.courses)) add(course?.name);
  return [...names];
}

/** A matcher for "is this course `filterCourse` or one of its sub-courses" (no filter: everything). */
function courseMatcher(filterCourse: unknown, paths: CoursePaths, fuzzy = false): (course: unknown) => boolean {
  const target = normalizeCourseKey(filterCourse);
  if (!target) return () => true;
  if (fuzzy) {
    const needle = target.toLowerCase();
    return (course) => normalizeCourseKey(course).toLowerCase().includes(needle);
  }
  const wanted = paths(target).at(-1) ?? '';
  return (course) => {
    const path = paths(course).at(-1);
    return !!path && (path === wanted || path.startsWith(wanted + COURSE_SEPARATOR));
  };
}

/** Single course comparison predicate used across views, modals, shell chrome, and CLI: the course or one of its sub-courses. */
export function matchesCourse(deckCourse: unknown, filterCourse?: string | null, opts?: ActiveDeckFilterOptions): boolean {
  return courseMatcher(filterCourse, coursePaths(opts?.knownCourses), opts?.fuzzy)(deckCourse);
}

/**
 * `course => parked?` for a chosen course: the nearest course on the way up that the snapshot lists decides, as
 * lib/course-active.js `status()` does; `snapshot.courses[].active` is the backend's own resolved answer (aliases too).
 */
function courseParkedLookup(snapshot: StudySnapshotLike | null | undefined, paths: CoursePaths): (course: string) => boolean {
  const activeByPath = new Map<string, boolean>();
  for (const c of snapshot?.courses ?? []) {
    if (!c || typeof c.active !== 'boolean') continue;
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    for (const name of [c.name, ...aliases]) {
      const path = paths(name).at(-1);
      if (path && !activeByPath.has(path)) activeByPath.set(path, c.active);
    }
  }
  return (course) => {
    const chain = paths(course);
    for (let i = chain.length - 1; i >= 0; i--) {
      const active = activeByPath.get(chain[i]);
      if (active !== undefined) return !active;
    }
    return false;
  };
}

const LIBRARY_SCOPE: CourseScope = Object.freeze({ all: true, within: () => true, parked: false });

/** The scope of one view's numbers: no course is the whole library; `fuzzy` is the CLI `--course` substring match. */
export function selectCourseScope(
  snapshot: StudySnapshotLike | null | undefined,
  course?: string | null,
  opts?: { fuzzy?: boolean },
): CourseScope {
  const target = normalizeCourseKey(course);
  if (!target) return LIBRARY_SCOPE;
  const paths = coursePaths(selectCourseNames(snapshot));
  return { all: false, within: courseMatcher(target, paths, opts?.fuzzy), parked: courseParkedLookup(snapshot, paths)(target) };
}

/**
 * The one decision of which decks' cards count towards a scope's numbers (due, weak, cards, mastery), as the backend's
 * `studyStats` / `studyMap` make it (lib/learning-scope.js, lib/focus.js `decksInCourse`, lib/course-active.js):
 * - archived decks never count;
 * - the whole library counts every deck the backend marks active (`deck.inactive` is `courseActivityRules().deckActive`,
 *   so a parked course leaves with its sub-courses and aliases), system decks (为你定制, 斩题组) included;
 * - a course counts its own and its sub-courses' learner decks, never system decks, and leaves parked ones out unless
 *   the chosen course is itself parked (then it reads what it holds).
 * Lists of decks keep using `isActiveStudyDeck`.
 */
export function countsInScope(deck: DeckLike | null | undefined, scope: CourseScope): boolean {
  if (!deck || typeof deck !== 'object' || deck.archived) return false;
  if (scope.all) return !deck.inactive;
  if (deck.systemKind || !scope.within(deck.course)) return false;
  return !deck.inactive || scope.parked;
}

/**
 * The learner decks a view may send the learner to practise in a course (or the whole library): listed decks
 * (`isActiveStudyDeck`) that the scope counts (`countsInScope`), so a parked course is never pushed. Shared by the
 * daily briefing, `/due` and the library's due tile.
 */
export function selectPractisableDecks<D extends DeckLike>(
  snapshot: (Omit<StudySnapshotLike, 'decks'> & { decks?: ReadonlyArray<D> | null }) | null | undefined,
  course?: string | null,
): D[] {
  const scope = selectCourseScope(snapshot, course);
  const decks: ReadonlyArray<D> = Array.isArray(snapshot?.decks) ? snapshot.decks : [];
  return decks.filter((d) => isActiveStudyDeck(d) && countsInScope(d, scope));
}

/** Extract the typed `progress` map from a snapshot safely. */
export function getProgressMap(
  snapshot: StudySnapshotLike | null | undefined,
): Record<string, DeckProgressLike | undefined> {
  const raw = snapshot?.progress;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, DeckProgressLike | undefined>;
}

/** A learner-facing study deck (not archived, not a `systemKind` deck) whose course `within` holds. */
function listedIn(deck: DeckLike | null | undefined, within: (course: unknown) => boolean): deck is DeckLike {
  return !!deck && typeof deck === 'object' && !deck.archived && !deck.systemKind && within(deck.course);
}

/** True iff `deck` is an active learner-facing study deck (not archived, not a `systemKind` deck) in `course` or a sub-course. */
export function isActiveStudyDeck(
  deck: DeckLike | null | undefined,
  course?: string | null,
  opts?: ActiveDeckFilterOptions,
): boolean {
  return listedIn(deck, courseMatcher(course, coursePaths(opts?.knownCourses), opts?.fuzzy));
}

/**
 * Weighted mastery percentage matching `lib/mastery.js` (`summarize()`).
 * Uses `{ new: 0, weak: 0.15, learning: 0.45, familiar: 0.75, mastered: 1 }`.
 */
export function computeWeightedMasteryPct(
  counts: { weak?: number; learning?: number; familiar?: number; mastered?: number },
  total: number,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const weight =
    (counts.weak ?? 0) * MASTERY_LEVEL_WEIGHT.weak +
    (counts.learning ?? 0) * MASTERY_LEVEL_WEIGHT.learning +
    (counts.familiar ?? 0) * MASTERY_LEVEL_WEIGHT.familiar +
    (counts.mastered ?? 0) * MASTERY_LEVEL_WEIGHT.mastered;
  return clampPct((weight / total) * 100);
}

/**
 * Single source of truth for a deck's metrics (`due`, `weak`, `newCount`, `mastered`, `mastery`, `total`).
 * Prefers backend `progress[deck.id]` fields (which exclude unstudied new cards from `due` and match
 * `lib/mastery.js` `summarize()`), falling back gracefully to loose deck properties when `progress` is absent.
 */
export function selectDeckMetrics(
  deck: DeckLike | null | undefined,
  progressMap?: Record<string, DeckProgressLike | undefined> | null,
): DeckMetrics {
  if (!deck) {
    return {
      total: 0,
      due: 0,
      newCount: 0,
      weak: 0,
      mastered: 0,
      familiar: 0,
      learning: 0,
      mastery: 0,
      flagged: 0,
      suspended: 0,
      lastStudied: undefined,
      topics: undefined,
    };
  }
  const p = deck.id && progressMap ? progressMap[deck.id] : undefined;
  const counts = p?.counts;

  const newCount = finiteNonNegInt(counts?.new) ?? finiteNonNegInt(deck.newCount) ?? 0;
  const weak =
    finiteNonNegInt(counts?.weak) ??
    finiteNonNegInt(deck.wrong) ??
    finiteNonNegInt(deck.wrongCount) ??
    0;
  const learning = finiteNonNegInt(counts?.learning) ?? 0;
  const familiar = finiteNonNegInt(counts?.familiar) ?? 0;
  const mastered = finiteNonNegInt(counts?.mastered) ?? finiteNonNegInt(deck.masteredCount) ?? 0;
  const bucketSum = newCount + weak + learning + familiar + mastered;

  // One population for every number: the learnable (unsuspended) cards the backend counts
  // (`progress.total`); the inventory `count` includes suspended cards and would over-weight
  // such decks in any card-weighted mastery %.
  const inventory = finiteNonNegInt(deck.count) ?? finiteNonNegInt(deck.cardCount);
  const learnableFromRow =
    finiteNonNegInt(deck.available) ??
    (inventory === null ? null : Math.max(0, inventory - (finiteNonNegInt(deck.suspended) ?? 0)));
  const total = finiteNonNegInt(p?.total) ?? learnableFromRow ?? bucketSum;

  const due =
    finiteNonNegInt(p?.due) ??
    finiteNonNegInt(deck.due) ??
    finiteNonNegInt(deck.dueCount) ??
    0;

  let mastery: number;
  if (typeof p?.mastery === 'number' && Number.isFinite(p.mastery)) {
    mastery = clampPct(p.mastery);
  } else if (typeof deck.mastery === 'number' && Number.isFinite(deck.mastery)) {
    mastery = clampPct(deck.mastery);
  } else {
    mastery = computeWeightedMasteryPct({ weak, learning, familiar, mastered }, total > 0 ? total : bucketSum);
  }

  const flagged = finiteNonNegInt(deck.flagged) ?? 0;
  const suspended = finiteNonNegInt(deck.suspended) ?? 0;
  const lastStudied = (deck.lastStudiedAt ?? deck.updatedAt ?? deck.publishedAt ?? deck.createdAt) as
    | string
    | number
    | undefined;

  return {
    total,
    due,
    newCount,
    weak,
    mastered,
    familiar,
    learning,
    mastery,
    flagged,
    suspended,
    lastStudied,
    topics: p?.topics,
  };
}

/** Single-deck due count helper delegating to `selectDeckMetrics`. */
export function selectDeckDueCount(
  deck: DeckLike | null | undefined,
  progressMap?: Record<string, DeckProgressLike | undefined> | null,
): number {
  return selectDeckMetrics(deck, progressMap).due;
}

/** Single-deck weak/wrong count helper delegating to `selectDeckMetrics`. */
export function selectDeckWeakCount(
  deck: DeckLike | null | undefined,
  progressMap?: Record<string, DeckProgressLike | undefined> | null,
): number {
  return selectDeckMetrics(deck, progressMap).weak;
}

interface DeckTotals {
  totalCards: number;
  due: number;
  weak: number;
  newCount: number;
  learning: number;
  familiar: number;
  mastered: number;
  masteryPct: number;
  hasProgressDue: boolean;
  hasProgressWeak: boolean;
}

/** Card-weighted totals of some decks, each read through `selectDeckMetrics`. */
function sumDeckMetrics(
  decks: ReadonlyArray<DeckLike>,
  progressMap: Record<string, DeckProgressLike | undefined>,
): DeckTotals {
  const t: DeckTotals = {
    totalCards: 0,
    due: 0,
    weak: 0,
    newCount: 0,
    learning: 0,
    familiar: 0,
    mastered: 0,
    masteryPct: 0,
    hasProgressDue: false,
    hasProgressWeak: false,
  };
  let weightedMasterySum = 0;
  let masteryWeightDenom = 0;
  for (const d of decks) {
    const p = d.id ? progressMap[d.id] : undefined;
    if (finiteNonNegInt(p?.due) !== null) t.hasProgressDue = true;
    if (finiteNonNegInt(p?.counts?.weak) !== null) t.hasProgressWeak = true;
    const m = selectDeckMetrics(d, progressMap);
    t.totalCards += m.total;
    t.due += m.due;
    t.weak += m.weak;
    t.newCount += m.newCount;
    t.learning += m.learning;
    t.familiar += m.familiar;
    t.mastered += m.mastered;
    if (m.total > 0) {
      weightedMasterySum += m.mastery * m.total;
      masteryWeightDenom += m.total;
    }
  }
  t.masteryPct = masteryWeightDenom > 0 ? clampPct(weightedMasterySum / masteryWeightDenom) : 0;
  return t;
}

/**
 * Single source of truth for aggregate study counts & mastery of one scope (the whole library, or `course` with its
 * sub-courses; see `countsInScope`). Shared by TopBar, SideNav, LibraryView, TodayHub, DailyBriefing,
 * RoundConfigModal, DashboardView, AssistantPanel, and CLI `--stats` / `--due`.
 */
export function selectStudySummary(
  snapshot: StudySnapshotLike | null | undefined,
  course?: string | null,
): StudySummary {
  const rawDecks = Array.isArray(snapshot?.decks) ? snapshot.decks : [];
  const progressMap = getProgressMap(snapshot);
  const scope = selectCourseScope(snapshot, course);
  // `activeDecks` is the deck list (learner decks of the scope); `countedDecks` are the decks whose cards the numbers count.
  const activeDecks: DeckLike[] = [];
  const countedDecks: DeckLike[] = [];
  let archivedDecks = 0;

  for (const d of rawDecks) {
    if (!d || typeof d !== 'object') continue;
    if (d.archived) {
      archivedDecks += 1;
      continue;
    }
    if (listedIn(d, scope.within)) activeDecks.push(d);
    if (countsInScope(d, scope)) countedDecks.push(d);
  }

  const t = sumDeckMetrics(countedDecks, progressMap);
  const directTodayDue = scope.all ? finiteNonNegInt(snapshot?.today?.due) : null;
  const directTodayWeak = scope.all ? finiteNonNegInt(snapshot?.today?.weak) : null;

  // Prefer deck-level `progress[id].due` whenever present (even when 0 — never leak stale `today.due`).
  // Fall back to `snapshot.today.due` only when unscoped and no deck carries `progress[id].due`.
  const due = t.hasProgressDue ? t.due : (directTodayDue ?? t.due);

  // Prefer deck-level sums whenever active decks exist (including when every deck has weak=0).
  const weak = t.hasProgressWeak || countedDecks.length > 0 ? t.weak : (directTodayWeak ?? t.weak);

  const reviewCount = t.familiar + t.mastered;
  const bucketTotal = t.newCount + t.learning + reviewCount + weak;

  return {
    activeDecks,
    archivedDecks,
    deckCount: activeDecks.length,
    totalCards: t.totalCards,
    due,
    weak,
    newCount: t.newCount,
    learning: t.learning,
    familiar: t.familiar,
    mastered: t.mastered,
    masteryPct: t.masteryPct,
    fsrsBuckets: {
      newCount: t.newCount,
      learningCount: t.learning,
      reviewCount,
      relearningCount: weak,
      total: bucketTotal,
      masteryPct: t.masteryPct,
    },
  };
}

/**
 * Single source of truth for per-course metrics (course picker, command palette, dashboard, CLI `--stats`).
 * Declared courses from `snapshot.courses` are preserved in order; each row counts the same decks as
 * `selectStudySummary(snapshot, course)` (sub-courses included, parked ones by `countsInScope`), computed from deck
 * progress rather than trusting stale raw `course.dueCount`.
 */
export function selectCourseMetrics(
  snapshot: StudySnapshotLike | null | undefined,
  opts?: { includeUncategorized?: boolean; uncategorizedLabel?: string },
): CourseMetrics[] {
  const progressMap = getProgressMap(snapshot);
  const rawCourses = Array.isArray(snapshot?.courses) ? snapshot.courses : [];
  const rawDecks = (Array.isArray(snapshot?.decks) ? snapshot.decks : []).filter(
    (d): d is DeckLike => !!d && typeof d === 'object' && !d.archived,
  );
  const paths = coursePaths(selectCourseNames(snapshot));
  const parked = courseParkedLookup(snapshot, paths);

  const rows = new Map<string, { label: string; declared?: CourseLike }>();
  for (const c of rawCourses) {
    if (!c || typeof c !== 'object') continue;
    const key = courseEntryKey(c);
    if (!key) continue;
    const label = normalizeCourseKey(c.title) || normalizeCourseKey(c.name) || normalizeCourseKey(c.id) || key;
    if (!rows.has(key)) rows.set(key, { label, declared: c });
  }
  for (const d of rawDecks) {
    if (!listedIn(d, () => true)) continue;
    const key = normalizeCourseKey(d.course);
    if (!key && !opts?.includeUncategorized) continue;
    if (!rows.has(key)) rows.set(key, { label: key || opts?.uncategorizedLabel || 'Uncategorized' });
  }

  const out: CourseMetrics[] = [];
  for (const [key, row] of rows) {
    // The uncategorised row holds the learner decks filed under no course (lib/course-tree.js scope '').
    const scope: CourseScope = key
      ? { all: false, within: courseMatcher(key, paths), parked: parked(key) }
      : { all: false, within: (course) => !normalizeCourseKey(course), parked: false };
    const listed = rawDecks.filter((d) => listedIn(d, scope.within));
    const t = sumDeckMetrics(
      rawDecks.filter((d) => countsInScope(d, scope)),
      progressMap,
    );
    if (listed.length === 0 && t.totalCards === 0 && row.declared) {
      const c = row.declared;
      out.push({
        key,
        label: row.label,
        deckCount: finiteNonNegInt(c.deckCount) ?? finiteNonNegInt(c.decks) ?? 0,
        totalCards: finiteNonNegInt(c.cardCount) ?? 0,
        dueCount: finiteNonNegInt(c.dueCount) ?? 0,
        weakCount: 0,
        masteredCount: 0,
        masteryPct: 0,
      });
      continue;
    }
    out.push({
      key,
      label: row.label,
      deckCount: listed.length,
      totalCards: t.totalCards,
      dueCount: t.due,
      weakCount: t.weak,
      masteredCount: t.mastered,
      masteryPct: t.masteryPct,
    });
  }
  return out;
}
