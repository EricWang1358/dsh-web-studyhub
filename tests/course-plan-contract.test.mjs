/* What the main chat reads about 备考计划 (lib/study-contracts.js): the `plan` area names course.plan and course.save {plan}, the shape and its limits (written from
   the constants that enforce them), the consent rule (saved only when the learner agrees, on request) and that book.crunch stays the final-week view; Discovery lists
   course.plan; the learning area's course.save line names plan. The assistant door lets both through (the strategy is the learner's to agree to, in chat), a read
   needs no domain, and the docs name the feature. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { PLAN_LIMITS } from '../lib/courses.js';
import { assistantArgsRefusal, assistantRefusal } from '../lib/assistant-boundary.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';

test('the plan area: both actions, the shape, the limits from the constants, the consent rule, the final-week view', () => {
  const text = libraryContracts.plan;
  assert.ok(text, 'an area named plan');
  for (const part of ['course.plan {course?,date?,days?:1-400}', 'course.save {name|id, plan}', 'plan:null removes it', "status 'no-plan' | 'no-book' | 'no-exam' | 'past' | 'ok'",
    'saved only when the learner agrees', 'Draft it with the learner in chat before saving', 'never evidence', 'A plan without an exam date computes nothing',
    'book.crunch stays the final-week view', 'minutesPerDay?:15-960', 'reviewCycleDays?:2-30', 'studyWeekdays?:[0-6] (0=Sunday)', 'bk: keys']) assert.ok(text.includes(part), part);
  for (const [name, limit] of [['restDates', PLAN_LIMITS.restDates], ['mockDates', PLAN_LIMITS.mockDates]]) assert.ok(text.includes(`${name}?:[YYYY-MM-DD] (≤${limit})`), name);
  assert.ok(text.includes(`(≤${PLAN_LIMITS.phases}, until ascending`) && text.includes(`goal ≤${PLAN_LIMITS.goal}`) && text.includes(`(≤${PLAN_LIMITS.text} each)`));
  assert.doesNotMatch(text, /\$\{/, 'every limit was filled in');
  assert.ok(text.length < 3000, 'the area stays short enough to read in one go');
});

test('Discovery lists course.plan, the areas list names plan, and course.save names plan in the learning area', () => {
  assert.match(studyToolDescription, /Discovery: [^\n]*book\.crunch, course\.plan, book\.mock\.plan/);
  assert.match(studyToolDescription, /areas: [^\n]*\bplan\b/);
  assert.match(libraryContracts.learning, /course\.save \{id\?,name,exam\?,plan\?,guidanceSourceIds\?,focusTopics\?\} only on request/);
  assert.match(libraryContracts.learning, /plan \(备考计划, area plan\) is replaced whole too/);
  assert.ok(libraryContracts.learning.length < 6000, 'the learning area stays under its cap (tests/main-chat-tools.test.mjs)');
});

test('the assistant may read the plan and may save it (on request, with the learner agreeing); nothing about it is Settings-only', () => {
  assert.equal(assistantRefusal('course.plan'), null);
  assert.equal(assistantRefusal('course.save'), null);
  assert.equal(assistantArgsRefusal('course.save', { name: 'SA', plan: { version: 1 } }), null);
  assert.equal(assistantArgsRefusal('course.plan', { course: 'SA' }), null);
  assert.match(libraryContracts.learning, /course\.save [^.]*only on request/);
});

test('course.plan reads and writes no library field; course.save writes the courses', () => {
  assert.deepEqual(writesFor('library', 'course.plan'), []);
  assert.deepEqual(writesFor('library', 'course.save'), ['courses']);
});

test('the review book docs name 备考计划 and its relation to 期末一周, in both languages', () => {
  const en = readFileSync(new URL('../docs/review-book.md', import.meta.url), 'utf8'), zh = readFileSync(new URL('../docs/review-book.zh-CN.md', import.meta.url), 'utf8');
  for (const part of ['Study plan', 'course.plan', 'course.save', 'Final week']) assert.ok(en.includes(part), `en: ${part}`);
  for (const part of ['备考计划', 'course.plan', 'course.save', '期末一周']) assert.ok(zh.includes(part), `zh: ${part}`);
});
