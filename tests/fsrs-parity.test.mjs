/* lib/sm2.js against ts-fsrs 5.4.2 itself (a devDependency only, never shipped): many random review histories, each
   answer scheduled by both, compared on stability, difficulty, interval and due date. ts-fsrs runs as this library
   uses FSRS: long-term mode (no minute-level learning steps), no fuzz. Two intended differences:
   - our maximum interval is a hard cap, where ts-fsrs may push Good / Easy a day or two past it to keep them above Hard;
   - we count days on the learner's local calendar, ts-fsrs on UTC's. So ts-fsrs is fed every instant shifted by the local
     UTC offset at that instant (its UTC date is then our local date), and the rest must match exactly. Run under several
     time zones, one with daylight saving time. */
import test from "node:test";
import assert from "node:assert/strict";
import { fsrs, generatorParameters, createEmptyCard, Rating, State, forgetting_curve } from "ts-fsrs";
import { schedule, initialReview, ratingOfGrade, nextIntervals, retrievability, FSRS6_WEIGHTS } from "../lib/sm2.js";

const DAY = 864e5;
const ZONES = ["Asia/Shanghai", "America/New_York", "UTC"];
/** The instant whose UTC calendar date is `ms`'s local calendar date: what ts-fsrs is given. */
const shifted = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60e3);
const TS_RATING = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy };

/** A small seeded generator, so a failure names a history that can be replayed. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run one history through both; returns the largest differences seen. */
function replay(seed) {
  const r = random(seed);
  const retention = Math.round((0.7 + r() * 0.27) * 100) / 100;
  const maximum = [36500, 36500, 365, 180, 60, 30][Math.floor(r() * 6)];
  const settings = { request_retention: retention, maximum_interval: maximum };
  const f = fsrs(generatorParameters({ request_retention: retention, maximum_interval: maximum, enable_fuzz: false, enable_short_term: false }));
  let now = Date.parse("2026-01-01T00:00:00.000Z") + Math.floor(r() * DAY);
  let card = createEmptyCard(shifted(now)), review = initialReview();
  const worst = { stability: 0, difficulty: 0, interval: 0, due: 0, capped: 0, answers: 0 };
  const steps = 5 + Math.floor(r() * 25);
  for (let step = 0; step < steps; step++) {
    const grade = [0, 1, 2, 3, 4, 4, 4, 4, 5, 5][Math.floor(r() * 10)];
    const at = new Date(now);
    const theirs = f.next(card, shifted(now), TS_RATING[ratingOfGrade(grade)]).card;
    const buttons = nextIntervals(review, at.toISOString(), settings);
    const ours = schedule(review, grade, at.toISOString(), settings);
    const where = `seed ${seed}, answer ${step + 1}, grade ${grade}, retention ${retention}, maximum ${maximum}`;
    worst.stability = Math.max(worst.stability, Math.abs(ours.stability - theirs.stability) / theirs.stability);
    worst.difficulty = Math.max(worst.difficulty, Math.abs(ours.difficulty - theirs.difficulty));
    const expected = Math.min(theirs.scheduled_days, maximum);
    if (expected !== theirs.scheduled_days) worst.capped++;
    worst.interval = Math.max(worst.interval, Math.abs(ours.interval_days - expected));
    worst.due = Math.max(worst.due, Math.abs(Date.parse(ours.due_at) - (now + expected * DAY)));
    assert.equal(ours.interval_days, expected, where);
    assert.equal(buttons[grade], ours.interval_days, `${where}: the button says what the answer does`);
    assert.equal(ours.lapses, theirs.lapses, where);
    assert.equal(ours.reps, theirs.reps, where);
    worst.answers++;
    card = theirs;
    review = ours;
    // Next answer: on time, early, late, the same day or much later, at any hour.
    const shape = r();
    const gapDays = shape < 0.15 ? 0 : shape < 0.4 ? Math.floor(r() * ours.interval_days)
      : shape < 0.8 ? ours.interval_days : ours.interval_days + Math.floor(r() * (ours.interval_days * 2 + 3));
    now += gapDays * DAY + Math.floor((r() - 0.5) * 8 * 3600e3);
    if (now <= Date.parse(ours.last_review)) now = Date.parse(ours.last_review) + 60e3;
  }
  return worst;
}

for (const zone of ZONES) test(`FSRS-6 matches ts-fsrs 5.4.2 over 800 random review histories, local days in ${zone}`, () => {
  process.env.TZ = zone;
  const total = { stability: 0, difficulty: 0, interval: 0, due: 0, capped: 0, answers: 0 };
  for (let seed = 1; seed <= 800; seed++) {
    const worst = replay(seed);
    for (const key of ["stability", "difficulty", "interval", "due"]) total[key] = Math.max(total[key], worst[key]);
    total.capped += worst.capped;
    total.answers += worst.answers;
  }
  assert.ok(total.answers > 10000, `${total.answers} answers`);
  assert.ok(total.stability < 1e-9, `relative stability difference ${total.stability}`);
  assert.ok(total.difficulty < 1e-9, `difficulty difference ${total.difficulty}`);
  assert.equal(total.interval, 0);
  assert.equal(total.due, 0);
  // Printed for the record.
  console.log(`fsrs-parity ${zone}: answers ${total.answers}; max relative stability diff ${total.stability}; max difficulty diff ${total.difficulty}; max interval diff ${total.interval} d; max due diff ${total.due} ms; ts-fsrs intervals above the maximum (capped here) ${total.capped}`);
});

for (const zone of ZONES) test(`a migrated SM-2 review continues as ts-fsrs continues a review card with the same memory state (${zone}, every 3 hours of the day)`, () => {
  process.env.TZ = zone;
  const f = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));
  let checks = 0;
  for (const interval of [1, 2, 6, 15, 38, 95, 250]) for (const ease of [1.3, 1.8, 2.5, 2.9]) for (const late of [-2, 0, 4])
    for (let hour = 0; hour < 24; hour += 3) {
      const lastReview = Date.parse("2026-03-01T00:00:00.000Z") + hour * 3600e3 + 17 * 60e3;
      const sm2 = { repetitions: 3, interval_days: interval, ease_factor: ease, due_at: new Date(lastReview + interval * DAY).toISOString() };
      const now = lastReview + Math.max(0, interval + late) * DAY + ((hour * 7) % 11) * 3600e3;
      const difficulty = Math.min(10, Math.max(1, 10 - ((ease - 1.3) * 9) / 2.2));
      const card = { ...createEmptyCard(shifted(lastReview)), state: 2, stability: interval, difficulty, reps: 3,
        last_review: shifted(lastReview), due: shifted(Date.parse(sm2.due_at)) };
      for (const grade of [1, 3, 4, 5]) {
        const theirs = f.next(card, shifted(now), TS_RATING[ratingOfGrade(grade)]).card;
        const ours = schedule(sm2, grade, new Date(now).toISOString());
        const where = `interval ${interval}, ease ${ease}, late ${late}, hour ${hour}, grade ${grade}`;
        assert.equal(ours.interval_days, theirs.scheduled_days, where);
        assert.ok(Math.abs(ours.stability - theirs.stability) < 1e-9, where);
        assert.ok(Math.abs(ours.difficulty - theirs.difficulty) < 1e-9, where);
        checks++;
      }
    }
  assert.equal(checks, 7 * 4 * 3 * 8 * 4);
});

test("the zones really differ (the runtime honours TZ)", () => {
  const offsets = ZONES.map((zone) => { process.env.TZ = zone; return new Date("2026-07-01T00:00:00Z").getTimezoneOffset(); });
  assert.deepEqual(offsets, [-480, 240, 0]);
});

/* retrievability (#881): the chance of still recalling a question at an instant, the number the daily round orders its due questions by.
   ts-fsrs's get_retrievability counts whole 24-hour periods since the last review; this module counts local calendar days, as its
   scheduler does. The instants below are 08:00 and 14:00 local, so both counts agree and the rest must match exactly. */
const SLOW_DECAY = Object.freeze([...FSRS6_WEIGHTS.slice(0, 20), 0.5]);
for (const zone of ZONES) test(`retrievability matches ts-fsrs 5.4.2 get_retrievability for FSRS and migrated SM-2 reviews, default and own weights (${zone})`, () => {
  process.env.TZ = zone;
  let checks = 0;
  for (const w of [FSRS6_WEIGHTS, SLOW_DECAY]) {
    const f = fsrs(generatorParameters({ w: [...w], enable_fuzz: false, enable_short_term: false }));
    const settings = w === FSRS6_WEIGHTS ? undefined : { w: [...w] };
    for (const stability of [0.5, 1, 2.5, 9, 40, 365, 4000]) for (const days of [0, 1, 2, 7, 30, 180, 1500]) {
      const last = new Date(2026, 2, 1, 8, 0).getTime(), at = new Date(2026, 2, 1 + days, 14, 0).getTime();
      const review = { algorithm: "fsrs-6", stability, difficulty: 5, reps: 3, lapses: 0, repetitions: 3, interval_days: Math.max(1, Math.round(stability)),
        ease_factor: 2.5, last_review: new Date(last).toISOString(), due_at: new Date(last + Math.max(1, Math.round(stability)) * DAY).toISOString() };
      const card = { ...createEmptyCard(shifted(last)), state: State.Review, stability, difficulty: 5, reps: 3, last_review: shifted(last) };
      const theirs = f.get_retrievability(card, shifted(at), false);
      const where = `weights ${w === FSRS6_WEIGHTS ? "default" : "own"}, stability ${stability}, ${days} days`;
      assert.equal(retrievability(review, at, settings), theirs, where);
      checks++;
      // A review the SM-2 builds wrote: stability = its interval, last review = due - interval (references/sm2-scheduling.md).
      if (Number.isInteger(stability)) {
        const sm2 = { repetitions: 3, interval_days: stability, ease_factor: 2.5, due_at: new Date(last + stability * DAY).toISOString() };
        assert.equal(retrievability(sm2, at, settings), theirs, `SM-2 review, ${where}`);
        checks++;
      }
    }
  }
  assert.equal(checks, 2 * 7 * 7 + 2 * 5 * 7);
});

test("retrievability is 0 for a question with no memory state yet, as ts-fsrs says for a new card", () => {
  process.env.TZ = "UTC";
  const at = Date.parse("2026-03-10T12:00:00.000Z");
  const f = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));
  assert.equal(f.get_retrievability(createEmptyCard(new Date(at - 5 * DAY)), new Date(at), false), 0);
  for (const review of [initialReview(), undefined, null, {}, { repetitions: 2, interval_days: 0, due_at: "2026-03-01T00:00:00.000Z" }])
    assert.equal(retrievability(review, at), 0, JSON.stringify(review));
});

test("retrievability counts the learner's local days, the days the scheduler counts for an answer at that instant", () => {
  process.env.TZ = "Asia/Shanghai";
  const last = Date.parse("2026-03-01T15:00:00.000Z"), at = Date.parse("2026-03-01T23:00:00.000Z"); // 23:00, then 07:00 the next morning in Beijing
  const review = { algorithm: "fsrs-6", stability: 3, difficulty: 5, reps: 2, repetitions: 2, interval_days: 3, ease_factor: 2.5,
    last_review: new Date(last).toISOString(), due_at: new Date(last + 3 * DAY).toISOString() };
  assert.equal(schedule(review, 4, new Date(at).toISOString()).elapsed_days, 1, "the scheduler counts one day");
  assert.equal(retrievability(review, at), forgetting_curve([...FSRS6_WEIGHTS], 1, 3), "so does retrievability");
  assert.ok(retrievability(review, at) < 1);
  assert.equal(retrievability(review, new Date(at).toISOString()), retrievability(review, at), "an ISO time is the same instant");
  assert.equal(retrievability(review, new Date(at)), retrievability(review, at), "so is a Date");
  assert.throws(() => retrievability(review, "not a time"), /Invalid timestamp/);
});
