import { useCallback, useContext } from 'react';
import { ui } from './i18n.js';
import { FINDER_ENTRIES } from './finder/entries.js';
import { finderAvailability } from './finder/availability.js';
import { USAGE_REGISTRY_BY_KEY } from './usage/registry.js';
import { modelReadiness } from './generation-status.js';
import { browserSession, browserStorage, readJSON, writeJSON } from './storage.js';
import { courseMatcher, decksInCourse, writePageScope } from './PageScope.jsx';
import { useStudy } from './study-context.jsx';
import { useHandOff } from './hand-off/use-hand-off.js';
import { AppContext } from './app/app-context.js';
import { ACTIVITIES, ALTERNATIVES_MAX, atLeast, courseMethod, gateRule, stageScope } from '../lib/course-method.js';
import { isLibraryListSource } from '../lib/exam-point-list.js';

/* 「也可以」 (#775, 4.5 S1): maps a stage's alternative activities onto StudyHub's single-source feature index (ui/finder/entries.js), host capability check
   (ui/finder/availability.js), model readiness, and usage/history records — no parallel feature table.
   - Host or model missing -> hidden ("只显示现在能用的功能，比如没连模型就不推荐口试").
   - Course prerequisite missing -> shown on the card as disabled with plain reason (「导入讲义后可用」 / 「发布题组后可用」), omitted at round end.
   - Already used -> demoted to a quiet 「已用过」 tag on the card, omitted at round end. */

export const METHOD_ALT_USED_PREFIX = 'study-method-alt-used:v1:';

/** Plain-spoken labels for selecting a stage's main activity or 「也可以」 in MethodForm (Chinese source text; English in ui/locales/en.course.json). */
export const ACTIVITY_LABELS = Object.freeze({
  publish: '导入资料',
  practice: '按批练习',
  review: '巩固复习',
  explain: '讲给我听',
  check: '口头检验',
  project: '整理笔记',
});

const ENTRY_BY_ID = new Map(FINDER_ENTRIES.map(entry => [entry.id, entry]));

const ACTIVITY_SPECS = Object.freeze({
  publish: Object.freeze({ entryId: 'page-sources', usageKeys: Object.freeze(['import.add', 'nav.sources']) }),
  practice: Object.freeze({ entryId: 'page-generate', readyEntryId: 'page-library', usageKeys: Object.freeze(['review.submit', 'review.grade', 'generate.submit']) }),
  review: Object.freeze({ entryId: 'page-wrongbook', usageKeys: Object.freeze(['nav.wrongbook']) }),
  explain: Object.freeze({ entryId: 'guided-study', usageKeys: Object.freeze(['generate.path-chat', 'review.help']) }),
  check: Object.freeze({ entryId: 'oral-exam', usageKeys: Object.freeze(['nav.exam']) }),
  project: Object.freeze({ entryId: 'page-notes', usageKeys: Object.freeze(['nav.notes']) }),
});

// Sanity-keep every referenced usage key anchored to lib/usage-registry.js.
export const METHOD_USAGE_KEYS = Object.freeze(
  Object.fromEntries(Object.entries(ACTIVITY_SPECS).map(([activity, spec]) => [activity, spec.usageKeys.filter(key => Object.hasOwn(USAGE_REGISTRY_BY_KEY, key))])),
);

const storageKey = root => `${METHOD_ALT_USED_PREFIX}${root || ''}`;

const storedUsedSet = (root, storage = browserStorage()) => {
  const list = readJSON(storageKey(root), [], storage);
  return new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string') : []);
};

/** Record that the learner clicked an 「也可以」 feature in this library so future round-end surfaces stay quiet and the card demotes it. */
export function markAlternativeUsed(root, course, activity, storage = browserStorage()) {
  if (!ACTIVITIES.includes(activity)) return false;
  const set = storedUsedSet(root, storage);
  set.add(activity);
  if (course) set.add(`${course}::${activity}`);
  return writeJSON(storageKey(root), [...set], storage);
}

/** Does a guided-session `courseId` (stored as an entity id like `course-xxx`, course name, or alias) belong to `courseName`? */
export function matchesCourseSession(data, courseName, sessionCourseId) {
  if (!courseName) return true;
  if (typeof sessionCourseId !== 'string' || !sessionCourseId.trim()) return false;
  const within = courseMatcher(data, courseName);
  if (within(sessionCourseId)) return true;
  return (data?.courses || []).some(item => item && (
    (item.name === courseName || within(item.name || '')) && (item.id === sessionCourseId || (item.aliases || []).includes(sessionCourseId))
  ));
}

/** Counts of materials, published cards, answered cards and right cards for `course` from the UI snapshot (preferring focus.method.counts when exact). */
export function courseCounts(data, course) {
  if (course && data?.focus?.method?.course === course && data.focus.method.counts) return data.focus.method.counts;
  const name = typeof course === 'string' ? course.trim() : '';
  const record = name ? (data?.courses || []).find(item => item?.name === name) : null;
  const hasSources = Array.isArray(data?.sources), hasDecks = Array.isArray(data?.decks);
  const within = name ? courseMatcher(data, name) : () => true;
  const materials = hasSources
    ? data.sources.filter(source => isVerifiableMaterialSource(source)

      && (Array.isArray(source.courses) ? source.courses.some(within) : within(source.course ?? ''))).length
    : (record?.sourcesTotal ?? record?.sources ?? 0);
  let cards = 0, answered = 0, right = 0;
  if (hasDecks) {
    const attempts = Array.isArray(data?.attempts) ? data.attempts : null;
    const latest = new Map();
    if (attempts) for (const item of attempts) if (item?.deckId && (item.quiz_id || item.cardId)) latest.set(`${item.deckId}:${item.quiz_id || item.cardId}`, item.grade);
    for (const deck of decksInCourse(data, name || '*', true)) {
      if (deck.sample) continue;
      if (Array.isArray(deck.cards)) {
        for (const card of deck.cards) {
          if (card?.suspended) continue;
          cards += 1;
          const grade = latest.get(`${deck.id}:${card.id}`);
          if (grade !== undefined) answered += 1;
          if (Number.isFinite(grade) && grade >= 3) right += 1;
        }
      } else {
        const count = Number.isFinite(deck.available) ? deck.available : (deck.count ?? 0);
        cards += count;
        const deckProgress = data?.progress?.[deck.id];
        const learned = deckProgress?.learned ?? deckProgress?.counts?.learned ?? 0;
        answered += learned;
        right += Math.max(0, learned - (deck.wrong ?? 0));
      }
    }
  } else if ((record?.decksTotal ?? record?.decks ?? 0) > 0) {
    cards = record.decksTotal ?? record.decks;
  }
  return { materials, cards, answered, right };
}

function usageRecorded(usage, activity, keys) {
  if (!usage) return false;
  const names = [activity, ...keys];
  if (Array.isArray(usage)) return names.some(name => usage.includes(name));
  if (Array.isArray(usage.records)) return usage.records.some(cell => names.includes(cell?.key) && (cell?.n ?? 1) > 0);
  const map = usage.counts && typeof usage.counts === 'object' ? usage.counts : usage;
  return typeof map === 'object' && names.some(name => Number(map[name]) > 0);
}

/** Has the learner already used `activity` (from usage records, library/course history, or a prior 「也可以」 click)? */
export function isAlternativeUsed(data, course, activity, counts = courseCounts(data, course), storage = browserStorage(), options = {}) {
  const keys = METHOD_USAGE_KEYS[activity] || [];
  if (usageRecorded(data?.usage, activity, keys)) return true;
  const stored = storedUsedSet(data?.root, storage);
  if (stored.has(activity) || (course && stored.has(`${course}::${activity}`))) return true;
  switch (activity) {
    case 'publish': return counts.materials > 0;
    case 'practice': return counts.answered > 0;
    case 'review': return (data?.runs || []).some(run => run?.mode === 'wrong' || run?.purpose === 'wrongbook');
    case 'explain': {
      const activeSession = options.guidedSession ?? data?.activeStudySession;
      if (activeSession && activeSession.status !== 'ended' && matchesCourseSession(data, course, activeSession.courseId)) return true;
      return (data?.guidedSessions || []).some(session => matchesCourseSession(data, course, session?.courseId));
    }
    case 'check': return (data?.oralExams?.length || 0) > 0 || (data?.oralRuns?.length || 0) > 0;
    case 'project': {
      const within = course ? courseMatcher(data, course) : () => true;
      return (data?.notes || []).some(note => !note?.sample && (
        !course ? true : Array.isArray(note?.courses) ? note.courses.some(within) : Boolean(note?.course && within(note.course))
      ));
    }
    default: return false;
  }
}

function prerequisiteBlock(activity, counts) {
  if (activity === 'publish') return '';
  if (activity === 'explain') return counts.materials === 0 ? ui('导入讲义后可用') : '';
  if (activity === 'practice') return counts.materials === 0 && counts.cards === 0 ? ui('导入讲义后可用') : '';
  if (counts.materials === 0 && counts.cards === 0) return ui('导入讲义后可用');
  return counts.cards === 0 ? ui('发布题组后可用') : '';
}

/** Resolve the current stage `{ index, total, stage, counts, own }` of `course` from the UI snapshot. */
export function currentMethodStage(data, course) {
  const name = typeof course === 'string' ? course.trim() : course?.name || '';
  if (!name) return null;
  const record = typeof course === 'object' && course ? course : (data?.courses || []).find(item => item?.name === name) || null;
  const method = courseMethod(record);
  const counts = courseCounts(data, name);
  if (data?.focus?.method?.course === name && Number.isInteger(data.focus.method.index) && data.focus.method.total === method.stages.length) {
    const index = data.focus.method.index;
    return { index, total: method.stages.length, stage: method.stages[index], counts, own: !!record?.method };
  }
  if (record?.method && Number.isInteger(record.method.stageIndex)) {
    const clamped = Math.max(0, Math.min(record.method.stageIndex, method.stages.length - 1));
    return { index: clamped, total: method.stages.length, stage: method.stages[clamped], counts, own: true };
  }
  let index = 0;
  while (index < method.stages.length - 1) {
    const stage = method.stages[index];
    const done = stage.activity === 'publish' ? counts.materials > 0
      : stage.activity === 'practice' ? (() => {
        const rule = gateRule(stage.level);
        return counts.cards > 0 && (rule.counts === 'answered' ? counts.answered : counts.right) >= atLeast(rule.advance, counts.cards);
      })()
      : false;
    if (!done) break;
    index += 1;
  }
  return { index, total: method.stages.length, stage: method.stages[index], counts, own: !!record?.method };
}

/** Resolve the course name a finished review round belongs to (course run, daily course run, single-course deck run, or focused class course). */
export function resolveRoundCourse(data, run) {
  if (!run) return '';
  if (typeof run.course?.name === 'string' && run.course.name) return run.course.name;
  if (typeof run.dailyCourse === 'string' && run.dailyCourse) return run.dailyCourse;
  const deckIds = [run.deckId, ...(run.scope || []).map(item => item?.deckId)].filter(Boolean);
  const courses = new Set(
    deckIds.map(id => data?.decks?.find(deck => deck.id === id)).filter(deck => deck && !deck.systemKind && deck.course).map(deck => deck.course),
  );
  if (courses.size === 1) return [...courses][0];
  return data?.focus?.course || '';
}

/**
 * Evaluate `stage.alternatives` against host capabilities, model readiness, course prerequisites, and usage history.
 * Returns up to 2 items: `{ activity, entryId, page, title, detail, blocked, used, needsModel, practiceReady }`.
 */
export function stageAlternatives(data, course, stage, options = {}) {
  if (!data || !stage || !Array.isArray(stage.alternatives) || !stage.alternatives.length) return [];
  const name = typeof course === 'string' ? course.trim() : course?.name || '';
  const counts = options.counts || courseCounts(data, name);
  const modelReady = modelReadiness(data).ready;
  const seen = new Set(), items = [];
  for (const activity of stage.alternatives) {
    if (items.length >= ALTERNATIVES_MAX) break;
    if (!ACTIVITIES.includes(activity) || activity === stage.activity || seen.has(activity)) continue;
    seen.add(activity);
    const spec = ACTIVITY_SPECS[activity];
    const practiceReady = activity === 'practice' && counts.cards > 0;
    const entry = ENTRY_BY_ID.get(practiceReady ? spec.readyEntryId : spec.entryId);
    if (!entry || finderAvailability(entry, data)) continue;
    const needsModel = Boolean(entry.needs?.model || (activity === 'practice' && !practiceReady));
    if (needsModel && !modelReady) continue;
    const blocked = prerequisiteBlock(activity, counts);
    const used = !blocked && isAlternativeUsed(data, name, activity, counts, options.storage, options);
    const title = practiceReady ? ui('按批练习') : ui(entry.title);
    items.push({ activity, entryId: entry.id, page: entry.page, title, detail: ui(entry.what), blocked, used, needsModel, practiceReady });
  }
  return items;
}

/**
 * At round end (Review summary or TodayCard when today's round is done): at most ONE available, unused 「也可以」 item for `course`, or `null`.
 */
export function roundEndAlternative(data, course, options = {}) {
  const current = currentMethodStage(data, course);
  if (!current?.stage) return null;
  const items = stageAlternatives(data, course, current.stage, { ...options, counts: current.counts });
  const found = items.find(item => !item.blocked && !item.used);
  if (!found) return null;
  const courseName = typeof course === 'string' ? course.trim() : course?.name || '';
  const activeSession = options.guidedSession ?? data?.activeStudySession;
  return {
    ...found,
    root: data?.root || '',
    course: courseName,
    stage: current.stage,
    hasActiveGuided: Boolean(activeSession && activeSession.status !== 'ended' && matchesCourseSession(data, courseName, activeSession.courseId)),
  };
}

/**
 * Navigate directly to an available 「也可以」 item, carrying the course and current stage scope.
 */
export function openAlternative(item, { data, course, stage, guidedSession, navigate, act, enterRun, handOff, sendHandOff, appSet, onClose, storage, scopeStorage = browserSession() } = {}) {
  if (!item || item.blocked) return false;
  const root = data?.root || item.root || '';
  const courseName = (typeof course === 'string' ? course : course?.name || item.course || '').trim();
  const stageObj = stage || item.stage || null;
  markAlternativeUsed(root, courseName, item.activity, storage);
  onClose?.('method-alternative');
  switch (item.activity) {
    case 'publish':
      if (courseName) writePageScope(root, 'sources', courseName, scopeStorage);
      navigate?.('sources');
      return true;
    case 'practice':
      if (item.practiceReady) {
        if (act && enterRun && courseName) {
          void act('review.start', { mode: 'course', course: courseName, fresh: false }, enterRun);
          return true;
        }
        if (act && courseName && data?.focus?.course !== courseName) void act('focus.set', { course: courseName });
        navigate?.('library');
        return true;
      }
      if (courseName) writePageScope(root, 'generate-sources', courseName, scopeStorage);
      navigate?.('generate');
      return true;
    case 'review':
      if (courseName) writePageScope(root, 'wrongbook', courseName, scopeStorage);
      navigate?.('wrongbook');
      return true;
    case 'explain': {
      const activeSession = guidedSession ?? data?.activeStudySession;
      const hasActive = Boolean(item.hasActiveGuided || (activeSession && activeSession.status !== 'ended' && matchesCourseSession(data, courseName, activeSession.courseId)));
      navigate?.('guided');
      if (!hasActive) {
        if (handOff) void handOff.send('method.explain', { course: courseName, stage: stageObj?.name || '' });
        else if (sendHandOff) void sendHandOff('method.explain', { course: courseName, stage: stageObj?.name || '' });
      }
      return true;
    }
    case 'check':
      if (courseName) writePageScope(root, 'exam', courseName, scopeStorage);
      writePageScope(root, 'exam-decks', '', scopeStorage);
      writePageScope(root, 'exam-format', 'oral', scopeStorage);
      appSet?.setExamRunId?.(null);
      appSet?.setExamKind?.('oral');
      navigate?.('exam');
      return true;
    case 'project':
      if (courseName) writePageScope(root, 'notes', courseName, scopeStorage);
      writePageScope(root, 'notes-open', '', scopeStorage);
      appSet?.setNoteInitialId?.('');
      navigate?.('notes');
      return true;
    default:
      if (item.page) navigate?.(item.page);
      return true;
  }
}

export function isVerifiableMaterialSource(source) {
  if (!source || source.archived || source.historical || source.sample || String(source.id || '').startsWith('sample-') || isLibraryListSource(source)) return false;
  if (typeof source.text === 'string') return source.text.trim().length > 0;
  return Number(source.chars ?? source.length ?? 1) > 0;
}

/**
 * Whether a custom-method stage should display 「还没有资料 · 导入，或请主会话起草」 (#776 S2):
 * untouched default 「课堂跟学」 courses (`!own`) always return false so existing courses see zero extra UI;
 * stages with explicit `sourceIds` check those ids, otherwise an empty custom-method course prompts on its active stage.
 */
export function stageNeedsMaterial(data, course, stage, { own, index = 0, current = -1 } = {}) {
  const isOwn = own ?? Boolean(course?.method);
  if (!isOwn || !data || !course || !stage) return false;
  const sources = Array.isArray(data.sources) ? data.sources : null;
  const scopedSources = stageScope(stage)?.sourceIds || stage.sourceIds; if (Array.isArray(scopedSources) && scopedSources.length > 0) {
    if (!sources) return false;
    const validIds = new Set(sources.filter(isVerifiableMaterialSource).map(source => source.id));
    return !scopedSources.some(id => validIds.has(id));
  }
  const courseName = (typeof course === 'string' ? course : course.name || '').trim();
  const hasMaterial = sources
    ? (() => {
      const within = courseName ? courseMatcher(data, courseName) : () => true;
      return sources.some(source => isVerifiableMaterialSource(source)
        && (Array.isArray(source.courses) ? source.courses.some(within) : within(source.course ?? '')));
    })()
    : (courseCounts(data, courseName).materials || 0) > 0;
  if (hasMaterial) return false;
  const activeIndex = current >= 0 ? current : 0;
  return index === activeIndex;
}

/** Navigate to `资料` (`sources`) pre-scoped to `course` so the learner can import verifiable material for this stage. */
export function openCourseMaterialImport({ data, course, navigate, appSet, onClose, scopeStorage = browserSession() } = {}) {
  const root = data?.root || '';
  const courseName = (typeof course === 'string' ? course : course?.name || '').trim();
  if (courseName) writePageScope(root, 'sources', courseName, scopeStorage);
  appSet?.setPageScopeCourse?.(courseName);
  appSet?.setSourceFocusId?.(null);
  (navigate || appSet?.navigate)?.('sources');
  onClose?.('import-material');
  return true;
}

/** React hook wiring `openAlternative` to `useStudy()`, `useHandOff()` and optional `AppContext` without prop-drilling study services. */
export function useMethodAlternativeOpen({ data, onClose, enterRun } = {}) {
  const { act, navigate } = useStudy();
  const handOff = useHandOff();
  const app = useContext(AppContext);
  return useCallback((item, extra = {}) => openAlternative(item, {
    data: data ?? app?.data,
    guidedSession: app?.lib?.guidedSession,
    navigate,
    act,
    enterRun: enterRun ?? app?.session?.enterRun,
    handOff,
    appSet: app?.set,
    onClose,
    ...extra,
  }), [act, app?.data, app?.lib?.guidedSession, app?.session?.enterRun, app?.set, data, enterRun, handOff, navigate, onClose]);
}
