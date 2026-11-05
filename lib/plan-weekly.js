import { addDays } from './crunch-plan.js';
import { split } from './plan-split.js';

/* 备考计划 by chapters per week (深度定制 4.4 S3, lib/custom-plan.js `plan: { by: 'weekly', chaptersPerWeek }`): the same plan as lib/plan-schedule.js, with no exam
   date to count back from. The book's chapters are laid out week after week from the plan's start date, `chaptersPerWeek` a week; a week is the seven days from
   its first day (the weeks never move with today), and every study day of a week carries the points of that week's chapters, cut into days of about the same
   minutes. What was not learnt when its week was over is owed: it moves into the first week that still has a study day, never dropped, and the day says how many.
   Pure, no I/O, no model. periodPlan calls these; a plan by the exam date does not touch them.

   chaptersOfBook(nodes, only?)  the chapters of an open book (its top-level nodes) as [{ n (1-based), title, ids: [the point ids under it] }]; a node with no point is no chapter.
     `only`: a Set of node keys, the chapters a 定制方案 chose: just those are returned (numbered as the book numbers them); keys that match none mean every chapter.
   weeksOf(chapters, perWeek, start) -> [{ n, from, until, chapters }]
   weeklyChunks(...)      the learn days of the weeks: { chunkOf(date), carriedOf(date): how many of that day's points are owed from earlier weeks, unplaced: [points] }
   weekLine(week)         { from, to, count }: the chapter numbers of a week, for the line 「本周：第 3–4 章」 (the words are the page's). */

export const WEEK_DAYS = 7;
export const isWeekly = (plan, chapters) => plan?.by === 'weekly' && Array.isArray(chapters) && chapters.length > 0;

const leavesOf = node => (node?.children?.length ? node.children.flatMap(leavesOf) : node?.hid ? [node.hid] : []);

export function chaptersOfBook(nodes, only = null) {
  const all = (Array.isArray(nodes) ? nodes : []).map(node => ({ key: node.key, title: node.title ?? '', ids: leavesOf(node) })).filter(chapter => chapter.ids.length)
    .map(({ key, ...chapter }, at) => ({ key, n: at + 1, ...chapter }));
  // The chapters a 定制方案 chose (the keys of those nodes): only they are laid out, under the numbers the book gives them. Keys that name none of this book's chapters choose nothing.
  const chosen = only?.size ? all.filter(chapter => only.has(chapter.key)) : [];
  return (chosen.length ? chosen : all).map(({ key: _key, ...chapter }) => chapter);
}

export const perWeekOf = value => Math.min(10, Math.max(1, Math.round(Number(value)) || 1));

export function weeksOf(chapters, perWeek, start) {
  const per = perWeekOf(perWeek), weeks = [];
  for (let at = 0; at < chapters.length; at += per) {
    const n = weeks.length + 1;
    weeks.push({ n, from: addDays(start, WEEK_DAYS * (n - 1)), until: addDays(start, WEEK_DAYS * n - 1), chapters: chapters.slice(at, at + per) });
  }
  return weeks;
}

export const weekLine = week => ({ from: week.chapters[0].n, to: week.chapters.at(-1).n, count: week.chapters.length });

export function weeklyChunks({ weeks, pending, studyDates, today, doneToday = 0, cost }) {
  const byId = new Map(pending.map(point => [point.id, point])), chunks = new Map(), carried = new Map();
  let carry = [];
  for (const week of weeks) {
    const own = week.chapters.flatMap(chapter => chapter.ids).map(id => byId.get(id)).filter(Boolean);
    const dates = studyDates.filter(date => date >= week.from && date <= week.until);
    // A week with no study day left (over, or all rest days) hands what it holds to the next one.
    if (!dates.length) { carry = [...carry, ...own]; continue; }
    const owed = new Set(carry.map(point => point.id));
    split([...carry, ...own], dates.length, cost, dates[0] === today ? doneToday : 0).forEach((chunk, at) => {
      chunks.set(dates[at], chunk);
      carried.set(dates[at], chunk.filter(point => owed.has(point.id)).length);
    });
    carry = [];
  }
  const inChapters = new Set(weeks.flatMap(week => week.chapters.flatMap(chapter => chapter.ids)));
  return { chunkOf: date => chunks.get(date) ?? [], carriedOf: date => carried.get(date) ?? 0, unplaced: [...carry, ...pending.filter(point => !inChapters.has(point.id))] };
}

/** What a weekly schedule says besides its days (the `weekly` field of periodPlan): the weeks with their chapters and how much of each is learnt, the week today is in
    (`current`, `thisWeek`; null before the first and after the last, `position` says which: 'before' | 'during' | 'over'), and how many points of the weeks that are over are
    still owed (`behind`). */
export function weeklyView({ weeks, perWeek, today, pendingList, doneOf }) {
  const pendingIds = new Set(pendingList.map(point => point.id)), ids = week => week.chapters.flatMap(chapter => chapter.ids);
  const shown = weeks.map(week => ({ ...week, chapters: week.chapters.map(chapter => ({ n: chapter.n, title: chapter.title, points: chapter.ids.length,
    learnt: chapter.ids.filter(id => doneOf(id)).length })) }));
  const current = shown.find(week => week.from <= today && today <= week.until) ?? null;
  return { chaptersPerWeek: perWeekOf(perWeek), weeks: shown, thisWeek: current?.n ?? null, current, position: current ? 'during' : today < weeks[0].from ? 'before' : 'over',
    startsOn: weeks[0].from, endsOn: weeks.at(-1).until,
    behind: weeks.filter(week => week.until < today).flatMap(ids).filter(id => pendingIds.has(id)).length };
}
