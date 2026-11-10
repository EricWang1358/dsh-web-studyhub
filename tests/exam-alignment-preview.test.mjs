/* #882 step 4: what switching 考前对齐 on or off does to the next 14 days, simulated with the pass itself
   (lib/exam-alignment.js examAlignmentPreview), not read from the stored forecast. Right after the switch, before any new
   answer, each day's due count is what the preview said. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedule, initialReview } from "../lib/sm2.js";
import { alignDueDates, examAlignmentPreview } from "../lib/exam-alignment.js";
import { StudyService } from "../lib/service.js";

const NOW = new Date(2026, 10, 2, 10, 0).getTime();
const at = (days, hh = 10) => new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate() + days, hh).toISOString();
const dateOf = (days) => {
  const d = new Date(at(days));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const reviewDueIn = (dueIn, ago = 20) => ({ ...schedule(schedule(initialReview(), 4, at(-ago - 20)), 4, at(-ago)), due_at: at(dueIn) });
const quiz = (id, review, extra = {}) => ({ id, kind: "flashcard", topic: id, prompt: `${id}?`, answer: "a", citations: [], review, ...extra });
const library = (examIn = 8) => ({
  settings: { request_retention: 0.9, maximum_interval: 36500 },
  courses: [{ id: "os", name: "OS", exam: { format: "closed-book", date: dateOf(examIn) }, focusTopics: [] }, { id: "net", name: "Networks", focusTopics: [] },
    { id: "old", name: "Old", active: false, exam: { format: "closed-book", date: dateOf(examIn) }, focusTopics: [] }],
  decks: [
    { id: "os", title: "OS", course: "OS", cards: [
      ...Array.from({ length: 12 }, (_, i) => quiz(`late-${i}`, reviewDueIn(20 + i, 1 + i))),
      quiz("soon", reviewDueIn(3)), quiz("overdue", reviewDueIn(-2)), quiz("parked", reviewDueIn(30), { suspended: true }),
      // Never answered, though it has a due date: new, so neither the forecast nor the preview counts it, and the pass leaves it.
      quiz("fresh", { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: at(1) }),
    ] },
    // A parked course: out of the forecast and of the pass (parking never touches a schedule).
    { id: "old", title: "Old", course: "Old", cards: [quiz("o1", reviewDueIn(2)), quiz("o2", reviewDueIn(30))] },
    { id: "net", title: "Net", course: "Networks", cards: [quiz("n1", reviewDueIn(4)), quiz("n2", reviewDueIn(40))] },
  ],
});
/** Each of the next 14 days' due count after a pass, overdue folded into today, as the forecast counts: answered questions of
    active decks only. */
function counts(state) {
  const start = new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate()).getTime();
  const days = Array(14).fill(0);
  for (const deck of state.decks) for (const card of deck.cards) {
    if (deck.archived || deck.course === "Old" || card.suspended || !card.review?.due_at || card.id === "fresh") continue;
    const t = Date.parse(card.review.due_at);
    const d = new Date(t), day = t < start ? 0 : Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 864e5);
    if (day < 14) days[day]++;
  }
  return days;
}

test("the preview of switching on is what the switch then does, day by day, and it names the courses with an exam ahead", () => {
  const state = library();
  state.settings.exam_alignment = false;
  const preview = examAlignmentPreview(state, NOW);
  assert.equal(preview.enabled, false);
  assert.deepEqual(preview.courses, [{ name: "OS", date: dateOf(8), pending: 0 }], "a parked course's exam is not offered");
  assert.equal(preview.restorable, 0);
  assert.equal(preview.days.length, 14);
  assert.deepEqual(preview.days[0].date, dateOf(0));
  assert.deepEqual(preview.days.map((day) => day.before), counts(state));
  const switched = structuredClone(state);
  switched.settings.exam_alignment = true;
  alignDueDates(switched, NOW);
  assert.deepEqual(preview.on.map((day) => day.after), counts(switched), "on: exactly what the pass gives");
  assert.ok(preview.on.slice(0, 8).every((day) => day.after - day.before >= 1), "each day before the exam gets some of the 12");
  assert.equal(preview.on.reduce((sum, day) => sum + day.after - day.before, 0), 12, "the 12 questions due after the exam come back within the 14 days");
  assert.deepEqual(preview.off.map((day) => day.after), counts(state), "already off: nothing would move");
  assert.equal(preview.pending, 0);
});

test("switched on, the preview of switching off gives the questions back, and a library aligned before has nothing pending", () => {
  const state = library();
  alignDueDates(state, NOW);
  const preview = examAlignmentPreview(state, NOW);
  assert.equal(preview.enabled, true);
  assert.equal(preview.pending, 0);
  const off = structuredClone(state);
  off.settings.exam_alignment = false;
  alignDueDates(off, NOW);
  assert.deepEqual(preview.off.map((day) => day.after), counts(off));
  assert.equal(preview.off.reduce((sum, day) => sum + day.after - day.before, 0), -12);
});

test("a library whose exam was set before this version is on but not aligned yet: the preview says how many are waiting", () => {
  const state = library();
  const preview = examAlignmentPreview(state, NOW);
  assert.equal(preview.enabled, true);
  assert.equal(preview.pending, 12);
  assert.deepEqual(preview.courses, [{ name: "OS", date: dateOf(8), pending: 12 }]);
  assert.equal(preview.on.reduce((sum, day) => sum + day.after - day.before, 0), 12);
  assert.deepEqual(state, library(), "the preview never writes");
});

test("no course with an exam ahead: no courses, so the switch is not shown", () => {
  const state = library(-1);
  assert.deepEqual(examAlignmentPreview(state, NOW).courses, []);
});

test("course.examAlignment.preview and .set through the service: right after the switch the due counts are the preview's", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-preview-"));
  const study = new StudyService(root);
  t.after(async () => { study.dispose?.(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const today = new Date();
  const date = (days) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const due = (days) => new Date(Date.now() + days * 864e5).toISOString();
  await study.store.update((s) => { s.decks.push({ id: "os", title: "OS", course: "OS", cards: Array.from({ length: 6 }, (_, i) => quiz(`q${i}`, { ...reviewDueIn(0), due_at: due(30 + i) })) }); });
  await study.call("course.examAlignment.set", { enabled: false });
  await study.call("course.save", { name: "OS", exam: { format: "closed-book", date: date(5) } });
  const preview = await study.call("course.examAlignment.preview", {});
  assert.equal(preview.enabled, false);
  assert.deepEqual(preview.courses.map((course) => course.name), ["OS"]);
  const result = await study.call("course.examAlignment.set", { enabled: true });
  assert.equal(result.pulled, 6);
  const after = await study.call("course.examAlignment.preview", {});
  assert.deepEqual(after.days.map((day) => day.before), preview.on.map((day) => day.after), "each day's count is what the preview said");
});
