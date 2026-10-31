/* What a new process does with what the last one left is one decision (lib/contexts/generation/jobs/recover-plan.js): pure, no store and no mock. A second look over its own result finds nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRunRecovery, planDraftRecovery } from '../lib/contexts/generation/jobs/recover-plan.js';
import { restoredJob } from '../lib/contexts/generation/coverage-runs.js';
import { RUN_RECORD_WINDOW_MS } from '../lib/generation-limits.js';
import { StudyService } from '../lib/service.js';

const NOW = 1_800_000_000_000;
const draft = (id, state = 'running', extra = {}) => ({ id, title: `Draft ${id}`, course: 'C', cards: [{ id: 'c' }], editorial: { generation: { kind: 'quiz', sourceIds: ['s'] },
  coverageRun: { jobId: `job-${id}`, state, startedAt: 'then', updatedAt: 'later', autoComplete: true }, coverageSpec: { goal: 5, level: 'standard', mustCover: 3, weightSource: 'length', rounds: [{ round: 1, status: 'done' }, { round: 2, status: 'running', sectionIds: ['a'] }, { round: 3 }] } }, ...extra });

test('what the disk holds: live runs come back, ended or old ones leave nothing', () => {
  const runs = [{ id: 'a', status: 'running', at: NOW }, { id: 'b', status: 'complete', at: NOW }, { id: 'c', status: 'interrupted', at: NOW - RUN_RECORD_WINDOW_MS - 1 }, { id: 'd', status: null, at: NOW }, { id: 'e', status: 'cancelling', at: NOW },
    { id: 'f', status: 'queued', at: NOW }, { id: 'g', status: 'pausing', at: NOW }, { id: 'h', status: 'interrupted', at: NOW - RUN_RECORD_WINDOW_MS }];
  const plan = planRunRecovery({ runs, now: NOW });
  assert.deepEqual(plan.restore.map(run => run.id), ['a', 'e', 'f', 'g', 'h']);
  assert.deepEqual(plan.forget.map(run => run.id), ['b', 'c', 'd']);
});

test('which drafts come back as an interrupted job: running or paused with rounds to do, no job on it, not archived', () => {
  const drafts = [draft('a'), draft('b', 'paused'), draft('c', 'waiting'), draft('d', 'stopped'), draft('e', 'complete'), draft('f', 'something-new'), draft('g', 'running', { editingDeckId: 'x' }), draft('h'), draft('i'), draft('j'), { id: 'plain', editorial: {} }];
  const jobs = [{ id: 'job-h', root: 'elsewhere', draftId: 'other' }, { id: 'zzz', root: 'R', draftId: 'i' }, { id: 'yyy', root: 'elsewhere', draftId: 'a' }];
  const found = planDraftRecovery({ drafts, jobs, archived: new Set(['job-j']), root: 'R' });
  assert.deepEqual(found.map(item => item.draft.id), ['a', 'b'], 'h: its job id is known; i: a job of this library works on it; j: archived; a: another library\'s job is no rival');
  assert.deepEqual([found[0].round, found[0].inflight], [2, [2]]);
});

test('two drafts naming one job id bring back one job; a marker without an id is judged by its draft', () => {
  const same = draft('b'); same.editorial.coverageRun.jobId = 'job-a';
  assert.deepEqual(planDraftRecovery({ drafts: [draft('a'), same], jobs: [], archived: new Set(), root: 'R' }).map(item => item.draft.id), ['a']);
  const nameless = draft('n'); delete nameless.editorial.coverageRun.jobId;
  assert.equal(planDraftRecovery({ drafts: [nameless], jobs: [], archived: new Set(), root: 'R' }).length, 1);
  assert.equal(planDraftRecovery({ drafts: [nameless], jobs: [{ id: 'q', root: 'R', draftId: 'n' }], archived: new Set(), root: 'R' }).length, 0);
});

test('a second look over what the first one restored finds nothing', () => {
  const drafts = [draft('a'), draft('b', 'paused')], say = zh => zh, ids = () => 'new';
  const first = planDraftRecovery({ drafts, jobs: [], archived: new Set(), root: 'R' });
  const jobs = first.map(found => restoredJob(found, { root: 'R', language: 'zh', say, newId: ids, now: 'now' }));
  assert.deepEqual(planDraftRecovery({ drafts, jobs, archived: new Set(), root: 'R' }), []);
});

test('the job a draft comes back as', () => {
  const [found] = planDraftRecovery({ drafts: [draft('a')], jobs: [], archived: new Set(), root: 'R' });
  const job = restoredJob(found, { root: 'R', language: 'en', say: (_zh, en) => en, newId: () => 'new', now: 'now' });
  assert.deepEqual({ id: job.id, status: job.status, retryable: job.retryable, continued: job.continued, draftId: job.draftId, kind: job.kind, count: job.count, savedCount: job.savedCount, requestedTotal: job.requestedTotal, startedAt: job.startedAt, finishedAt: job.finishedAt, language: job.language },
    { id: 'job-a', status: 'interrupted', retryable: true, continued: true, draftId: 'a', kind: 'quiz', count: 0, savedCount: 1, requestedTotal: 5, startedAt: 'then', finishedAt: 'later', language: 'en' });
  assert.match(job.stage, /interrupted before round 2/);
  assert.deepEqual(job.coverageRun.list.map(round => round.status), ['done', 'pending', 'pending'], 'the round that was in flight is shown as still to do');
  assert.deepEqual(job.coveragePlan, { level: 'standard', goal: 5, round: 2, rounds: 3, sections: 3, weights: 'length' });
  delete found.marker.jobId; delete found.marker.startedAt; delete found.marker.updatedAt;
  const nameless = restoredJob(found, { root: 'R', language: 'en', say: (_zh, en) => en, newId: () => 'new', now: 'now' });
  assert.deepEqual([nameless.id, nameless.startedAt, nameless.finishedAt], ['new', 'now', 'now']);
});

test('two looks at once bring one job back, also for a marker without an id', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-recover-plan-'));
  const seed = new StudyService(root), nameless = draft('n');
  delete nameless.editorial.coverageRun.jobId;
  await seed.store.update(state => { state.drafts.push({ ...nameless, cards: [] }); });
  await seed.dispose();
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const answers = await Promise.all([service.call('coverage.recover'), service.call('coverage.recover'), service.call('coverage.recover')]);
  assert.equal(answers.reduce((sum, answer) => sum + answer.recovered, 0), 1);
  assert.equal((await service.call('snapshot')).jobs.filter(job => job.draftId === 'n').length, 1);
});
