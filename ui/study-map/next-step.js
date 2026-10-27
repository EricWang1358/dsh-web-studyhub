import { firstRunLine } from '../first-run/line.js';
import { hasQuestions } from '../generate-opening.js';
import { modelReadiness } from '../generation-status.js';
import { sampleIdsOf } from './home-plan.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { daysUntilExam } from '../../lib/courses.js';
import { isActiveJob } from '../../lib/job-status.js';

/* The home's one 「下一步」 card (3.7 guidance, step 3): what the learner should do NOW, worked out from the library snapshot alone (no model call, no
   daily.plan.get: everything here is already in `data`). Pure; ui/study-map/NextStepCard.jsx draws it and ui/study-map/next-card-view.js says it in words.

   The priority is fixed, the first condition that holds wins:
     model        no usable AI model
     sources      no material of the learner's own          } the first-run line (ui/first-run), not a second surface: while the learner has no deck of their
     questions    a material, but no questions made yet      } own the line IS these three states, so they are named here and drawn there
     due          questions due today
     resume       no question due, but a round left open (接着做)
     new-source   a material imported in the last two weeks that has no questions yet
     wrong        wrong answers not yet reviewed (待巩固)
     exam         an exam within a week
     done         nothing left
   Three readings the owner may want to change (see the PR): the first three states are the first-run line and only exist before the first own deck (after
   it, "no material" is no reason to interrupt a learner who studies from imported decks); "reviews due" is the due questions, not the whole round (weak
   questions are the 待巩固 state, unlearned ones need no card: the day's card below offers them); and "newly imported" is NEW_SOURCE_DAYS. */

/** The states, in priority order. */
export const NEXT_STEP_IDS = Object.freeze(['model', 'sources', 'questions', 'due', 'resume', 'new-source', 'wrong', 'exam', 'done']);

/** The first-run line's three steps (ui/first-run/line.js FIRST_RUN_STEPS: model, material, deck) as states, by the index of the open step. */
export const FIRST_RUN_SURFACE = Object.freeze(['model', 'sources', 'questions']);

/** A material counts as newly imported for this many days. */
export const NEW_SOURCE_DAYS = 14;
/** "Within a week": the exam is today or at most this many days away. */
export const EXAM_SOON_DAYS = 7;

const DAY = 86400000;
const PRIMARY = new Set(['model', 'due', 'resume', 'new-source', 'wrong', 'exam']);

/** Does the state's card carry a primary button (the others are drawn by the first-run line, or say there is nothing to do)? */
export const hasPrimaryAction = (id) => PRIMARY.has(id);

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/** Materials of the learner's own that were imported lately, have no questions (published, drafted or covered) and are not being made into some. Newest first. */
function newSourcesOf(data, now) {
  const sample = sampleIdsOf(data);
  const making = new Set((data.jobs || []).filter(isActiveJob).flatMap((job) => job.sourceIds || []));
  const since = now.getTime() - NEW_SOURCE_DAYS * DAY;
  const own = (data.sources || []).filter((source) => !source.sample && !sample.has(source.id));
  const items = groupSourcesByDocument(own)
    .filter((item) => !item.archived && !item.sample && item.format !== 'json' && !hasQuestions(item, data.materialCoverage) && !item.sourceIds.some((id) => making.has(id))
      && Date.parse(item.createdAt) >= since)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { count: items.length, title: items[0]?.title || '', sourceIds: items.flatMap((item) => item.sourceIds) };
}

/** The nearest exam within EXAM_SOON_DAYS among the courses in use: { course, days } or null. */
function examOf(data, now) {
  const near = (data.courses || []).filter((course) => course?.active !== false && course?.name)
    .map((course) => ({ course: course.name, days: daysUntilExam(course.exam, now) }))
    .filter((entry) => entry.days !== null && entry.days >= 0 && entry.days <= EXAM_SOON_DAYS)
    .sort((a, b) => a.days - b.days);
  return near[0] || null;
}

/**
 * The facts the priority reads, off the library snapshot. Options: `line` (the first-run line's answer, else read here), `resumeOpen` (the home plan
 * offers to resume a round), `canWrong` / `canExam` (the wrong-answers page and the review book are there to open; a state whose page is missing is
 * not offered), `now` (tests).
 */
export function nextStepFacts(data, { line, resumeOpen = false, canWrong = true, canExam = true, now = new Date() } = {}) {
  const snapshot = data || {};
  const first = line || firstRunLine(snapshot);
  const today = snapshot.today || {};
  const wrong = canWrong ? (snapshot.decks || []).filter((deck) => !deck.archived && !deck.inactive && !deck.sample).reduce((sum, deck) => sum + count(deck.wrong), 0) : 0;
  return {
    line: { show: !!first.show, step: first.show ? first.step : -1 },
    modelReady: modelReadiness(snapshot).ready,
    today: { due: count(today.due), weak: count(today.weak), new: count(today.new), size: count(today.size), ahead: !!today.ahead },
    resumeOpen: !!resumeOpen,
    newSources: newSourcesOf(snapshot, now),
    wrong,
    exam: canExam ? examOf(snapshot, now) : null,
  };
}

/**
 * The one next step: { id, surface }. `surface` is 'line' while the first-run line draws it (the learner has no deck of their own yet), else 'card'.
 */
export function nextStep(facts) {
  const { line, modelReady, today, resumeOpen, newSources, wrong, exam } = facts;
  if (line?.show) return { id: FIRST_RUN_SURFACE[line.step] || 'questions', surface: 'line' };
  const card = (id) => ({ id, surface: 'card' });
  if (!modelReady) return card('model');
  if (today.due > 0) return card('due');
  if (resumeOpen) return card('resume');
  if (newSources.count > 0) return card('new-source');
  if (wrong > 0) return card('wrong');
  if (exam) return card('exam');
  return card('done');
}
