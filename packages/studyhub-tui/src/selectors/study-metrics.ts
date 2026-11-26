/**
 * Single Source of Truth for StudyHub TUI study metrics (#1354 D9).
 *
 * Pure TypeScript (zero React, Ink, or Node I/O imports) so every UI view, shell chrome widget,
 * and fast-path CLI command (`--stats`, `--due`) computes identical numbers for:
 * - Course normalization & matching (`normalizeCourseKey`, `courseEntryKey`, `matchesCourse`)
 * - Active study deck filtering (`isActiveStudyDeck` — excludes archived & `systemKind` decks)
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
  deckCount?: unknown;
  decks?: unknown;
  cardCount?: unknown;
  dueCount?: unknown;
}

export interface StudySnapshotLike {
  decks?: ReadonlyArray<DeckLike> | null;
  courses?: ReadonlyArray<CourseLike> | null;
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
  /** Normalized course keys excluded when scope is unscoped (`all`). */
  excludeInactiveCourses?: ReadonlySet<string>;
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

/** Single course comparison predicate used across views, modals, shell chrome, and CLI. */
export function matchesCourse(
  deckCourse: unknown,
  filterCourse?: string | null,
  opts?: { fuzzy?: boolean },
): boolean {
  const target = normalizeCourseKey(filterCourse);
  if (!target) return true;
  const actual = normalizeCourseKey(deckCourse);
  if (opts?.fuzzy) {
    return actual.toLowerCase().includes(target.toLowerCase());
  }
  return actual === target;
}

/** Extract the typed `progress` map from a snapshot safely. */
export function getProgressMap(
  snapshot: StudySnapshotLike | null | undefined,
): Record<string, DeckProgressLike | undefined> {
  const raw = snapshot?.progress;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, DeckProgressLike | undefined>;
}

/** Extract inactive (parked) course keys normalized via `courseEntryKey`. */
export function selectInactiveCourseKeys(snapshot: StudySnapshotLike | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const c of snapshot?.courses ?? []) {
    if (c && c.active === false) {
      const key = courseEntryKey(c);
      if (key) out.add(key);
    }
  }
  return out;
}

/** True iff `deck` is an active learner-facing study deck (not archived, not a `systemKind` deck). */
export function isActiveStudyDeck(
  deck: DeckLike | null | undefined,
  course?: string | null,
  opts?: ActiveDeckFilterOptions,
): boolean {
  if (!deck || typeof deck !== 'object') return false;
  if (deck.archived) return false;
  if (deck.systemKind) return false;
  if (!matchesCourse(deck.course, course, { fuzzy: opts?.fuzzy })) return false;
  if (!normalizeCourseKey(course) && opts?.excludeInactiveCourses && opts.excludeInactiveCourses.size > 0) {
    const dk = normalizeCourseKey(deck.course);
    if (dk && opts.excludeInactiveCourses.has(dk)) return false;
  }
  return true;
}

/**
 * True iff the cards of `deck` count towards the numbers (due, weak, cards, mastery) of this scope.
 * Like the backend (`lib/insights.js` masterySummary with `courseActivityRules().deckActive`, `studyMap().today`,
 * `wrongBook`, stats totals), a library-wide scope also counts the system decks (为你定制, 斩题组); a course scope
 * does not. Lists of decks keep using `isActiveStudyDeck`.
 */
export function isCountedStudyDeck(
  deck: DeckLike | null | undefined,
  course?: string | null,
  opts?: ActiveDeckFilterOptions,
): boolean {
  if (isActiveStudyDeck(deck, course, opts)) return true;
  return !!deck && typeof deck === 'object' && !deck.archived && !!deck.systemKind && !normalizeCourseKey(course);
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

/**
 * Single source of truth for aggregate study counts & mastery across all active study decks
 * (optionally scoped to `course`). Shared by TopBar, SideNav, LibraryView, TodayHub,
 * DailyBriefing, RoundConfigModal, DashboardView, AssistantPanel, and CLI `--stats` / `--due`.
 */
export function selectStudySummary(
  snapshot: StudySnapshotLike | null | undefined,
  course?: string | null,
  opts?: ActiveDeckFilterOptions,
): StudySummary {
  const rawDecks = Array.isArray(snapshot?.decks) ? snapshot.decks : [];
  const progressMap = getProgressMap(snapshot);
  const activeDecks: DeckLike[] = [];
  // `countedDecks` are the decks whose cards the numbers count (see `isCountedStudyDeck`); `activeDecks` is the deck list.
  const countedDecks: DeckLike[] = [];
  let archivedDecks = 0;

  for (const d of rawDecks) {
    if (!d || typeof d !== 'object') continue;
    if (d.archived) {
      archivedDecks += 1;
      continue;
    }
    if (isActiveStudyDeck(d, course, opts)) activeDecks.push(d);
    if (isCountedStudyDeck(d, course, opts)) countedDecks.push(d);
  }

  let totalCards = 0;
  let deckDueSum = 0;
  let deckWeakSum = 0;
  let newCount = 0;
  let learning = 0;
  let familiar = 0;
  let mastered = 0;
  let weightedMasterySum = 0;
  let masteryWeightDenom = 0;
  let hasProgressDue = false;
  let hasProgressWeak = false;

  for (const d of countedDecks) {
    const p = d.id ? progressMap[d.id] : undefined;
    if (finiteNonNegInt(p?.due) !== null) hasProgressDue = true;
    if (finiteNonNegInt(p?.counts?.weak) !== null) hasProgressWeak = true;

    const m = selectDeckMetrics(d, progressMap);
    totalCards += m.total;
    deckDueSum += m.due;
    deckWeakSum += m.weak;
    newCount += m.newCount;
    learning += m.learning;
    familiar += m.familiar;
    mastered += m.mastered;
    if (m.total > 0) {
      weightedMasterySum += m.mastery * m.total;
      masteryWeightDenom += m.total;
    }
  }

  const unscoped = !normalizeCourseKey(course) && !(opts?.excludeInactiveCourses && opts.excludeInactiveCourses.size > 0);
  const directTodayDue = unscoped ? finiteNonNegInt(snapshot?.today?.due) : null;
  const directTodayWeak = unscoped ? finiteNonNegInt(snapshot?.today?.weak) : null;

  // Prefer deck-level `progress[id].due` whenever present (even when 0 — never leak stale `today.due`).
  // Fall back to `snapshot.today.due` only when unscoped and no deck carries `progress[id].due`.
  const due = hasProgressDue ? deckDueSum : (directTodayDue ?? deckDueSum);

  // Prefer deck-level sums whenever active decks exist (including when every deck has weak=0).
  const weak =
    hasProgressWeak || countedDecks.length > 0 ? deckWeakSum : (directTodayWeak ?? deckWeakSum);

  const masteryPct = masteryWeightDenom > 0 ? clampPct(weightedMasterySum / masteryWeightDenom) : 0;
  const reviewCount = familiar + mastered;
  const bucketTotal = newCount + learning + reviewCount + weak;

  return {
    activeDecks,
    archivedDecks,
    deckCount: activeDecks.length,
    totalCards,
    due,
    weak,
    newCount,
    learning,
    familiar,
    mastered,
    masteryPct,
    fsrsBuckets: {
      newCount,
      learningCount: learning,
      reviewCount,
      relearningCount: weak,
      total: bucketTotal,
      masteryPct,
    },
  };
}

/**
 * Single source of truth for per-course metrics aggregated from active non-system decks.
 * Declared courses from `snapshot.courses` are preserved in order; their `dueCount`, `weakCount`,
 * `deckCount`, `totalCards`, and `masteryPct` are computed from active decks via `selectDeckMetrics`
 * rather than trusting stale raw `course.dueCount`.
 */
export function selectCourseMetrics(
  snapshot: StudySnapshotLike | null | undefined,
  opts?: { includeUncategorized?: boolean; uncategorizedLabel?: string },
): CourseMetrics[] {
  const progressMap = getProgressMap(snapshot);
  const rawCourses = Array.isArray(snapshot?.courses) ? snapshot.courses : [];
  const rawDecks = Array.isArray(snapshot?.decks) ? snapshot.decks : [];

  interface Acc {
    key: string;
    label: string;
    deckCount: number;
    totalCards: number;
    dueCount: number;
    weakCount: number;
    masteredCount: number;
    weightedMastery: number;
    weightDenom: number;
    declaredFallback?: CourseLike;
  }

  const byKey = new Map<string, Acc>();
  const ensure = (key: string, label: string): Acc => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const created: Acc = {
      key,
      label,
      deckCount: 0,
      totalCards: 0,
      dueCount: 0,
      weakCount: 0,
      masteredCount: 0,
      weightedMastery: 0,
      weightDenom: 0,
    };
    byKey.set(key, created);
    return created;
  };

  for (const c of rawCourses) {
    if (!c || typeof c !== 'object') continue;
    const key = courseEntryKey(c);
    if (!key) continue;
    const label = normalizeCourseKey(c.title) || normalizeCourseKey(c.name) || normalizeCourseKey(c.id) || key;
    const acc = ensure(key, label);
    if (!acc.declaredFallback) acc.declaredFallback = c;
  }

  for (const d of rawDecks) {
    if (!isActiveStudyDeck(d)) continue;
    const key = normalizeCourseKey(d.course);
    if (!key && !opts?.includeUncategorized) continue;
    const label = key || opts?.uncategorizedLabel || 'Uncategorized';
    const acc = ensure(key, label);
    const m = selectDeckMetrics(d, progressMap);
    acc.deckCount += 1;
    acc.totalCards += m.total;
    acc.dueCount += m.due;
    acc.weakCount += m.weak;
    acc.masteredCount += m.mastered;
    if (m.total > 0) {
      acc.weightedMastery += m.mastery * m.total;
      acc.weightDenom += m.total;
    }
  }

  const out: CourseMetrics[] = [];
  for (const acc of byKey.values()) {
    if (acc.deckCount === 0 && acc.totalCards === 0 && acc.declaredFallback) {
      const c = acc.declaredFallback;
      out.push({
        key: acc.key,
        label: acc.label,
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
      key: acc.key,
      label: acc.label,
      deckCount: acc.deckCount,
      totalCards: acc.totalCards,
      dueCount: acc.dueCount,
      weakCount: acc.weakCount,
      masteredCount: acc.masteredCount,
      masteryPct: acc.weightDenom > 0 ? clampPct(acc.weightedMastery / acc.weightDenom) : 0,
    });
  }
  return out;
}
