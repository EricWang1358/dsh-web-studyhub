import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION, STATUSES, jobContract, checkAction, kindOf } from '../lib/job-contract.js';

// The public contract of a job (docs/job-contract.md): ONE adapter over the jobs the plugin already has. These tests are its shape.
const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const control = (values = {}, extra = {}) => ({
  values: { textConcurrency: 3, transcribeConcurrency: 1, proofreadReasoning: 'default', translateReasoning: 'low', autoBackoff: true, paused: false, ...values },
  limits: { textConcurrency: { type: 'int', min: 1, max: 6 }, transcribeConcurrency: { type: 'int', min: 1, max: 3 },
    proofreadReasoning: { type: 'enum', values: ['default', 'low', 'high'] }, translateReasoning: { type: 'enum', values: ['default', 'low', 'high'] },
    autoBackoff: { type: 'bool' }, paused: { type: 'bool' }, ...extra } });
const audio = (extra = {}) => ({ id: 'attempt-1', type: 'audio-import', batchId: 'batch-1', filename: 'Week 3', status: 'running', phase: 'proofread', done: 3, total: 9, startedAt: at(0),
  control: control(), paused: false, retryable: true, ...extra });
const generation = (extra = {}) => ({ id: 'gen-1', status: 'running', stage: 'Writing and self-checking questions', kind: 'quiz', requestedTotal: 10, savedCount: 4, startedAt: at(0),
  control: { values: { concurrency: 4, paused: false }, limits: { concurrency: { type: 'int', min: 1, max: 8 }, paused: { type: 'bool' } } }, paused: false, ...extra });
const pdf = (extra = {}) => ({ id: 'pdf-1', type: 'pdf-convert', filename: 'Book.pdf', status: 'running', phase: 'parse', done: 0, total: 0, startedAt: at(0), retryable: true, ...extra });

test('the contract is versioned and every status of the lifecycle is a word of one vocabulary', () => {
  assert.equal(CONTRACT_VERSION, 1);
  assert.deepEqual(STATUSES, ['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'complete', 'failed', 'interrupted']);
  const view = jobContract(generation());
  assert.equal(view.contractVersion, 1);
  assert.ok(STATUSES.includes(view.status));
});

test('legacy statuses map to the lifecycle: done is complete, a partial result is complete with its completeness, a superseded job ended by being superseded', () => {
  const of = (extra) => jobContract(generation({ ...extra }));
  for (const [legacy, status] of [['queued', 'queued'], ['running', 'running'], ['cancelling', 'cancelling'], ['cancelled', 'cancelled'], ['complete', 'complete'],
    ['failed', 'failed'], ['interrupted', 'interrupted'], ['done', 'complete']]) assert.equal(of({ status: legacy, control: undefined }).status, status, legacy);
  const partial = of({ status: 'partial', control: undefined });
  assert.equal(partial.status, 'complete', 'partial is not a status');
  assert.equal(partial.result.completeness, 'partial');
  const superseded = of({ status: 'superseded', control: undefined });
  assert.equal(superseded.status, 'cancelled');
  assert.equal(superseded.endReason, 'superseded');
  const short = of({ status: 'complete', requestedTotal: 10, savedCount: 7, control: undefined });
  assert.equal(short.status, 'complete');
  assert.equal(short.result.completeness, 'partial', 'a run that finished short of what was asked says so in its result, not in its status');
  assert.equal(of({ status: 'complete', requestedTotal: 10, savedCount: 10, control: undefined }).result.completeness, 'complete');
  assert.equal(of({ status: 'running' }).result.completeness, null, 'nothing is said about a result that is not there yet');
  assert.equal(of({ status: 'cancelled', cancelRequestedAt: at(5), control: undefined }).endReason, 'user-cancel');
  assert.equal(of({ status: 'whatever', finishedAt: at(9), control: undefined }).status, 'failed', 'a status nobody knows on a finished job reads as failed, never as success');
  assert.equal(of({ status: 'whatever', control: undefined }).status, 'running');
});

test('pause shows as pausing until the calls in flight are done, then as paused', () => {
  const running = { id: 'c1', kind: 'proofread', status: 'running', startedAt: at(1) };
  const pausing = jobContract(audio({ paused: true, tasks: [running] }));
  assert.equal(pausing.status, 'pausing');
  assert.deepEqual(pausing.actions.pause.waiting, { reason: 'calls-in-flight', count: 1 }, 'it says what it is waiting for');
  const paused = jobContract(audio({ paused: true, pausedAt: at(30), tasks: [{ ...running, status: 'complete', finishedAt: at(20) }] }));
  assert.equal(paused.status, 'paused');
  assert.equal(paused.actions.pause.waiting, undefined);
  assert.equal(jobContract(audio({ paused: true, pausedAt: at(30), tasks: [running] })).status, 'pausing', 'a call that is still running means the boundary has not been reached');
  const queued = jobContract(generation({ status: 'queued', paused: true }));
  assert.equal(queued.status, 'paused', 'a queued job that is held has nothing in flight to wait for');
});

test('identity: a job that can be retried is named by what survives the retry, and its current attempt by its own id', () => {
  const view = jobContract(audio());
  assert.equal(view.jobId, 'batch-1');
  assert.equal(view.attemptId, 'attempt-1');
  const single = jobContract(audio({ batchId: undefined, singleId: 'single-1' }));
  assert.equal(single.jobId, 'single-1');
  const run = jobContract(generation());
  assert.equal(run.jobId, 'gen-1');
  assert.equal('attemptId' in run, false, 'a kind without retries has no attempt to name');
  assert.equal('attemptId' in jobContract(pdf()), false, 'a PDF conversion keeps its own id across a retry: no separate attempt');
});

test('the stage is a code the interface translates, with its arguments; the prose is only a fallback', () => {
  const view = jobContract(audio({ phase: 'proofread', done: 3, total: 9, stage: '读取音频' }));
  assert.deepEqual(view.stage, { code: 'audio.proofread', args: { done: 3, total: 9 }, text: '读取音频' });
  assert.equal(jobContract(generation()).stage.code, 'generation.authoring');
  assert.equal(jobContract(generation({ status: 'queued', stage: 'Waiting for the previous generation' })).stage.code, 'generation.queued');
  assert.equal(jobContract(pdf()).stage.code, 'pdf.parse');
  assert.equal(jobContract({ id: 'x', type: 'translation', status: 'running', stage: 'Writing translations 3/15', done: 3, total: 15, startedAt: at(0) }).stage.code, 'translation.writing');
  assert.equal(jobContract({ id: 'x', type: 'extension', status: 'running', stage: 'Doing a thing', startedAt: at(0) }).stage.code, 'task.running');
  const ended = jobContract(generation({ status: 'complete', control: undefined }));
  assert.deepEqual([ended.stage.code, ended.stage.args.status], ['finished', 'complete']);
});

test('progress: done over total, total may be unknown, and the stage segments are counted from real work', () => {
  const view = jobContract(audio({ members: [{ filename: 'a.wav', status: 'complete', steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 4, total: 4 }, translate: { done: 2, total: 2 } } },
    { filename: 'b.wav', status: 'running', steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 4 } } }] }));
  assert.equal(view.progress.unit, 'files');
  assert.deepEqual([view.progress.done, view.progress.total], [1, 2]);
  assert.deepEqual(view.progress.segments.map((segment) => [segment.stage, segment.done, segment.total]), [['transcribe', 2, 2], ['proofread', 5, 8], ['translate', 2, 2], ['save', 0, 1]]);
  const unknown = jobContract(pdf());
  assert.equal(unknown.progress.total, null, 'a total that is not known is null, not zero');
  assert.equal(unknown.progress.percent, null);
  assert.equal(unknown.progress.unit, 'pages');
  assert.equal(jobContract(pdf({ done: 50, total: 200 })).progress.percent, 25);
  const gen = jobContract(generation());
  assert.deepEqual([gen.progress.done, gen.progress.total, gen.progress.unit, gen.progress.percent], [4, 10, 'questions', 40]);
});

const actionsOf = (job) => Object.fromEntries(Object.entries(jobContract(job).actions).map(([name, action]) => [name, action.available ? true : action.reason.code]));

test('actions: what each kind can do in each state, and why not', () => {
  assert.deepEqual(actionsOf(audio()), { cancel: true, pause: true, resume: 'not-paused', retry: 'not-ended', set: true });
  assert.deepEqual(actionsOf(audio({ paused: true, pausedAt: at(9) })), { cancel: true, pause: 'already-paused', resume: true, retry: 'not-ended', set: true });
  assert.deepEqual(actionsOf(audio({ status: 'failed', control: undefined })), { cancel: 'job-ended', pause: 'job-ended', resume: 'job-ended', retry: true, set: 'job-ended' });
  assert.equal(actionsOf(audio({ status: 'failed', control: undefined, retryable: false })).retry, 'not-retryable');
  assert.equal(actionsOf(audio({ status: 'complete', control: undefined })).retry, 'not-retryable', 'a finished import has nothing to retry');
  assert.equal(actionsOf(audio({ status: 'cancelling' })).cancel, 'already-cancelling');
  // A question run of ONE round keeps nothing a pause could stop at: it can be stopped and adjusted, not paused, and says why (a coverage run of several rounds can: tests/coverage-run-exec.test.mjs).
  // It CAN be continued once it ended before it was done and kept a draft (接着做: tests/failed-continue-contract.test.mjs); while it runs there is nothing to continue yet.
  assert.deepEqual(actionsOf(generation()), { cancel: true, pause: 'single-round', resume: 'single-round', retry: 'not-ended', set: true });
  assert.deepEqual(actionsOf(generation({ status: 'queued' })), { cancel: true, pause: 'single-round', resume: 'single-round', retry: 'not-ended', set: true });
  // A PDF conversion can be stopped and retried, nothing else.
  assert.deepEqual(actionsOf(pdf()), { cancel: true, pause: 'capability-unsupported', resume: 'capability-unsupported', retry: 'not-ended', set: 'capability-unsupported' });
  assert.equal(actionsOf(pdf({ status: 'failed' })).retry, true);
  // A publication check cannot be interrupted.
  assert.equal(actionsOf({ id: 'p', type: 'draft-publish', status: 'running', startedAt: at(0) }).cancel, 'capability-unsupported');
  // A job from an older backend that carries no control has nothing to set, and says it was not offered.
  assert.equal(actionsOf(audio({ control: undefined })).set, 'no-control-yet');
  assert.equal(actionsOf(audio({ control: undefined })).pause, 'no-control-yet');
});

test('pause modes: audio and translation checkpoint; a generation run and a PDF conversion cannot pause', () => {
  assert.equal(jobContract(audio()).actions.pause.mode, 'checkpoint');
  assert.equal(jobContract({ id: 't', type: 'translation', status: 'running', startedAt: at(0), control: control({}, {}) }).actions.pause.mode, 'checkpoint');
  assert.equal(jobContract(generation()).actions.pause.mode, 'unsupported');
  assert.equal(jobContract(pdf()).actions.pause.mode, 'unsupported');
});

test('a kind that declares queued-only can be held while it is queued, and refuses a pause once it is running: no pretend pause', () => {
  const queuedOnly = { pause: 'queued-only' };
  assert.deepEqual(checkAction(generation({ status: 'queued' }), 'pause', queuedOnly), { ok: true });
  const running = checkAction(generation(), 'pause', queuedOnly);
  assert.equal(running.code, 'no-safe-checkpoint');
  assert.match(running.message, /暂停/);
  assert.equal(jobContract(generation(), queuedOnly).actions.pause.reason.code, 'no-safe-checkpoint');
  assert.equal(jobContract(generation(), queuedOnly).actions.pause.mode, 'queued-only');
  assert.equal(jobContract(generation({ status: 'queued', paused: true }), queuedOnly).status, 'paused');
});

test('set offers the live settings with their limits and current values, never the pause flag', () => {
  const { settings } = jobContract(audio()).actions.set;
  assert.deepEqual(settings.map((item) => item.key), ['textConcurrency', 'transcribeConcurrency', 'proofreadReasoning', 'translateReasoning', 'autoBackoff']);
  assert.deepEqual(settings[0], { key: 'textConcurrency', type: 'int', min: 1, max: 6, value: 3 });
  assert.deepEqual(settings[2], { key: 'proofreadReasoning', type: 'enum', values: ['default', 'low', 'high'], value: 'default' });
  assert.equal(jobContract(pdf()).actions.set.settings, undefined);
});

test('checkAction is the one judge of legality: it answers ok, or a code and a clear message', () => {
  assert.deepEqual(checkAction(audio(), 'pause'), { ok: true });
  assert.deepEqual(checkAction(audio(), 'cancel'), { ok: true });
  const refused = checkAction(pdf(), 'pause');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'capability-unsupported');
  assert.match(refused.message, /不支持/);
  const single = checkAction(generation(), 'pause');
  assert.equal(single.code, 'single-round');
  assert.match(single.message, /只出一轮/);
  assert.equal(checkAction(pdf(), 'set').code, 'capability-unsupported');
  assert.equal(checkAction(audio({ status: 'complete', control: undefined }), 'set').code, 'job-ended');
  assert.equal(checkAction(audio(), 'explode').code, 'unknown-action');
  assert.equal(checkAction(audio({ status: 'failed', control: undefined }), 'retry').ok, true);
});

test('a call record: ids, a step key, the times that can be observed and no others; a retry or a fallback is a call of its own', () => {
  const job = audio({ members: [{ filename: 'a.wav', tasks: [
    { id: 'c1', kind: 'proofread', part: 2, parts: 9, status: 'complete', runtime: 'subagent', childId: 'child-9', parentId: 'parent-1', slot: 2, startedAt: at(10), finishedAt: at(40), firstOutputAt: at(12) },
    { id: 'c2', kind: 'proofread', part: 2, parts: 9, status: 'failed', runtime: 'subagent', startedAt: at(41), finishedAt: at(42) }] }] });
  const [first, second] = jobContract(job).calls;
  assert.deepEqual(Object.keys(first).sort(), ['attemptId', 'callId', 'childId', 'endedAt', 'file', 'firstOutputAt', 'jobId', 'kind', 'parentId', 'part', 'parts', 'reasoning', 'runner', 'slot', 'stage', 'startedAt', 'status', 'stepKey', 'tokens'].sort());
  assert.equal(first.callId, 'c1');
  assert.equal(first.jobId, 'batch-1');
  assert.equal(first.attemptId, 'attempt-1');
  assert.equal(first.stepKey, 'proofread:2');
  assert.equal(first.firstOutputAt, at(12));
  assert.equal(second.stepKey, first.stepKey, 'the same step, tried again: a separate call with the same step key');
  assert.notEqual(second.callId, first.callId);
  assert.equal('firstOutputAt' in second, false, 'never fabricated');
  assert.equal('queuedAt' in second, false, 'never fabricated');
  const queued = jobContract(generation({ steps: [{ id: 's1', stage: 'Reviewing ambiguity and source support', status: 'complete', startedAt: at(10), finishedAt: at(20), queuedMs: 4000, part: 1 }] })).calls[0];
  assert.equal(queued.queuedAt, at(6), 'what is observable (the wait for a free slot) places the moment the call was queued');
  assert.equal(queued.stepKey, 'review:1');
});

test('result references, error, usage, execution mode and the type-specific detail', () => {
  const done = jobContract(audio({ status: 'complete', control: undefined, sourceIds: ['s1', 's2'], tokenUsage: { uncachedInputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 5 },
    tasks: [{ id: 'a', kind: 'proofread', status: 'complete', runtime: 'subagent', startedAt: at(1) }, { id: 'b', kind: 'transcribe', status: 'complete', runtime: 'gemini', startedAt: at(0) }] }));
  assert.deepEqual(done.result.refs, [{ kind: 'source', id: 's1' }, { kind: 'source', id: 's2' }]);
  assert.equal(done.error, null);
  assert.equal(done.usage.tokens, 1000);
  assert.equal(done.usage.calls, 5);
  assert.equal(done.execution.mode, 'mixed', 'a sub-agent and a direct request in one job');
  const failed = jobContract(audio({ status: 'failed', control: undefined, stage: '模型密钥被拒（403）', errorCode: 'invalid-token' }));
  assert.deepEqual(failed.error, { message: '模型密钥被拒（403）', code: 'invalid-token' });
  assert.equal(jobContract(generation({ steps: [{ id: 's', stage: 'x', status: 'complete', runtime: 'subagent', startedAt: at(1) }] })).execution.mode, 'subagent');
  assert.equal(jobContract(generation()).execution.mode, null, 'unknown until a call says how it ran');
  assert.deepEqual(jobContract(generation({ draftId: 'd1', status: 'complete', control: undefined })).result.refs, [{ kind: 'draft', id: 'd1' }]);
  assert.deepEqual(jobContract(generation({ status: 'complete', control: undefined, publication: { deckId: 'deck-7' } })).result.refs, [{ kind: 'deck', id: 'deck-7' }]);
  assert.equal(typeof JSON.stringify(jobContract(audio()).detail), 'string', 'the detail is plain serialisable data');
  assert.equal(kindOf(generation()), 'generation');
  assert.equal(kindOf(audio()), 'audio-import');
  assert.equal(done.title, 'Week 3');
  assert.equal(jobContract(generation({ deckTitle: '架构' })).title, '架构');
  assert.equal(jobContract(generation()).title, null, 'a job that has no name yet has none');
});

test('audio detail: one row per file with its stages, and a grouped notice in ONE line with the files marked on their own rows', () => {
  const job = audio({ warnings: ['a.mp3：文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理', 'b.mp3：文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理', 'c.wav：重复内容'],
    members: [{ filename: 'a.mp3', status: 'complete', phase: 'done', warnings: ['文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理'], steps: { proofread: { done: 4, total: 4 } } },
      { filename: 'b.mp3', status: 'running', phase: 'proofread', warnings: ['文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理'] }, { filename: 'c.wav', status: 'queued' }] });
  const { detail } = jobContract(job);
  assert.deepEqual(detail.files.map((file) => [file.filename, file.status]), [['a.mp3', 'complete'], ['b.mp3', 'running'], ['c.wav', 'queued']]);
  assert.equal(detail.files[0].actualFormat, 'WAV');
  assert.equal(detail.files[1].actualFormat, 'WAV');
  assert.equal(detail.files[2].actualFormat, undefined);
  assert.equal(detail.notices.length, 2);
  const format = detail.notices.find((notice) => notice.code === 'format-mismatch');
  assert.deepEqual([format.count, format.actualFormat], [2, 'WAV'], 'the 4 files that repeat one warning are one notice with a count');
  assert.equal(JSON.stringify(format).includes('a.mp3'), false, 'the notice does not list the files: they are marked on their own rows');
});

test('a question run lists its parts: the stages of each from its calls, and what it kept once it has reported', () => {
  const steps = [
    { id: 'p', stage: 'Planning evidence and learning targets', status: 'complete', startedAt: at(1), finishedAt: at(5) },
    { id: 'a1', stage: 'Writing and self-checking questions', part: 1, status: 'complete', startedAt: at(6), finishedAt: at(20) },
    { id: 'r1', stage: 'Reviewing ambiguity and source support', part: 1, status: 'running', startedAt: at(21) },
    { id: 'a2', stage: 'Writing and self-checking questions', part: 2, status: 'failed', startedAt: at(6), finishedAt: at(9) }];
  const running = jobContract(generation({ parts: 3, steps })).detail.partList;
  assert.deepEqual(running.map((part) => [part.part, part.status, part.stages]), [[1, 'running', { author: 'ok', review: 'running' }], [2, 'working', { author: 'failed' }], [3, 'waiting', {}]]);
  const finished = jobContract(generation({ parts: 2, steps, status: 'complete', control: undefined, partReport: { summary: 's', parts: [{ part: 1, asked: 5, kept: 5, status: 'passed' }, { part: 2, asked: 5, kept: 0, status: 'failed', reasons: ['quality'] }] } })).detail.partList;
  assert.deepEqual(finished.map((part) => [part.part, part.status, part.asked, part.kept]), [[1, 'passed', 5, 5], [2, 'failed', 5, 0]]);
  assert.deepEqual(finished[1].reasons, ['quality']);
});

test('a batch that is held for a file that did not pass its pre-flight names it, so the console can offer to skip it', () => {
  const view = jobContract(audio({ status: 'failed', control: undefined, blocked: { index: 1, filename: 'b.mp3' },
    members: [{ filename: 'a.mp3', status: 'waiting' }, { filename: 'b.mp3', status: 'blocked', stage: '文件损坏' }] }));
  assert.deepEqual(view.detail.blocked, { index: 1, filename: 'b.mp3' });
  assert.deepEqual(view.detail.files.map((file) => [file.status, file.stage]), [['waiting', undefined], ['blocked', '文件损坏']]);
});
