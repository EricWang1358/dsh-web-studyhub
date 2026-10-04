import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExamRun, examTiming, EXAM_KINDS } from '../ui/exam/exam-run.js';
import { useExamRun } from '../ui/exam/useExamRun.js';
import { paperTimings } from '../ui/case-session.js';

// WP-X (#132): the written exam, the case paper and the oral exam share one lifecycle (setup, running, report,
// restore, submit, report polling, timing). These tests run the controller without a DOM; the pages keep only
// their answering UI.
const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const fakeCall = (handlers = {}) => {
  const calls = [];
  const call = async (action, args) => {
    calls.push([action, args]);
    const handler = handlers[action];
    if (!handler) throw new Error(`unexpected ${action}`);
    return typeof handler === 'function' ? handler(args) : handler;
  };
  return { call, calls };
};
const controller = (kind, call, extra = {}) => {
  const options = { kind, call, ...extra };
  return createExamRun(() => options);
};

test('each kind knows its submit and report actions and what it tells the app about its location', () => {
  assert.deepEqual(EXAM_KINDS.exam, { submitAction: 'exam.submit', reportAction: 'exam.report', location: 'exam', locateWithoutRun: true });
  assert.equal(EXAM_KINDS.case.submitAction, 'exam.submit');
  assert.equal(EXAM_KINDS.oral.submitAction, 'oral.submit');
  assert.equal(EXAM_KINDS.oral.reportAction, 'oral.report');
  assert.equal(EXAM_KINDS.oral.location, 'oral');
  assert.equal(EXAM_KINDS.oral.locateWithoutRun, false);
});

test('a new controller starts in setup with nothing running', () => {
  const state = controller('exam', async () => {}).getState();
  assert.deepEqual(state, { phase: 'setup', run: null, report: null, error: '', busy: false, loading: false });
});

test('restore: the first candidate that answers running puts the page into running', async () => {
  const { call } = fakeCall();
  const ctl = controller('exam', call);
  const seen = [];
  await ctl.restore({ ids: ['a', 'b', 'c'], load: async (id) => {
    seen.push(id);
    if (id === 'a') return null;
    return { phase: 'running', run: { id, startedAt: '2026-01-01T00:00:00Z' } };
  } });
  assert.deepEqual(seen, ['a', 'b'], 'skipped a, took b, never asked c');
  assert.equal(ctl.getState().phase, 'running');
  assert.equal(ctl.getState().run.id, 'b');
  assert.equal(ctl.getState().loading, false);
});

test('restore: a finished run restores its report', async () => {
  const ctl = controller('exam', async () => {});
  await ctl.restore({ ids: ['r1'], load: async () => ({ phase: 'report', run: { id: 'r1' }, report: { runId: 'r1', scorePct: 80 } }) });
  const state = ctl.getState();
  assert.equal(state.phase, 'report');
  assert.equal(state.report.scorePct, 80);
  assert.equal(state.run.id, 'r1');
});

test('restore: a load that decides to stop leaves the page in setup', async () => {
  const ctl = controller('exam', async () => {});
  await ctl.restore({ ids: ['x', 'y'], load: async (id) => ({ stop: true, id }) });
  assert.equal(ctl.getState().phase, 'setup');
});

test('restore: an error is handed to onError, which chooses to go on or to stop with the message shown', async () => {
  const going = controller('case', async () => {});
  const seen = [];
  await going.restore({ ids: ['a', 'b'], load: async (id) => { seen.push(id); if (id === 'a') throw new Error('not a paper'); return { phase: 'running', run: { id } }; },
    onError: () => 'continue' });
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(going.getState().run.id, 'b');
  assert.equal(going.getState().error, '');

  const stopping = controller('oral', async () => {});
  await stopping.restore({ ids: ['a', 'b'], load: async () => { throw new Error('找不到'); } });
  assert.equal(stopping.getState().error, '找不到', 'with no onError the first failure ends restore and is shown');
  assert.equal(stopping.getState().loading, false);
});

test('restore: nothing is applied once the controller was ended (the page left)', async () => {
  const ctl = controller('exam', async () => {});
  let release;
  const waiting = ctl.restore({ ids: ['a'], load: () => new Promise((resolve) => { release = () => resolve({ phase: 'running', run: { id: 'a' } }); }) });
  ctl.end();
  release();
  await waiting;
  assert.equal(ctl.getState().phase, 'setup');
});

test('submit: flushes first, sends the run id with the extra arguments, then shows the report', async () => {
  const { call, calls } = fakeCall({ 'exam.submit': (args) => ({ runId: args.runId, scorePct: 70 }) });
  const ctl = controller('exam', call);
  ctl.enter({ id: 'run-1', startedAt: new Date().toISOString() });
  const order = [];
  const ok = await ctl.submit({ before: async () => { order.push('flush'); return { unsaved: true }; },
    args: async (context) => { order.push('args'); return { timings: { unsaved: context.unsaved } }; },
    after: async (report, context) => { order.push(`after:${report.runId}:${context.unsaved}`); } });
  assert.equal(ok, true);
  assert.deepEqual(order, ['flush', 'args', 'after:run-1:true']);
  assert.deepEqual(calls, [['exam.submit', { runId: 'run-1', timings: { unsaved: true } }]]);
  const state = ctl.getState();
  assert.equal(state.phase, 'report');
  assert.equal(state.report.scorePct, 70);
  assert.equal(state.busy, false);
  assert.equal(state.run.id, 'run-1', 'the run stays for the report page');
});

test('submit is single-flight and does nothing without a run', async () => {
  let release;
  const { call, calls } = fakeCall({ 'exam.submit': () => new Promise((resolve) => { release = () => resolve({ runId: 'r' }); }) });
  const ctl = controller('exam', call);
  assert.equal(await ctl.submit(), false, 'no run yet');
  ctl.enter({ id: 'r' });
  const first = ctl.submit();
  await settle();
  assert.equal(ctl.isBusy(), true);
  assert.equal(ctl.getState().busy, true);
  assert.equal(await ctl.submit(), false, 'a second submit while one is in flight is dropped');
  release();
  assert.equal(await first, true);
  assert.equal(calls.length, 1);
  assert.equal(ctl.isBusy(), false);
});

test('submit failure keeps the run, shows the message and holds the automatic retry back', async () => {
  let fail = true;
  const { call } = fakeCall({ 'exam.submit': () => { if (fail) throw new Error('offline'); return { runId: 'r' }; } });
  const ctl = controller('exam', call, { retryMs: 5000 });
  ctl.enter({ id: 'r' });
  const start = Date.now();
  assert.equal(ctl.autoSubmitReady(start), true, 'a running exam may be auto-submitted');
  assert.equal(await ctl.submit({ describeError: (error) => `交卷失败：${error.message}` }), false);
  let state = ctl.getState();
  assert.equal(state.phase, 'running');
  assert.equal(state.error, '交卷失败：offline');
  assert.equal(state.busy, false);
  assert.equal(ctl.autoSubmitReady(start + 1000), false, 'wait the retry delay');
  assert.equal(ctl.autoSubmitReady(Date.now() + 5001), true, 'then try again');
  fail = false;
  assert.equal(await ctl.submit(), true);
  state = ctl.getState();
  assert.equal(state.phase, 'report');
  assert.equal(ctl.autoSubmitReady(Date.now() + 99999), false, 'only a running page auto-submits');
});

test('without a retry delay a failed automatic submit is not repeated', async () => {
  const { call } = fakeCall({ 'exam.submit': () => { throw new Error('boom'); } });
  const ctl = controller('case', call);
  ctl.enter({ id: 'r' });
  await ctl.submit();
  assert.equal(ctl.autoSubmitReady(Date.now() + 1e9), false);
});

test('the oral kind submits and reads reports through the oral actions and may drop the run when the report shows', async () => {
  const { call, calls } = fakeCall({ 'oral.submit': { runId: 'o1', answered: 3 }, 'oral.report': { runId: 'o1', answered: 3, assessed: 3 } });
  const ctl = controller('oral', call);
  ctl.enter({ id: 'o1' });
  await ctl.submit({ clearRun: true });
  assert.deepEqual(calls, [['oral.submit', { runId: 'o1' }]]);
  assert.equal(ctl.getState().run, null);
  assert.equal(ctl.getState().report.runId, 'o1');
  await ctl.openReport('o1');
  assert.deepEqual(calls[1], ['oral.report', { runId: 'o1' }]);
});

test('openReport shows a saved report, and a failure only sets the message', async () => {
  const { call } = fakeCall({ 'exam.report': ({ runId }) => { if (runId === 'bad') throw new Error('gone'); return { runId, scorePct: 55 }; } });
  const ctl = controller('exam', call);
  assert.equal(await ctl.openReport('bad'), false);
  assert.equal(ctl.getState().error, 'gone');
  assert.equal(ctl.getState().phase, 'setup');
  assert.equal(await ctl.openReport('ok'), true);
  assert.equal(ctl.getState().phase, 'report');
  assert.equal(ctl.getState().error, '', 'a new action clears the old message');
});

test('perform ignores a result that arrives after begin() (the page switched to another run)', async () => {
  let release;
  const ctl = controller('oral', async () => {});
  const stale = ctl.perform(async () => { await new Promise((resolve) => { release = resolve; }); throw new Error('late failure'); });
  await settle();
  assert.equal(ctl.isBusy(), true);
  ctl.begin();
  assert.equal(ctl.isBusy(), false, 'a new identity starts free');
  assert.equal(ctl.getState().busy, false);
  release();
  await stale;
  assert.equal(ctl.getState().error, '', 'the old identity cannot write its error');
  assert.equal(await ctl.perform(async () => {}), true, 'the new identity can act at once');
});

test('leaving a finished exam: leave() returns to setup, optionally keeping the last report', () => {
  const ctl = controller('exam', async () => {});
  ctl.enter({ id: 'r' });
  ctl.showReport({ runId: 'r' });
  ctl.leave({ clear: false });
  assert.equal(ctl.getState().phase, 'setup');
  assert.equal(ctl.getState().report.runId, 'r');
  ctl.leave();
  assert.equal(ctl.getState().report, null);
  assert.equal(ctl.getState().run, null);
});

test('subscribers hear about every change and can stop listening', () => {
  const ctl = controller('exam', async () => {});
  let heard = 0;
  const stop = ctl.subscribe(() => { heard += 1; });
  ctl.enter({ id: 'r' });
  assert.equal(heard, 1);
  stop();
  ctl.setError('x');
  assert.equal(heard, 1);
});

test('examTiming: elapsed time from startedAt, never negative, expired at the limit', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(examTiming({ startedAt: '2026-01-01T00:00:00Z' }, start + 90_000, 30 * 60_000), { startMs: start, elapsedMs: 90_000, expired: false });
  assert.equal(examTiming({ startedAt: '2026-01-01T00:00:00Z' }, start + 30 * 60_000, 30 * 60_000).expired, true);
  assert.equal(examTiming({ startedAt: '2026-01-01T00:00:00Z' }, start - 5000, 1000).elapsedMs, 0);
  assert.deepEqual(examTiming(null, start, 1000), { startMs: null, elapsedMs: 0, expired: false });
  assert.equal(examTiming({ startedAt: 'nonsense' }, start, 1000).startMs, null);
  assert.equal(examTiming({ startedAt: '2026-01-01T00:00:00Z' }, start + 10 ** 9).expired, false, 'no limit, never expired');
});

test('refreshReport re-reads the report of the run on screen and ignores a failure', async () => {
  let n = 0, fail = false;
  const { call, calls } = fakeCall({ 'exam.report': ({ runId }) => { if (fail) throw new Error('offline'); return { runId, case: { pending: 2 - ++n } }; } });
  const ctl = controller('case', call);
  ctl.showReport({ runId: 'r', case: { pending: 2 } });
  await ctl.refreshReport();
  assert.deepEqual(calls[0], ['exam.report', { runId: 'r' }]);
  assert.equal(ctl.getState().report.case.pending, 1);
  fail = true;
  await ctl.refreshReport();
  assert.equal(ctl.getState().report.case.pending, 1, 'a failed read keeps the report as it was');
  assert.equal(ctl.getState().error, '', 'and is not an error the learner needs to see');
  const idle = controller('exam', call);
  await idle.refreshReport();
  assert.equal(calls.length, 2, 'nothing to refresh without a report');
});

test('restore: onFound runs only for an answer that is still wanted, and a loading kind starts in "restoring"', async () => {
  const oral = controller('oral', async () => {});
  assert.equal(oral.getState().loading, true, 'the oral exam paints "restoring" first, never a flash of the setup card');
  const found = [];
  await oral.restore({ ids: [''], load: async () => ({ phase: 'running', run: { id: 'o' } }), onFound: (item) => found.push(item.run.id) });
  assert.deepEqual(found, ['o']);
  assert.equal(oral.getState().loading, false);
  const stale = controller('exam', async () => {});
  let release;
  const waiting = stale.restore({ ids: ['a'], load: () => new Promise((resolve) => { release = () => resolve({ phase: 'running', run: { id: 'a' } }); }), onFound: () => found.push('stale') });
  stale.begin();
  release();
  await waiting;
  assert.deepEqual(found, ['o'], 'a page that moved on is not told about the old answer');
});

test('paperTimings: the case paper reports reading, writing and transcription time from its session', () => {
  const start = Date.parse('2026-01-01T09:00:00Z');
  const session = { startedAt: '2026-01-01T09:00:00Z', readingMinutes: 10, writingMinutes: 60, transcribeMs: 4000, perQuestion: { q1: 5000 } };
  assert.deepEqual(paperTimings(session, start + 5 * 60_000), { readingMs: 5 * 60_000, writingMs: 0, transcribeMs: 4000, perQuestion: { q1: 5000 } });
  assert.deepEqual(paperTimings(session, start + 40 * 60_000), { readingMs: 10 * 60_000, writingMs: 30 * 60_000, transcribeMs: 4000, perQuestion: { q1: 5000 } });
  assert.equal(paperTimings(session, start + 999 * 60_000).writingMs, 60 * 60_000, 'never past the writing window');
  const early = { ...session, readingEndedAt: '2026-01-01T09:04:00Z', writingEndedAt: '2026-01-01T09:20:00Z' };
  assert.deepEqual(paperTimings(early, start + 30 * 60_000), { readingMs: 4 * 60_000, writingMs: 16 * 60_000, transcribeMs: 4000, perQuestion: { q1: 5000 } }, 'ending a phase early shortens it');
  assert.deepEqual(paperTimings({ ...session, transcribeMs: undefined, perQuestion: undefined }, start), { readingMs: 0, writingMs: 0, transcribeMs: 0, perQuestion: {} });
});

function Probe({ call }) {
  const run = useExamRun({ kind: 'exam', call, initialRunId: '', limitMs: 1000 });
  return React.createElement('p', null, `${run.phase}|${run.busy}|${run.expired}|${run.elapsedMs}|${typeof run.submit}|${typeof run.restore}`);
}

test('the hook renders in setup and exposes the controller verbs', () => {
  assert.equal(renderToStaticMarkup(React.createElement(Probe, { call: async () => {} })), '<p>setup|false|false|0|function|function</p>');
});

test('the three pages run on the hook: no private phase machine, interval timer, or clock function (#132 acceptance)', async () => {
  for (const file of ['ui/Exam.jsx', 'ui/CaseWorkspace.jsx', 'ui/OralExam.jsx']) {
    const source = await read(file);
    assert.match(source, /useExamRun\(/, `${file} uses the shared lifecycle`);
    assert.doesNotMatch(source, /setPhase\(/, `${file}: no own phase state machine`);
    assert.doesNotMatch(source, /setInterval\(/, `${file}: no own timer`);
    assert.doesNotMatch(source, /const (fmtClock|clock) = /, `${file}: the clock comes from formatClock`);
  }
  for (const file of ['ui/Exam.jsx', 'ui/CaseWorkspace.jsx']) assert.match(await read(file), /formatClock\(/, file);
  const hook = await read('ui/exam/useExamRun.js');
  assert.match(hook, /useNow\(/, 'timing goes through the shared clock');
  assert.match(hook, /usePolling\(/, 'report polling goes through the shared loop (paused while the page is hidden)');
  assert.doesNotMatch(hook, /setInterval\(/);
});
