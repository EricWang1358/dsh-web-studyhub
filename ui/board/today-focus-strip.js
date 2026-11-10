import { ui, uiFormat } from '../i18n.js';
import { formatList, joinMeta } from '../format.js';
import { reasonText, weekText } from '../book/crunch-words.js';
import { normalizeTopic } from '../../lib/recommend-text.js';
import { resolvePracticeSettings } from '../../lib/practice-settings.js';

const pointTitle = (point) => [point?.code, point?.title].filter(Boolean).join(' ').trim();

/** Today's chapter / point chip derived from `course.plan` (`periodPlan` / weekly plan); `null` when no active plan applies. */
export function selectPlanChip(planAnswer) {
  if (!planAnswer || planAnswer.status !== 'ok' || !planAnswer.schedule) return null;
  if ((planAnswer.plan?.status ?? 'active') !== 'active') return null;
  const { schedule } = planAnswer;
  const courseLabel = planAnswer.course === '' ? ui('未分类课程') : String(planAnswer.course || '');
  const byId = new Map((planAnswer.points || []).map((point) => [point.id, point]));
  const day = schedule.today || null;
  const points = (day?.points || []).map((id) => byId.get(id)).filter(Boolean);

  let label = '';
  if (schedule.weekly) {
    if (schedule.weekly.current?.chapters?.length) {
      const weekLabel = weekText(schedule.weekly);
      const first = points[0] ? pointTitle(points[0]) : '';
      const detail = points.length === 1
        ? first
        : points.length > 1
          ? uiFormat('{0}（共 {1} 节）', [first, points.length])
          : '';
      label = joinMeta([weekLabel, detail]);
    } else if (points.length > 0) {
      const first = pointTitle(points[0]);
      label = points.length === 1
        ? uiFormat('今日章节：{0}', [first])
        : uiFormat('今日章节：{0}（共 {1} 节）', [first, points.length]);
    }
  } else if (day) {
    if (points.length === 1) {
      label = uiFormat('今日章节：{0}', [pointTitle(points[0])]);
    } else if (points.length > 1) {
      label = uiFormat('今日章节：{0}（共 {1} 节）', [pointTitle(points[0]), points.length]);
    } else if (day.mode === 'mock') {
      label = ui('今日安排：模拟考');
    } else if (day.mode === 'review') {
      label = ui('今日安排：复习日');
    } else if (day.mode === 'off') {
      label = ui('今日安排：休息');
    }
  }

  if (!label) return null;
  const why = day?.reason ? reasonText(day.reason) : '';
  const tooltip = why
    ? uiFormat('来自「{0}」备考计划：{1}', [courseLabel, why])
    : uiFormat('来自「{0}」备考计划今天的章节安排。', [courseLabel]);
  return { id: 'plan', label, tooltip };
}

/**
 * Weakest topic and its mistake count:
 * 1) Course focus-topic mastery (`lib/focus-progress.js` via `library.focus.progress.topics`) when weak focus topics exist.
 * 2) Active-deck topic mistake distribution (`#748` topic grouping over `library.progress` weak counts) otherwise.
 */
export function pickWeakestTopic(library) {
  const focusTopics = Array.isArray(library?.focus?.progress?.topics) ? library.focus.progress.topics : [];
  const weakFocus = focusTopics
    .map((entry) => ({
      topic: String(entry?.topic || '').trim(),
      weakCount: entry?.weakCards?.length ?? entry?.counts?.weak ?? 0,
      mastery: Number.isFinite(entry?.mastery) ? entry.mastery : 0,
    }))
    .filter((entry) => entry.topic && entry.weakCount > 0)
    .sort((a, b) => a.mastery - b.mastery || b.weakCount - a.weakCount);

  if (weakFocus.length > 0) {
    const best = weakFocus[0];
    return {
      topic: best.topic,
      weakCount: best.weakCount,
      mastery: best.mastery,
      source: 'focus',
    };
  }

  const decks = library?.progress && typeof library.progress === 'object' ? Object.values(library.progress) : [];
  const byTopic = new Map();
  for (const deck of decks) {
    if (!deck || deck.archived || deck.inactive) continue;
    for (const item of deck.topics || []) {
      const weak = Number(item?.counts?.weak) || 0;
      const total = Number(item?.total) || 0;
      const rawName = String(item?.name || '').trim();
      const key = normalizeTopic(rawName === '未分类' ? '' : rawName) || '*';
      if (!byTopic.has(key)) {
        byTopic.set(key, {
          title: !rawName || rawName === '未分类' ? ui('未分类') : rawName,
          weakCount: 0,
          total: 0,
          weightedMastery: 0,
        });
      }
      const group = byTopic.get(key);
      group.weakCount += weak;
      group.total += total;
      group.weightedMastery += (Number(item?.mastery) || 0) * total;
    }
  }

  const weakTopics = [...byTopic.values()]
    .filter((group) => group.weakCount > 0)
    .map((group) => ({
      topic: group.title,
      weakCount: group.weakCount,
      mastery: group.total > 0 ? Math.round(group.weightedMastery / group.total) : 0,
      source: 'wrongbook',
    }))
    .sort((a, b) => b.weakCount - a.weakCount || a.mastery - b.mastery);

  return weakTopics[0] || null;
}

/** Scheduled due review question count across active, non-archived decks (excluding brand-new unseen cards). */
export function countDueReviews(library) {
  if (library?.progress && typeof library.progress === 'object') {
    let sum = 0;
    for (const deck of Object.values(library.progress)) {
      if (!deck || deck.archived || deck.inactive) continue;
      sum += Math.max(0, Number(deck.due) || 0);
    }
    return sum;
  }
  return Math.max(0, Number(library?.today?.due) || 0);
}

/** How many chapters the 会掉 sentence names before 「等 N 章」 (#894). */
export const SLIP_CHAPTERS_SHOWN = 3;

/** A point's chapter: the first part of the number the book gives it ("3.2" -> "3"), as the book and the weekly plan number chapters. */
const chapterOf = (point) => String(point?.number ?? '').split('.')[0];

/**
 * 到考试日会掉 (#894): the chapters with a crunch point that is solid today and, projected with no further review, not on the exam day
 * (`examDay.band` 'slip', lib/exam-day-band.js), and the round of their at-risk questions, lowest projected recall first (`examDay.atRisk[].rank`,
 * lib/course-book-crunch.js), at most `roundSize`. null when no chapter slips (no exam date ahead gives no band at all).
 */
export function selectSlippingRound(planAnswer, roundSize) {
  const slipping = (Array.isArray(planAnswer?.points) ? planAnswer.points : []).filter((point) => point?.examDay?.band === 'slip' && chapterOf(point));
  const seen = new Set();
  const scope = slipping.flatMap((point) => point.examDay.atRisk || [])
    .sort((a, b) => a.rank - b.rank)
    .filter((item) => { const key = `${item.deckId}|${item.cardId}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, roundSize)
    .map(({ deckId, cardId }) => ({ deckId, cardId }));
  if (!scope.length) return null;
  return { chapters: [...new Set(slipping.map(chapterOf))].sort((a, b) => Number(a) - Number(b)), scope };
}

/** The strip's 会掉 sentence and its button (#894), or null. */
function selectSlip(library, planAnswer) {
  const round = selectSlippingRound(planAnswer, resolvePracticeSettings(library?.settings?.practice).roundSize);
  if (!round) return null;
  const { chapters, scope } = round;
  return {
    chapters,
    scope,
    label: chapters.length > SLIP_CHAPTERS_SHOWN
      ? uiFormat('按现在的进度，第 {0} 章等 {1} 章到考试日会掉', [formatList(chapters.slice(0, SLIP_CHAPTERS_SHOWN)), chapters.length])
      : uiFormat('按现在的进度，第 {0} 章到考试日会掉', [formatList(chapters)]),
    tooltip: ui('按不再复习推算：这几章里有考点今天稳，照复习排期的记忆曲线，不再复习的话到考试日会忘到不稳。按钮把其中最容易忘的题排成一轮，最容易忘的先做。'),
    action: uiFormat('练这几章最容易忘的 {0} 道', [scope.length]),
  };
}

/**
 * Pure model for the 「今天的重点」 strip (#857):
 * - Builds up to 3 chips (`plan`, `weak`, `due`) strictly from existing library/plan readouts.
 * - Hides the entire strip (`visible: false`) when all chips are empty, no chapter will slip and no focus minutes are recorded.
 * - `slip` (#894): one sentence naming the chapters that will slip by the exam day, with the round its button starts; null when none will.
 * - Renders `今天计划 N 分钟` before S4 (`focusedMinutes === null`), and `今天计划 N 分钟 / 已专注 M 分钟` once S4 supplies `focusedMinutes`.
 */
export function selectTodayFocusStrip({ library, planAnswer = null, budgetMinutes = null, focusedMinutes = null } = {}) {
  const chips = [];
  const planChip = selectPlanChip(planAnswer);
  if (planChip) chips.push(planChip);

  const weakest = pickWeakestTopic(library);
  if (weakest) {
    chips.push({
      id: 'weak',
      label: uiFormat('薄弱：{0} · {1} 题', [weakest.topic, weakest.weakCount]),
      tooltip: weakest.source === 'focus'
        ? uiFormat('来自课程重点掌握度：掌握度 {0}%，当前有 {1} 道薄弱题。', [weakest.mastery, weakest.weakCount])
        : uiFormat('来自错题本薄弱点分布：掌握度 {0}%，当前有 {1} 道错题待巩固。', [weakest.mastery, weakest.weakCount]),
    });
  }

  const dueCount = countDueReviews(library);
  if (dueCount > 0) {
    chips.push({
      id: 'due',
      label: uiFormat('到期复习 {0} 题', [dueCount]),
      tooltip: ui('来自题库间隔重复排期：已学过且在今天或之前到期的复习题数（不含未学新题）。'),
    });
  }

  const hasFocused = focusedMinutes !== null && focusedMinutes !== undefined && Number.isFinite(Number(focusedMinutes));
  const focused = hasFocused ? Math.max(0, Math.round(Number(focusedMinutes))) : null;
  const slip = selectSlip(library, planAnswer);
  const visible = chips.length > 0 || slip !== null || (focused !== null && focused > 0);
  const helpTooltip = ui('汇总备考计划今日章节、当前最薄弱知识点和到期复习题；计划分钟取自今日行动的时间预算。');

  if (!visible) return { visible: false, chips: [], slip: null, budget: null, helpTooltip };

  const planned = budgetMinutes !== null && budgetMinutes !== undefined && Number.isFinite(Number(budgetMinutes)) && Number(budgetMinutes) > 0
    ? Math.round(Number(budgetMinutes))
    : null;

  const budget = planned !== null
    ? {
      plannedMinutes: planned,
      focusedMinutes: focused,
      value: focused ?? 0,
      max: planned,
      label: focused === null
        ? uiFormat('今天计划 {0} 分钟', [planned])
        : uiFormat('今天计划 {0} 分钟 / 已专注 {1} 分钟', [planned, focused]),
      tooltip: focused === null
        ? ui('计划分钟取自「今日行动」的时间预算。')
        : ui('计划分钟取自「今日行动」的时间预算；已专注分钟来自专注计时记录。'),
    }
    : null;

  return { visible: true, chips, slip, budget, helpTooltip };
}
