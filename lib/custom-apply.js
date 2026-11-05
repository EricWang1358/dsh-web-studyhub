import { courseOf as bookCourseOf } from './course-book-files.js';
import { currentCourseNotes } from './course-book.js';
import { courseSkeleton } from './custom-skeleton.js';
import { scopeUnits } from './custom-sources.js';
import { fitUnits, packRuns } from './custom-questions.js';
import { wordsOf } from './custom-apply-words.js';
import { requestKinds } from './generation-settings.js';

/* course.custom.apply { course?, confirm?, language? } (深度定制, lib/custom-plan.js): starts the work a SAVED 定制方案 asks for, in order, through the jobs that already exist
   (no job of its own): the 复习全书 (generation.courseBook.build), the questions (generate, one run per group of chapters), the study plan (course.save {plan}). Nothing the
   learner did not tick is made. It is a function of the library as it is, so it is safe to say again: a run that is going is not started twice, what is made is not made again.
     -> { status: 'ok' | 'no-course' | 'no-plan', course, started, waiting, recorded, done }, every item { step, what } in plain words for the chat to read out
        (lib/custom-apply-words.js); the items of a job carry its `jobId`.
     started   work started now: the book's job, the question runs' jobs (a run that is already going is named, not started again), the plan saved now
     waiting   what is not started and why: no model, a sample the learner has not seen, a chapter that no longer exists, a refusal of the build, runs beyond RUNS_AT_ONCE (say it
               again when these have finished), an exam date a plan by date needs
     recorded  choices that are only kept in the plan, nothing makes them yet (the exam range, the parts of the book while the build does not read them)
     done      what is already so: a book that is written, questions that exist, a plan that is saved, the variants switch (it acts when an answer is wrong, lib/contexts/coach)
   ORDER. book, questions, plan. The three are independent jobs; the book is first because the learner reads it first.
   THE SAMPLE (`sampleFirst`): the book writes its two-point sample and waits (the build's own rule); the questions start for the FIRST group of chapters only, its first round, and
   the other groups wait. `confirm: true` is the learner's 「做完」: the book builds the rest of its sample, and every group starts. A group started as a sample is named, not made again.
   THE QUESTIONS follow the plan: the page sources of the chosen chapters only (lib/custom-sources.js), the kinds of `questions.kinds` (generate takes the list), the strength as
   coverageLevel, in the runs of lib/custom-questions.js (the 500 questions one run is planned for is per run, so a big book is not cut). */

/** The most question runs one apply starts: the rest says so and waits for it to be said again, so a big book does not put a hundred tasks into the console at once. */
export const RUNS_AT_ONCE = 12;
/** Whether generation.courseBook.build leaves out the parts of the book the plan did not tick (codex/custom-book-s2 makes it read them).
    While it does not, the choice is only recorded. */
export const BUILD_HONOURS_PARTS = false;

const chains = new Map();
/** One apply at a time for a library: the running check reads the task table, and a task is only in it once `generate` has answered, so two applies in flight could both find a
    run missing and both start it. The second waits for the first (and then names what is going). `key`: the library folder. */
export function applySerially(key, task) {
  const done = (chains.get(key) ?? Promise.resolve()).then(task), tail = done.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return done;
}

const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));
const message = error => String(error?.message ?? error);
const unavailable = answer => answer?.available === false;

export async function applyCustom({ state, call, jobs, activeJob }, args = {}) {
  const course = bookCourseOf(state, args), record = course === null || course === undefined ? null : (state.courses || []).find(item => item?.name === course) ?? null;
  const out = { status: 'ok', course: course ?? null, started: [], waiting: [], recorded: [], done: [] };
  if (!record) return { ...out, status: 'no-course' };
  const custom = record.custom;
  if (!custom) return { ...out, status: 'no-plan' };
  const skeleton = courseSkeleton(state, course), { units, unknown } = scopeUnits(state, course, skeleton, custom.scope);
  const ctx = { state, call, jobs, activeJob, course, record, custom, units, unknown, confirm: args.confirm === true, words: wordsOf(args.language === 'en' ? 'en' : 'zh'), out };
  if (custom.scope.kind === 'exam') out.recorded.push({ step: 'scope', what: ctx.words.examRange });
  if (custom.book.make && !BUILD_HONOURS_PARTS) out.recorded.push({ step: 'book-parts', what: ctx.words.parts(custom.book.parts) });
  await bookStep(ctx);
  await questionsStep(ctx);
  await planStep(ctx);
  if (custom.questions.make) out.done.push({ step: 'variants', what: ctx.words.variants(custom.questions.variants) });
  return out;
}

/* ---------- the book ---------- */

const bookArgs = ({ course, custom, confirm }) => ({ course, coverage: custom.book.coverage, ...(custom.scope.kind === 'chapters' ? { chapters: custom.scope.chapters } : {}),
  ...(custom.sampleFirst ? (confirm ? { sample: 'confirm' } : {}) : { sample: 'skip' }) });

async function bookStep(ctx) {
  const { custom, state, course, call, words, out, unknown, confirm } = ctx, step = 'book';
  if (!custom.book.make) return;
  if (custom.scope.kind === 'chapters' && unknown.length) { out.waiting.push({ step, what: words.unknownChapters(unknown) }); return; }
  const sample = currentCourseNotes(state.sources, course)?.courseNotes.sample;
  if (custom.sampleFirst && !confirm && sample?.status === 'waiting' && sample.level === custom.book.coverage) { out.waiting.push({ step, what: words.sampleWaits }); return; }
  try {
    const asked = bookArgs(ctx), look = await call('courseBook.build', { ...asked, estimate: true });
    if (unavailable(look)) { out.waiting.push({ step, what: words.noModel }); return; }
    if (look.scale && look.scale.points === 0 && look.scale.calls.high === 0) { out.done.push({ step, what: words.bookDone }); return; }
    const started = await call('courseBook.build', asked);
    out.started.push({ step, jobId: started.jobId, what: started.alreadyRunning ? words.bookRunning : custom.sampleFirst && !confirm ? words.bookSample : words.bookStarted });
  } catch (error) { out.waiting.push({ step, what: message(error) }); }
}

/* ---------- the questions ---------- */

const titleOf = (run, course) => {
  const first = run.units[0], last = run.units.at(-1);
  return `${course} · ${first.title}${last === first ? '' : ` – ${last.title}`}`;
};

/** What earlier runs of this library already did for exactly these pages and kinds: a task that is going, or a draft or a deck made from them. */
function earlier({ state, jobs, activeJob, custom }, ids) {
  const kinds = custom.questions.kinds, same = generation => !!generation && sameSet(generation.sourceIds || [], ids) && sameSet(requestKinds(generation), kinds);
  const running = [...jobs()].find(job => activeJob(job) && sameSet(job.sourceIds || [], ids) && sameSet(requestKinds(job), kinds));
  const drafts = (state.drafts || []).filter(item => same(item.editorial?.generation));
  // A draft whose run stopped between rounds (the sample's first round, a strength that does not go on by itself, a pause) is not made: it is to be taken up again.
  const resumable = drafts.find(item => ['waiting', 'paused'].includes(item.editorial?.coverageRun?.state));
  return { running, resumable, made: drafts.length > 0 || (state.decks || []).some(item => same(item.editorial?.generation)) };
}

async function questionsStep(ctx) {
  const { custom, state, units, call, words, out, course, confirm } = ctx, step = 'questions', { kinds, strength } = custom.questions;
  if (!custom.questions.make) return;
  if (custom.scope.kind === 'chapters' && ctx.unknown.length) { out.waiting.push({ step, what: words.unknownChapters(ctx.unknown) }); return; }
  if (!units.length) { out.waiting.push({ step, what: words.noText }); return; }
  // A chapter inside one text no page holds is read with that whole text (lib/custom-sources.js `cut`): said, not hidden.
  const whole = units.filter(unit => unit.cut === false).map(unit => unit.title);
  if (whole.length) out.recorded.push({ step, what: words.uncut(whole) });
  const charsOf = id => (state.sources || []).find(source => source.id === id)?.text?.length ?? 0, sample = custom.sampleFirst && !confirm;
  const runs = packRuns(fitUnits(units, strength, { charsOf }), strength).map(run => ({ run, ids: [...new Set(run.units.flatMap(unit => unit.sourceIds))] }));
  let started = 0, kept = 0, left = 0;
  for (const [at, { run, ids }] of runs.entries()) {
    const found = earlier(ctx, ids), title = titleOf(run, course);
    if (found.running) { out.started.push({ step, jobId: found.running.id, what: words.runGoing(title) }); continue; }
    // The learner said 「做完」 (or there is no sample): a run that stopped after a round goes on to the end, by the existing continue action, and is said under started.
    const resume = found.resumable && !sample ? { resumeDraftId: found.resumable.id, draftVersion: found.resumable.draftVersion, coverage: { run: true, autoComplete: true } } : null;
    if (found.made && !resume) { kept += 1; continue; }
    if ((sample && at > 0) || started >= RUNS_AT_ONCE) { left += 1; continue; }
    try {
      // Every run that is not the sample goes on by itself to the end, whatever its strength: the estimate showed the whole count.
      const begun = await call('generate', resume ?? { sourceIds: ids, kinds, coverageLevel: strength, course, title, autoComplete: !sample });
      if (unavailable(begun)) { out.waiting.push({ step, what: words.noModel }); return; }
      started += 1;
      out.started.push({ step, jobId: begun.jobId, what: resume ? words.runResumed(title) : words.runStarted(title, run.goal, sample) });
    } catch (error) { out.waiting.push({ step, what: message(error) }); left += runs.length - at - 1; break; }
  }
  if (kept) out.done.push({ step, what: words.runsKept(kept) });
  if (left) out.waiting.push({ step, what: sample ? words.runsSample(left) : words.runsLeft(left, RUNS_AT_ONCE) });
}

/* ---------- the study plan ---------- */

async function planStep(ctx) {
  const { custom, record, call, words, out, course } = ctx, step = 'plan', want = custom.plan, have = record.plan;
  if (!want.make) return;
  const weekly = want.by === 'weekly', perWeek = want.chaptersPerWeek ?? 1;
  const plan = { version: 1, status: 'active', by: want.by, ...(weekly ? { chaptersPerWeek: perWeek } : {}), ...(want.minutesPerDay ? { minutesPerDay: want.minutesPerDay } : {}) };
  if (have) {
    const same = (have.by ?? 'exam') === want.by && (!weekly || have.chaptersPerWeek === perWeek);
    out[same ? 'done' : 'waiting'].push({ step, what: same ? words.planSaved : words.planOther });
    return;
  }
  if (!weekly && !record.exam?.date) { out.waiting.push({ step, what: words.planNeedsDate }); return; }
  try {
    await call('course.save', { name: course, plan });
    out.started.push({ step, what: weekly ? words.planWeekly(perWeek) : words.planByDate });
  } catch (error) { out.waiting.push({ step, what: message(error) }); }
}
