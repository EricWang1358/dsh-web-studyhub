/* Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
   备考计划 (docs/review-book.md): one course's whole-period study plan. The strategy is stored on the course record
   (`plan`, lib/courses.js checkedPlan); this planner expands it deterministically over the review book's points — the same
   inputs 期末一周 weighs (lib/crunch-plan.js). No I/O, no model call, no clock (`today` is given). The plan is a proposal,
   never evidence: `done`/`seen` come from real review results (the maps 期末一周 uses), and the schedule made again tomorrow
   re-places what is still open, so falling behind re-prioritizes by itself.

   periodPlan({ points, plan, papers?, examDate, today, done?, seen?, days? }) -> schedule
     points: the crunchPoints shape [{ id, order?, tested?, weakness?, questions?, size?, pitfalls? }] in reading order.
     plan: the checkedPlan shape { startDate?, minutesPerDay?, studyWeekdays?, restDates?, mockDates?, reviewCycleDays?, phases? }.
     papers: how many sample papers the outline rests on (a tested point weighs more), as in crunchPlan.
     done / seen: { [id]: 'YYYY-MM-DD' } the day a point was learnt / looked at (a mark after `today` is not counted).
     days: how many of today's and later days the answer lists (default 14); the whole horizon is computed regardless.
   -> { status: 'ok' | 'no-exam' | 'past', examDate, today, daysLeft, start, capacity, reviewCycleDays, weighting,
        phases: [{ name, from, until, goal? }],
        days: [{ date, offset, phase, mode: 'learn' | 'review' | 'mock' | 'off', mock, points: [id], done: [id], minutes, reason }],
        today: day | null, order: { learn: [id], review: [id] }, scores: { [id]: { weight, priority, minutes, flipMinutes } },
        coverage: { total, scheduled, unplaced }, progress: { learnt, total, elapsedDays, totalDays }, unlearned: [id], merged, truncated? }

   Days run from `start` (the plan's startDate, today at the earliest) to the exam day. The exam day reviews the whole book,
   易错点 first; a mockDates day is a mock (the paper itself is book.mock's job); a restDates day or a weekday outside
   `studyWeekdays` is off; every `reviewCycleDays`-th study day reviews what has been learnt (the weakest, most 易错点 first;
   nothing learnt yet, it takes the single most important pending point so the day is not wasted). The other days learn: the
   pending points, most important first (weight × (0.5 + weakness)), cut so the learn days carry about the same minutes (a
   point is taken while its middle fits). Nothing is dropped: a learn day over capacity is flagged (`learn-over`) and listed
   in `merged`; with no learn day left the pending points are `unplaced` (they still appear on the review days). Past days
   list what was really done on them (bounded to the last `pastDays`). Every day carries a reason the page turns into one
   line (`reason.code` and its numbers). */

import { isDate, addDays, daysBetween, learnMinutes, flipMinutes } from './crunch-plan.js';

export const PLAN_SCHEDULE = Object.freeze({ minutesPerDay: 180, futureDays: 14, pastDays: 60, maxDays: 731 });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback = 0) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const total = (list, cost) => list.reduce((sum, item) => sum + cost(item), 0);
const ids = items => items.map(point => point.id);
/** 0 = Sunday … 6 = Saturday, from a 'YYYY-MM-DD' day. */
const weekdayOf = date => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
const byReading = (a, b) => a.order - b.order || compare(a.id, b.id);
const byPriority = (a, b) => b.priority - a.priority || byReading(a, b);
const byFlip = (a, b) => b.pitfalls - a.pitfalls || b.weakness - a.weakness || b.priority - a.priority || byReading(a, b);

function pointsOf(points, papers) {
  const seen = new Set(), out = [];
  (Array.isArray(points) ? points : []).forEach((point, at) => {
    if (!point || typeof point.id !== 'string' || !point.id || seen.has(point.id)) return;
    seen.add(point.id);
    const item = { id: point.id, order: Number.isFinite(point.order) ? point.order : at, tested: Math.max(0, Math.floor(num(point.tested))),
      weakness: clamp(num(point.weakness, 0.6), 0, 1), questions: Math.max(0, Math.floor(num(point.questions))), size: Math.max(0, num(point.size)),
      pitfalls: Math.max(0, Math.floor(num(point.pitfalls))) };
    item.weight = papers > 0 ? 1 + item.tested : 1;
    item.priority = Math.round(item.weight * (0.5 + item.weakness) * 10000) / 10000;
    item.minutes = learnMinutes(item);
    item.flipMinutes = flipMinutes(item);
    out.push(item);
  });
  return out;
}

/** `list` (in the order to take it) cut into `count` days of about the same cost; `preload`: what the first day already carries (done today). */
function split(list, count, cost, preload = 0) {
  const out = [], rest = [...list];
  for (let k = 0; k < count; k += 1) {
    const left = count - k;
    if (left === 1) { out.push(rest.splice(0)); break; }
    let load = k === 0 ? preload : 0;
    const target = (total(rest, cost) + load) / left, chunk = [];
    // A day with nothing on it yet always takes the next point; otherwise a point is taken while its middle fits under the day's share.
    while (rest.length && ((!chunk.length && load === 0) || load + cost(rest[0]) / 2 <= target)) { load += cost(rest[0]); chunk.push(rest.shift()); }
    out.push(chunk);
  }
  return out;
}

/** The plan's phases resolved over [start, examDate]: each runs from the day after the previous one to its `until`
    (clamped into the horizon; the last one runs to the exam). A day belongs to the last phase that has started. */
function phasesOf(plan, start, examDate) {
  const list = (Array.isArray(plan.phases) ? plan.phases : []).filter(phase => phase && typeof phase.name === 'string' && phase.name.trim());
  if (!list.length) return [{ name: '备考', from: start, until: examDate }];
  const out = [];
  let from = start;
  for (const phase of list) {
    if (from > examDate) break;
    const raw = isDate(phase.until) ? phase.until : examDate;
    const until = raw > examDate ? examDate : (raw < from ? from : raw);
    out.push({ name: phase.name.trim(), from, until, ...(typeof phase.goal === 'string' && phase.goal.trim() ? { goal: phase.goal.trim() } : {}) });
    from = addDays(until, 1);
  }
  return out;
}

const phaseOf = (phases, date) => { let name = null; for (const phase of phases) { if (phase.from <= date) name = phase.name; else break; } return name; };

/** The plan (see the top of this file). Throws when `today` is not a date. */
export function periodPlan({ points, plan, papers = 0, examDate, today, done = {}, seen = {}, days = PLAN_SCHEDULE.futureDays } = {}) {
  if (!isDate(today)) throw new Error('periodPlan: today must be a YYYY-MM-DD day');
  const list = pointsOf(points, num(papers));
  const doneMap = done && typeof done === 'object' ? done : {}, seenMap = seen && typeof seen === 'object' ? seen : {};
  const doneOf = id => { const date = doneMap[id]; return isDate(date) && date <= today ? date : null; };
  const seenOf = id => { const date = seenMap[id]; return isDate(date) && date <= today ? date : null; };
  const learntList = list.filter(point => doneOf(point.id)), pendingList = list.filter(point => !doneOf(point.id));
  const capacity = Math.round(clamp(num(plan?.minutesPerDay, PLAN_SCHEDULE.minutesPerDay), 15, 960));
  const reviewCycle = Math.round(clamp(num(plan?.reviewCycleDays, 0), 0, 30));
  const base = {
    examDate: isDate(examDate) ? examDate : null, today, capacity, reviewCycleDays: reviewCycle,
    weighting: num(papers) > 0 ? 'papers' : 'size',
    order: { learn: [...pendingList].sort(byPriority).map(point => point.id), review: [...learntList].sort(byFlip).map(point => point.id) },
    scores: Object.fromEntries(list.map(point => [point.id, { weight: point.weight, priority: point.priority, minutes: point.minutes, flipMinutes: point.flipMinutes }])),
  };
  const empty = { start: null, phases: [], days: [], today: null, merged: [], unlearned: [],
    coverage: { total: list.length, scheduled: learntList.length, unplaced: [] },
    progress: { learnt: learntList.length, total: list.length, elapsedDays: 0, totalDays: 0 } };
  if (!base.examDate) return { status: 'no-exam', daysLeft: null, ...base, ...empty };
  const daysLeft = daysBetween(today, base.examDate);
  if (daysLeft < 0) return { status: 'past', daysLeft, ...base, ...empty };

  const start = isDate(plan?.startDate) && plan.startDate > today ? plan.startDate : today;
  if (start > base.examDate) return { status: 'past', daysLeft, ...base, ...empty };
  const resolved = phasesOf(plan || {}, start, base.examDate);
  const rest = new Set((Array.isArray(plan?.restDates) ? plan.restDates : []).filter(isDate));
  const mocks = new Set((Array.isArray(plan?.mockDates) ? plan.mockDates : []).filter(isDate));
  const studyWeekdays = Array.isArray(plan?.studyWeekdays) && plan.studyWeekdays.length ? new Set(plan.studyWeekdays) : null;

  const horizon = [];
  for (let date = start, step = 0; date <= base.examDate && step <= PLAN_SCHEDULE.maxDays; date = addDays(date, 1), step += 1) horizon.push(date);
  const isRest = date => rest.has(date) || (studyWeekdays && !studyWeekdays.has(weekdayOf(date)));
  const studyDates = horizon.filter(date => date !== base.examDate && !mocks.has(date) && !isRest(date));
  // A review day every `reviewCycleDays` study days (the exam day reviews anyway, a mock day is its own thing).
  const reviewDates = new Set();
  if (reviewCycle >= 2) { let count = 0; for (const date of studyDates) { count += 1; if (count % reviewCycle === 0) reviewDates.add(date); } }
  const learnDates = studyDates.filter(date => !reviewDates.has(date));

  // Review days before anything was learnt each take the next most important pending point, out of the learn split.
  const pulledByDate = new Map();
  if (reviewDates.size && !learntList.length) {
    const pending = [...pendingList].sort(byPriority), dates = [...reviewDates].sort();
    for (let at = 0; at < dates.length && at < pending.length; at += 1) pulledByDate.set(dates[at], pending[at]);
  }
  const pulledIds = new Set([...pulledByDate.values()].map(point => point.id));
  const doneToday = learntList.filter(point => doneOf(point.id) === today);
  const chunks = learnDates.length ? split([...pendingList].filter(point => !pulledIds.has(point.id)).sort(byPriority), learnDates.length, point => point.minutes,
    learnDates[0] === today ? total(doneToday, point => point.minutes) : 0) : [];
  const learnChunkOf = date => { const at = learnDates.indexOf(date); return at < 0 ? [] : chunks[at]; };

  // Past days: what was really done or looked at on them, the most recent `pastDays` kept.
  const past = new Map();
  const note = (date, point) => { if (!past.has(date)) past.set(date, []); past.get(date).push(point); };
  for (const point of list) {
    if (doneOf(point.id) && doneOf(point.id) < today) note(doneOf(point.id), point);
    if (seenOf(point.id) && seenOf(point.id) < today && seenOf(point.id) !== doneOf(point.id)) note(seenOf(point.id), point);
  }
  const pastDates = [...past.keys()].sort();
  const pastFloor = pastDates.length > PLAN_SCHEDULE.pastDays ? pastDates[pastDates.length - PLAN_SCHEDULE.pastDays] : null;

  const day = (date, fields) => ({ date, offset: daysBetween(today, date), phase: phaseOf(resolved, date), mock: false, points: [], done: [], minutes: 0, ...fields });
  const daysOut = [];
  for (const date of pastDates) {
    if (pastFloor && date < pastFloor) continue;
    const items = past.get(date).sort(byReading), doneItems = items.filter(point => doneOf(point.id) === date);
    daysOut.push(day(date, { mode: doneItems.length ? 'learn' : 'review', points: ids(items), done: ids(doneItems),
      minutes: total(items, point => (doneOf(point.id) === date ? point.minutes : point.flipMinutes)), reason: { code: doneItems.length ? 'done' : 'looked', count: items.length } }));
  }

  const merged = [];
  const over = (date, items, minutes) => { if (minutes > capacity) merged.push({ date, ids: ids(items), minutes, capacity }); };
  const futureDays = [];
  for (const date of horizon) {
    if (date === base.examDate) {
      // The exam day: the whole book one last time, the 易错点 first.
      const items = [...list].sort(byFlip), doneItems = items.filter(point => seenOf(point.id) === date);
      futureDays.push(day(date, { mode: 'review', points: ids(items), done: ids(doneItems), minutes: total(items, point => point.flipMinutes),
        reason: { code: daysLeft === 0 ? 'exam-today' : 'exam-day', count: items.length } }));
      continue;
    }
    if (mocks.has(date)) { futureDays.push(day(date, { mode: 'mock', reason: { code: 'mock' } })); continue; }
    if (isRest(date)) {
      // A rest day that is today still lists what was done on it.
      const items = date === today ? [...new Set([...doneToday, ...learntList.filter(point => seenOf(point.id) === date)])].sort(byReading) : [];
      futureDays.push(day(date, { mode: 'off', points: ids(items), done: ids(items.filter(point => doneOf(point.id) === date)),
        minutes: total(items, point => point.minutes), reason: { code: rest.has(date) ? 'rest' : 'weekday' } }));
      continue;
    }
    if (reviewDates.has(date)) {
      // What has been learnt, the weakest and most 易错点 first; nothing learnt yet, the one pulled pending point.
      const items = learntList.length
        ? (() => { const pick = []; let load = 0; for (const point of [...learntList].filter(point => seenOf(point.id) !== date).sort(byFlip)) { if (pick.length && load + point.flipMinutes / 2 > capacity) break; load += point.flipMinutes; pick.push(point); } return pick; })()
        : (pulledByDate.has(date) ? [pulledByDate.get(date)] : []);
      const doneItems = items.filter(point => doneOf(point.id) === date), fill = !learntList.length;
      futureDays.push(day(date, { mode: 'review', points: ids(items), done: ids(doneItems),
        minutes: total(items, point => (fill ? point.minutes : point.flipMinutes)),
        reason: fill ? { code: 'review-learn', count: items.length } : { code: 'review', count: items.length, weak: items.filter(point => point.weakness >= 0.5).length } }));
      continue;
    }
    const already = date === today ? doneToday : [], items = [...already, ...learnChunkOf(date)].sort(byReading), minutes = total(items, point => point.minutes);
    over(date, items, minutes);
    const tested = items.filter(point => point.tested > 0).length, weak = items.filter(point => point.weakness >= 0.5).length;
    const reason = !items.length ? { code: 'learn-free' } : minutes > capacity ? { code: 'learn-over', count: items.length, minutes, capacity }
      : base.weighting === 'papers' ? { code: 'learn', count: items.length, tested, weak, minutes } : { code: 'learn-size', count: items.length, weak, minutes };
    futureDays.push(day(date, { mode: 'learn', points: ids(items), done: ids(already), minutes, reason }));
  }

  // Today and the next `days - 1` days are listed; the horizon itself was always computed whole.
  const limit = Math.max(1, Math.min(400, Math.floor(num(days, PLAN_SCHEDULE.futureDays))));
  const shown = futureDays.slice(0, limit);
  for (const entry of shown) daysOut.push(entry);
  const unlearned = learnDates.length ? [] : [...pendingList].sort(byPriority).map(point => point.id);
  return {
    status: 'ok', daysLeft, ...base, start, phases: resolved, days: daysOut,
    today: futureDays.find(entry => entry.offset === 0) ?? null,
    coverage: { total: list.length, scheduled: list.length - unlearned.length, unplaced: unlearned },
    progress: { learnt: learntList.length, total: list.length, elapsedDays: daysBetween(start, today) + 1, totalDays: daysBetween(start, base.examDate) + 1 },
    unlearned, merged,
    ...(futureDays.length > limit ? { truncated: true } : {}),
  };
}
