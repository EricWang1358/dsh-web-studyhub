/* 期末一周 (docs/plans/review-book.md M7): a day-by-day plan over the points of the review book, from the exam date. Pure, deterministic, no model call,
   browser-safe; dates are calendar days 'YYYY-MM-DD' (no clock is read: `today` is given).

   crunchPlan({ points, papers, examDate, today, daysOff?, minutesPerDay?, reviewDays?, done?, seen? }) -> plan
     points: [{ id, order?, tested?, weakness?, questions?, size?, pitfalls? }] — `tested`: how many of the sample papers tested the point; `weakness` 0–1
       (from its questions' mastery, due and wrong answers); `questions`: how many it has (0: read only); `size`: the characters of its text; `pitfalls`:
       its 易错点 (what the learner once had to ask or have explained, the answer cards' pitfalls). `order` is the reading order (default: the list's).
     papers: how many sample papers the outline rests on. With papers a point weighs 1 + the papers that tested it; without, every point weighs the same
       and the days are balanced by size (the minutes a point takes).
     done / seen: { [id]: 'YYYY-MM-DD' } the day a point was learnt (its next questions practised, or a point without questions read) / looked at on a
       翻看 day (已看). A mark after `today` is not counted; a 已看 before the flip days is not either.
   -> { status: 'ok' | 'no-exam' | 'past' | 'far', examDate, today, daysLeft, weighting: 'papers' | 'size', reviewDays, flipStart, capacity,
        days: [{ date, offset, mode: 'learn' | 'flip' | 'off', mock, points: [id], done: [id], minutes, reason: { code, …numbers } }], today: day | null,
        order: { learn: [id], flip: [id] }, scores: { [id]: { weight, priority, minutes, flipMinutes } }, merged: [{ date, ids, minutes, capacity }], unlearned: [id] }

   The study days run from today to the day before the exam, without the days off. The last `reviewDays` of them (1–3, default 2; all of them when fewer
   remain) are 翻看 days: no new questions, every point once, those with the most 易错点 first, then the weakest; the very last full day also has a mock
   paper. The days before are learn days: read a point and practise its next 5 questions. A point is learnt once. The points not learnt yet go to the
   learn days left, the most important first (weight × (0.5 + weakness)), cut so that each day carries about the same minutes: each day takes what is
   left divided by the days left (a point is taken while its middle fits), so the plan made again tomorrow, after today's points were done, gives the
   same next days. Within a day the points are in reading order. Nothing is dropped: a day over `minutesPerDay` is listed in `merged` (the points that
   had to share it), and with no learn day left the points not learnt are `unlearned` (they are still on the 翻看 days). Past days list what was done
   on them. Exam today: one 翻看 day without a mock. Every day carries a reason the page turns into one line (`reason.code` and its numbers). */

export const CRUNCH = Object.freeze({ minutesPerDay: 180, reviewDays: 2, practise: 5, readChars: 300, questionMinutes: 1.5, maxDays: 366 });

const DAY = 86400000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const time = date => (typeof date === 'string' && DATE.test(date) ? Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) : NaN);
/** A real calendar day written 'YYYY-MM-DD'? */
export const isDate = date => Number.isFinite(time(date)) && new Date(time(date)).toISOString().slice(0, 10) === date;
export const addDays = (date, n) => new Date(time(date) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((time(to) - time(from)) / DAY);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback = 0) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The minutes a point takes on a learn day: reading its text (at least 3, at most 60) and its next questions; on a 翻看 day: a look and its 易错点. */
export const learnMinutes = point => Math.round(clamp(Math.ceil(num(point.size) / CRUNCH.readChars), 3, 60) + Math.min(CRUNCH.practise, num(point.questions)) * CRUNCH.questionMinutes);
export const flipMinutes = point => clamp(Math.round(1 + num(point.pitfalls) + num(point.size) / 1500), 1, 15);

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
const byReading = (a, b) => a.order - b.order || compare(a.id, b.id);
const byPriority = (a, b) => b.priority - a.priority || byReading(a, b);
const byFlip = (a, b) => b.pitfalls - a.pitfalls || b.weakness - a.weakness || b.priority - a.priority || byReading(a, b);
const total = (list, cost) => list.reduce((sum, item) => sum + cost(item), 0);

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

/** The plan (see the top of this file). Throws when `today` is not a date. */
export function crunchPlan({ points, papers = 0, examDate, today, daysOff = [], minutesPerDay = CRUNCH.minutesPerDay, reviewDays = CRUNCH.reviewDays, done = {}, seen = {} } = {}) {
  if (!isDate(today)) throw new Error('crunchPlan: today must be a YYYY-MM-DD day');
  const list = pointsOf(points, num(papers));
  const capacity = Math.round(clamp(num(minutesPerDay, CRUNCH.minutesPerDay), 15, 960));
  const review = clamp(Math.round(num(reviewDays, CRUNCH.reviewDays)), 1, 3);
  const doneOf = done && typeof done === 'object' ? done : {}, seenOf = seen && typeof seen === 'object' ? seen : {};
  const base = { examDate: isDate(examDate) ? examDate : null, today, weighting: num(papers) > 0 ? 'papers' : 'size', reviewDays: review, capacity,
    order: { learn: [...list].sort(byPriority).map(point => point.id), flip: [...list].sort(byFlip).map(point => point.id) },
    scores: Object.fromEntries(list.map(point => [point.id, { weight: point.weight, priority: point.priority, minutes: point.minutes, flipMinutes: point.flipMinutes }])) };
  const empty = { flipStart: null, days: [], today: null, merged: [], unlearned: [] };
  if (!base.examDate) return { status: 'no-exam', daysLeft: null, ...base, ...empty };
  const daysLeft = daysBetween(today, base.examDate);
  if (daysLeft < 0) return { status: 'past', daysLeft, ...base, ...empty };
  if (daysLeft > CRUNCH.maxDays) return { status: 'far', daysLeft, ...base, ...empty };

  const off = new Set((Array.isArray(daysOff) ? daysOff : []).filter(isDate));
  // The first 翻看 day: the `review`-th study day counted back from the day before the exam (so it does not move as the days pass).
  let flipStart = base.examDate;
  for (let date = addDays(base.examDate, -1), found = 0, step = 0; found < review && step < CRUNCH.maxDays; date = addDays(date, -1), step += 1) if (!off.has(date)) { found += 1; flipStart = date; }
  const learnt = id => isDate(doneOf[id]) && doneOf[id] <= today, looked = id => isDate(seenOf[id]) && seenOf[id] >= flipStart && seenOf[id] <= today;
  const ids = items => items.map(point => point.id);
  const day = (date, fields) => ({ date, offset: daysBetween(today, date), mock: false, points: [], done: [], minutes: 0, ...fields });

  // Past days: what was learnt or looked at on them.
  const past = new Map();
  const note = (date, point) => { if (!past.has(date)) past.set(date, []); past.get(date).push(point); };
  for (const point of list) {
    if (learnt(point.id) && doneOf[point.id] < today) note(doneOf[point.id], point);
    if (looked(point.id) && seenOf[point.id] < today && !(learnt(point.id) && doneOf[point.id] === seenOf[point.id])) note(seenOf[point.id], point);
  }
  const days = [...past.keys()].sort().map(date => {
    const items = past.get(date).sort(byReading), mode = date >= flipStart ? 'flip' : 'learn';
    return day(date, { mode, points: ids(items), done: ids(items), minutes: total(items, mode === 'flip' ? point => point.flipMinutes : point => point.minutes), reason: { code: 'done', count: items.length } });
  });

  const future = Array.from({ length: daysLeft }, (_, at) => addDays(today, at));
  const learnDays = future.filter(date => !off.has(date) && date < flipStart), flipDays = future.filter(date => !off.has(date) && date >= flipStart);
  const merged = [];
  const over = (date, items, minutes) => { if (minutes > capacity) merged.push({ date, ids: ids(items), minutes, capacity }); };

  if (daysLeft === 0) {
    // The exam is today: one look at the book, the 易错点 first; no mock paper.
    const items = [...list].sort(byFlip);
    days.push(day(today, { mode: 'flip', points: ids(items), done: ids(items.filter(point => seenOf[point.id] === today)), minutes: total(items, point => point.flipMinutes),
      reason: { code: 'exam-today', count: items.length } }));
  } else {
    const doneToday = list.filter(point => doneOf[point.id] === today), pending = list.filter(point => !learnt(point.id)).sort(byPriority);
    const learnToday = learnDays[0] === today, learnChunks = learnDays.length ? split(pending, learnDays.length, point => point.minutes, learnToday ? total(doneToday, point => point.minutes) : 0) : [];
    const seenToday = today >= flipStart ? list.filter(point => seenOf[point.id] === today) : [], flipPending = list.filter(point => !looked(point.id)).sort(byFlip);
    const flipToday = flipDays[0] === today, flipChunks = flipDays.length ? split(flipPending, flipDays.length, point => point.flipMinutes, flipToday ? total(seenToday, point => point.flipMinutes) : 0) : [];
    const last = flipDays.at(-1);
    for (const date of future) {
      if (off.has(date)) { days.push(day(date, { mode: 'off', reason: { code: 'off' } })); continue; }
      if (date < flipStart) {
        const at = learnDays.indexOf(date), already = at === 0 && learnToday ? doneToday : [];
        const items = [...already, ...learnChunks[at]].sort(byReading), minutes = total(items, point => point.minutes);
        over(date, items, minutes);
        const tested = items.filter(point => point.tested > 0).length, weak = items.filter(point => point.weakness >= 0.5).length;
        const reason = !items.length ? { code: 'learn-free' } : minutes > capacity ? { code: 'learn-over', count: items.length, minutes, capacity }
          : base.weighting === 'papers' ? { code: 'learn', count: items.length, tested, weak, minutes } : { code: 'learn-size', count: items.length, weak, minutes };
        days.push(day(date, { mode: 'learn', points: ids(items), done: ids(already), minutes, reason }));
        continue;
      }
      const at = flipDays.indexOf(date), already = at === 0 && flipToday ? seenToday : [];
      const items = [...already, ...flipChunks[at]].sort(byFlip), minutes = total(items, point => point.flipMinutes), mock = date === last;
      over(date, items, minutes);
      days.push(day(date, { mode: 'flip', mock, points: ids(items), done: ids(already), minutes,
        reason: { code: mock ? 'flip-mock' : 'flip', count: items.length, pitfalls: total(items, point => point.pitfalls) } }));
    }
  }
  const unlearned = learnDays.length ? [] : list.filter(point => !learnt(point.id)).sort(byPriority).map(point => point.id);
  // A point is never lost: it is on one learn day (or learnt, or unlearned) and on one 翻看 day (or already looked at).
  return { status: 'ok', daysLeft, ...base, flipStart, days, today: days.find(item => item.offset === 0) ?? null, merged, unlearned };
}
