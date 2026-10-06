import test from 'node:test';
import assert from 'node:assert/strict';
import { callTiming, dshTiming, foldCallTiming, jobTiming, ttftAverageMs, tokensPerSecond } from '../lib/job-timing.js';
import { jobContract } from '../lib/job-contract.js';
import { sessionTiming } from '../lib/token-usage.js';

/* The 任务 console's two speed figures, counted exactly the way DSH's `sessionStats`
   projection counts a session (dsh-session-stats): 首 token 平均（TTFT） is the mean
   wait from a step's start to its first delta chunk; 输出速度（TPS） is the decoded
   output tokens over the time spent writing them. A call that cannot say a time is
   left out rather than guessed at. */

const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const call = (start, first, end, outputTokens, extra = {}) => ({ callId: `c${start}-${end}`, kind: 'author', status: 'ok',
  startedAt: at(start), firstOutputAt: first === null ? undefined : at(first), endedAt: end === null ? null : at(end),
  ...(outputTokens === null ? {} : { outputTokens }), ...extra });

test('one call: the wait for its first token and the writing after it are two separate spans', () => {
  // Started at 10, wrote its first token at 12, ended at 42, and its provider reported 300 output tokens.
  assert.deepEqual(callTiming(call(10, 12, 42, 300, {})), { ttftMs: 2000, ttftSteps: 1, decodeMs: 30000, decodeTokens: 300 });
  // A provider that reported no usage still counts the wait; DSH folds the same way.
  assert.deepEqual(callTiming({ ...call(10, 12, 42, 300), outputTokens: undefined }), { ttftMs: 2000, ttftSteps: 1, decodeMs: 0, decodeTokens: 0 });
});

test('a call that cannot say a time is left out, never estimated from the text it wrote', () => {
  const nothing = { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };
  assert.deepEqual(callTiming(call(10, null, 42, 300)), nothing, 'a provider that does not stream offers no first token');
  assert.deepEqual(callTiming(call(10, 12, null, 300)), nothing, 'a call still in flight has not settled');
  assert.deepEqual(callTiming({ id: 'x', kind: 'author', status: 'running', startedAt: at(10) }), nothing);
  assert.deepEqual(callTiming(undefined), nothing);
  // A first token observed before the call started or after it ended is not a measurement this module will use.
  assert.deepEqual(callTiming(call(10, 42, 20, 300)), nothing);
  assert.deepEqual(callTiming({ ...call(10, 12, 42, 300), startedAt: 'not a date' }), nothing);
});

test('DSH\'s own sessionStats wins for a call that has one: the harness counted it, so we do not count it again', () => {
  // A generation phase is a one-shot DSH child, and its sessionStats is the host's own fold over that child's steps.
  const host = { ttftMs: 9000, ttftSteps: 3, decodeMs: 60000, decodeTokens: 15000 };
  assert.deepEqual(callTiming({ ...call(0, 1, 11, 100), timing: host }), host, 'the host\'s four counters, unchanged');
  assert.equal(callTiming({ ...call(0, 1, 11, 100), timing: host }).decodeTokens, 15000, 'not the 100 the single call reported');
  // A child session can hold several model calls; the host counted them all, so its figure is the one to show.
  assert.deepEqual(foldCallTiming([{ ...call(0, 1, 11, 100), timing: host }]), host);
  // Anything that is not DSH\'s whole view is not trusted, and the call\'s own boundaries are observed instead.
  for (const bad of [{ ttftMs: 1 }, { ttftMs: -1, ttftSteps: 1, decodeMs: 1, decodeTokens: 1 }, null, 'x', undefined]) {
    assert.equal(dshTiming(bad), null);
    assert.deepEqual(callTiming({ ...call(0, 2, 12, 500), timing: bad }), { ttftMs: 2000, ttftSteps: 1, decodeMs: 10000, decodeTokens: 500 });
  }
  assert.equal(dshTiming({ ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }) !== null, true, 'four zeros are a real reading, not a missing one');
});

test('the host\'s sessionStats reaches a phase through the same observation lease token usage uses', () => {
  // readSessionUsage reads one lease: tokenUsage AND sessionStats. This is the reuse path (lib/token-usage.js).
  assert.deepEqual(sessionTiming({ turns: 2, steps: 4, llmMs: 9, toolMs: 1, ttftMs: 4800, ttftSteps: 3, decodeMs: 8000, decodeTokens: 2032, lastTurn: 2 }),
    { ttftMs: 4800, ttftSteps: 3, decodeMs: 8000, decodeTokens: 2032 }, 'the four counters it serves, and nothing else');
  assert.equal(sessionTiming({ turns: 2 }), null, 'a host without the projection serves nothing, and nothing is invented');
  assert.equal(sessionTiming(undefined), null);
});

test('the fold is DSH\'s: waits add up over the calls that reported one, decode only where output was reported too', () => {
  const fold = foldCallTiming([call(0, 1, 11, 100), call(20, 23, 53, 300), call(60, 61, 66, 50)]);
  assert.deepEqual(fold, { ttftMs: 1000 + 3000 + 1000, ttftSteps: 3, decodeMs: 10000 + 30000 + 5000, decodeTokens: 450 });
  assert.equal(ttftAverageMs(fold), 5000 / 3, 'the mean wait over the steps that reported one');
  assert.equal(tokensPerSecond(fold), 450 / 45, 'decoded tokens over decoded seconds');
  // A step that reported a first token but no usage still counts its wait; DSH does the same for its own total.
  assert.deepEqual(foldCallTiming([call(0, 2, 12, null)]), { ttftMs: 2000, ttftSteps: 1, decodeMs: 0, decodeTokens: 0 });
  assert.equal(tokensPerSecond({ decodeMs: 0, decodeTokens: 0 }), null, 'nothing was decoded: no speed to state');
  assert.equal(ttftAverageMs({ ttftMs: 0, ttftSteps: 0 }), null, 'no step reported a first token: no average to state');
});

test('a rate-limit wait is a timeline bar, not a model request: it adds no time', () => {
  const folded = foldCallTiming([{ callId: 'w', kind: 'wait', status: 'ok', startedAt: at(0), endedAt: at(30) }, call(1, 3, 13, 100)]);
  assert.deepEqual(folded, { ttftMs: 2000, ttftSteps: 1, decodeMs: 10000, decodeTokens: 100 });
});

test('nothing measured gives four zeros and two empty figures, so a reader is never shown a guess', () => {
  assert.deepEqual(foldCallTiming([]), { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
  assert.deepEqual(foldCallTiming(undefined), { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
  assert.deepEqual(foldCallTiming([null, { id: 'x', kind: 'transcribe', status: 'ok', startedAt: at(0), endedAt: at(9) }]),
    { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
});

test('jobTiming reads a contract, a job and a bare list the same way', () => {
  const calls = [call(0, 1, 11, 100), call(20, 22, 42, 200)];
  const folded = { ttftMs: 3000, ttftSteps: 2, decodeMs: 30000, decodeTokens: 300 };
  assert.deepEqual(jobTiming(calls), folded);
  assert.deepEqual(jobTiming({ calls }), folded);
  assert.deepEqual(jobTiming({ usage: { timing: folded } }), { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }, 'a job with no calls of its own has nothing to fold');
});

test('the contract\'s own calls are what the console folds: each carries its output count, and a host-run one carries DSH\'s figures', () => {
  const job = { id: 'job-1', status: 'complete', finishedAt: at(300), control: undefined, tokenUsage: { uncachedInputTokens: 900, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 },
    tasks: [{ id: 'a', kind: 'proofread', status: 'complete', runtime: 'subagent', startedAt: at(0), firstOutputAt: at(2), finishedAt: at(22), tokenUsage: { uncachedInputTokens: 400, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { id: 'b', kind: 'proofread', status: 'complete', runtime: 'subagent', startedAt: at(30), firstOutputAt: at(31), finishedAt: at(61), tokenUsage: { uncachedInputTokens: 500, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 } }] };
  const contract = jobContract(job);
  assert.deepEqual(contract.calls.map((entry) => entry.outputTokens), [100, 150], 'each call says its own output, which is what the speed divides');
  const folded = jobTiming(contract.calls);
  assert.deepEqual(folded, { ttftMs: 3000, ttftSteps: 2, decodeMs: 50000, decodeTokens: 250 });
  assert.equal(ttftAverageMs(folded), 1500);
  assert.equal(tokensPerSecond(folded), 5);
  // A phase DSH ran as its own child session carries the host's own figures on its call, and those win.
  const host = { ttftMs: 9000, ttftSteps: 3, decodeMs: 60000, decodeTokens: 15000 };
  const withHost = jobContract({ ...job, tasks: job.tasks.map((task, index) => (index === 0 ? { ...task, timing: host } : task)) });
  assert.deepEqual(withHost.calls[0].timing, host);
  // The host's session covers the first call; the second was observed here (1 s to its token, 30 s writing, 150 tokens).
  assert.deepEqual(jobTiming(withHost.calls), { ttftMs: 10000, ttftSteps: 4, decodeMs: 90000, decodeTokens: 15150 }, 'the host\'s session and the call it did not run add up once each');
});
