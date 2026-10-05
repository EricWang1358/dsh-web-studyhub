import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { reasonText } from '../lib/job-contract.js';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';

/* 任务 归档: where the new operations are declared (the jobs context, the writes table, the agent-facing tool text and the docs), so none can drift from the others. */

test('the jobs context declares job.archive, job.unarchive and job.delete next to job.dismiss, with the library writes each one makes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'study-archive-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = createStudyRuntime(directory);
  t.after(() => runtime.dispose());
  const names = runtime.describe().find((context) => context.api === 'jobs.v1').operations.map((operation) => operation.name);
  for (const name of ['job.dismiss', 'job.archive', 'job.unarchive', 'job.delete']) assert.ok(names.includes(name), name);
  assert.deepEqual(writesFor('jobs', 'job.archive'), [], 'archiving writes no library record: the archive is its own file');
  assert.deepEqual(writesFor('jobs', 'job.unarchive'), []);
  assert.deepEqual(writesFor('jobs', 'job.delete'), ['inbox'], 'deleting a pre-manifest job prunes its inbox letter, like job.dismiss');
  assert.deepEqual(writesFor('jobs', 'job.dismiss'), ['inbox']);
});

test('the tool text an agent reads keeps saying that job.dismiss removes finished records only, and names the new operations', () => {
  const text = JSON.stringify(libraryContracts) + studyToolDescription;
  assert.match(text, /job\.dismiss removes finished records only/);
  for (const name of ['job.archive', 'job.unarchive', 'job.delete']) assert.ok(text.includes(name), name);
  assert.match(text, /read-only record/);
});

test('an archived job answers an action with the code "archived" and words that say what to do', () => {
  assert.match(reasonText('archived'), /归档/);
  assert.match(reasonText('archived'), /取消归档/);
});

test('the docs describe the archive: where it is kept, its limits and what 知道了 does', async () => {
  const contract = await readFile(new URL('../docs/job-contract.md', import.meta.url), 'utf8');
  for (const needle of ['job.archive', 'job.unarchive', 'job.delete', 'job-archive.json', '200', '90']) assert.ok(contract.includes(needle), `docs/job-contract.md: ${needle}`);
  const architecture = await readFile(new URL('../docs/architecture.md', import.meta.url), 'utf8');
  assert.ok(architecture.includes('job-archive.json'), 'docs/architecture.md');
});

test('an English snapshot localizes the archived records like the live jobs, and the new refusals have English words', async () => {
  const { localizeAppResponse, localizeAppMessage } = await import('../lib/application-messages.js');
  const { archiveRecordOf } = await import('../lib/job-archive.js');
  const record = archiveRecordOf({ id: 'gen-1', status: 'failed', deckTitle: 'Deck', stage: '任务还在进行，请先停止或等它结束', startedAt: '2026-10-05T08:00:00.000Z' }, { at: '2026-10-05T10:00:00.000Z' });
  const snapshot = localizeAppResponse({ jobs: [], archivedJobs: [record.job] }, 'snapshot', 'en');
  assert.equal(snapshot.archivedJobs[0].contract.error.message, 'The task is still running; stop it or wait until it finishes');
  assert.equal(localizeAppMessage('一次最多处理 100 个任务，请分几次来'), 'At most 100 jobs at a time; please do it in several steps');
  assert.match(localizeAppMessage(reasonText('archived')), /Unarchive/);
});
