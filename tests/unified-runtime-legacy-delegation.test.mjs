/* S6-2: what may be deleted, and what proves it. Every migration switch is off by default, so the original executors are today's default path and the off-switch is the rollback:
   only code that nothing reaches under either value of any switch goes. The proof is a call graph (tests/helpers/dead-symbols.mjs), and this file keeps it honest. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deadSymbols } from './helpers/dead-symbols.mjs';
import { library, subtitleText } from './helpers/audio-family.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// The files where jobs are carried out, scheduled, metered and settled: the places a migration leaves wrappers behind.
const EXECUTION = [/^lib\/jobs\//, /^lib\/runtime[./]/, /^lib\/job[-.]/, /^lib\/contexts\/(?:audio|generation|coach|notes|workflows|study|jobs)\//, /^lib\/audio-/, /^lib\/live/, /^lib\/mineru/,
  /^lib\/marker/, /^lib\/generation/, /^lib\/translation/, /^lib\/coach/, /^lib\/workflow-/, /^lib\/daily-recap/, /^lib\/assist/, /^lib\/retrieval-index/, /^lib\/local-command/,
  /^lib\/draft-continuation/, /^lib\/coverage-run/, /^lib\/shortfall/, /^lib\/batch/];
// What nothing in production reaches and stays on purpose: a vocabulary or helper a test pins. A NEW entry here needs a reason a reviewer accepts.
const KEPT = {
  'lib/audio-file.js#splitWav': 'the whole-file WAV splitter; the quiet-cut one is what production calls, and audio.test.mjs pins the plain one',
  'lib/audio-import.js#plainModel': 'a pass-through wrapper that audio-retry.test.mjs pins',
  'lib/contexts/jobs/contracts.js#JOB_STAGE_CODES': 'the vocabulary of stage codes; wp4-stage-codes.test.mjs asserts it is complete',
  'lib/coverage-run.js#RUN_STATES': 'the vocabulary of run states, pinned by a test',
  'lib/draft-continuation.js#extraQuestionDefault': 'the default of a top-up, pinned by a test',
  'lib/generation-failure.js#FAILURE_CODES': 'the vocabulary of failure codes, pinned by tests',
  'lib/job-timing.js#tokensPerSecond': 'the speed of a decode, a documented helper of the timing fold; job-timing.test.mjs pins it',
  'lib/job-timing.js#ttftAverageMs': 'the mean wait for a first token, same',
  'lib/live.js#listSaved': 'the saved classes of a library with no live class in front; the live and audio suites list through it',
  'lib/mineru-history.js#pruneRecords': 'the history trim the suites call directly (the service trims through the same function)',
  'lib/retrieval-index.js#sourceIdFromKey': 'the inverse of the source key, pinned by tests',
  'lib/shortfall.js#SHORTFALL_STATES': 'the vocabulary of shortfall states, pinned by a test',
};

test('nothing of the execution areas is reached by nothing: every symbol that no production code uses, under either value of any switch, is named and has a reason', async () => {
  const dead = await deadSymbols(root, file => EXECUTION.some(pattern => pattern.test(file)));
  assert.deepEqual(dead.filter(key => !KEPT[key]), [], 'a new unreachable symbol: delete it, or add it to KEPT with the reason it stays');
  assert.deepEqual(Object.keys(KEPT).filter(key => !dead.includes(key)), [], 'a kept symbol is used (or gone) now: take it off the list');
});

test('what S6-2 deleted stays deleted: the module-level class registry, the checkpoint reference of S3-2 and the unused phase list', async () => {
  const live = await import('../lib/live.js'), checkpoint = await import('../lib/contexts/generation/jobs/checkpoint-ref.js'), job = await import('../lib/mineru-job.js');
  assert.deepEqual(['activeSession', 'registered', 'register', 'unregister'].filter(name => name in live), []);
  assert.deepEqual(Object.keys(checkpoint).sort(), ['checkpointHolds', 'checkpointOf']);
  assert.equal('PHASES' in job, false);
});

test('a Job of the unified runtime is reached through the kernel by the public doors and is in none of the original tables', async t => {
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  let aborted = false;
  const blocked = (_system, _prompt, { signal }) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })); };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ complete: blocked, paths: ['audioSubtitles'] });
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: blocked, ...managed });
  const started = await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText });
  await reached;
  const { work } = lib.service.runtime;
  assert.deepEqual([work.generationControllers.has(started.jobId), work.retryable.has(started.jobId), work.jobControls.has(started.jobId)], [false, false, false], 'no original controller, retry hold or control');
  assert.equal(work.jobs.get(started.jobId).contract.contractVersion, 2, 'the row of the table is the kernel\'s record');
  await lib.service.call('job.cancel', { jobId: started.jobId });
  await until(() => aborted, 'the stop to reach the request');
  assert.equal((await lib.service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 5 })).status, 'cancelled');
});
