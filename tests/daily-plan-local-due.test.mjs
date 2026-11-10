/* #882 review 2: the daily plan's "due" is the learner's own calendar day. 考前对齐 makes a question due at 00:00 local of the
   exam day; in Beijing that instant is 16:00Z of the day before, so reading the UTC date of `due_at` offered it a day early.
   The time zone is fixed for this file (as tests/fsrs-local-days.test.mjs does). */
process.env.TZ = 'Asia/Shanghai';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

const date = '2026-10-05';
const local = (text) => new Date(`${text}+08:00`).toISOString();
const card = (id, due_at, extra = {}) => ({ id, kind: 'flashcard', topic: 'Conditional probability', prompt: `Question ${id}`, answer: 'Answer', options: [], citations: [], requires: [],
  review: { repetitions: 1, interval_days: 3, ease_factor: 2.5, due_at }, ...extra });

test('the time zone is the one this file fixes', () => {
  assert.equal(new Date(local('2026-10-05T12:00:00')).getTimezoneOffset(), -480);
});

test('a question due at local 00:00 tomorrow is not offered as due today; one due later today or earlier is', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'daily-plan-local-due-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const service = new StudyService(join(home, 'library'));
  t.after(async () => { await service.dispose(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await rm(home, { recursive: true, force: true }); });
  await service.store.update((s) => {
    s.decks.push({ id: 'deck', title: 'Probability', course: 'Math', cards: [
      card('early', local('2026-10-05T07:00:00')), // 2026-10-04T23:00Z: due today, though its UTC date is yesterday
      card('tonight', local('2026-10-05T23:00:00')),
      card('midnight', local('2026-10-06T00:00:00')), // 2026-10-05T16:00Z: tomorrow, though its UTC date is today
      card('focus-midnight', local('2026-10-06T00:00:00'), { focus: true }),
    ] });
  });
  const plan = await service.call('daily.plan.suggest', { date, minutes: 120, local: true });
  const offered = plan.proposal.items.flatMap((item) => item.scope.map((ref) => ref.cardId));
  assert.ok(offered.includes('early') && offered.includes('tonight'), `due today: ${offered}`);
  assert.ok(!offered.includes('midnight'), `due tomorrow is not today's review: ${offered}`);
  assert.ok(!offered.includes('focus-midnight'), `nor in the focus block: ${offered}`);
});
