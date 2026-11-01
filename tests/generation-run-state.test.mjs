/* The state of a coverage run (lib/contexts/generation/run-state.js): every event, every state it may leave and every state it may not. Pure, no store and no mock.
   docs/plans/coverage-generation/run-state.md is the same table in words, with the glossary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RUN_STATES, roundList, runFacts } from '../lib/coverage-run.js';
import { closeRun, isOpenRun, transitionRunState as apply } from '../lib/contexts/generation/run-state.js';

const RUN_EVENTS = ['start', 'resume', 'round-start', 'round-finish', 'round-stopped', 'round-skip', 'fill-append', 'pause', 'unpause', 'wait', 'stop', 'usage', 'auto', 'touch', 'recover'];
const AT = '2026-11-01T00:00:00.000Z', LATER = '2026-11-01T00:00:09.000Z';
const spec = (...statuses) => ({ goal: 9, quotas: [{ sectionId: 'a', quota: 2 }], rounds: statuses.map((status, index) => ({ round: index + 1, questions: 3, sectionIds: ['a'], ...(status ? { status } : {}) })) });
const marker = (state = 'running', extra = {}) => ({ jobId: 'j', autoComplete: true, state, startedAt: AT, updatedAt: AT, tokensUsed: 5, ...extra });
const run = (state, ...statuses) => ({ marker: marker(state), spec: spec(...(statuses.length ? statuses : ['pending'])) });
const illegal = (given, event) => assert.throws(() => apply(given, event), { code: 'illegal-run-transition' }, `${event.type} from ${given.marker?.state}`);

test('start makes the marker of a new run, and only of a new run', () => {
  const { marker: made, spec: same } = apply({ marker: null, spec: spec('pending') }, { type: 'start', jobId: 'j', autoComplete: false, tokenBudget: 5000, estimate: { tokens: 1 }, at: AT });
  assert.deepEqual(made, { jobId: 'j', autoComplete: false, state: 'running', startedAt: AT, updatedAt: AT, tokensUsed: 0, tokenBudget: 5000, estimate: { tokens: 1 } });
  assert.deepEqual(same, spec('pending'));
  illegal(run('running'), { type: 'start', jobId: 'j', at: AT });
});

test('resume goes on from whatever the draft says, the same run with a new job: the tokens and the first start are kept, the last stop is forgotten', () => {
  for (const state of [...RUN_STATES, 'something-new', undefined]) {
    const { marker: made } = apply({ marker: marker(state, { stop: { reason: 'budget' }, tokenBudget: 7 }), spec: spec('done') }, { type: 'resume', jobId: 'k', autoComplete: true, at: LATER });
    assert.deepEqual(made, { jobId: 'k', autoComplete: true, state: 'running', startedAt: AT, updatedAt: LATER, tokensUsed: 5, tokenBudget: 7 });
  }
  assert.equal(apply({ marker: {}, spec: spec('done') }, { type: 'resume', jobId: 'k', at: LATER }).marker.startedAt, LATER, 'a draft without a marker starts its first');
});

test('a round starts while the run runs, one at a time; it finishes only if it was running', () => {
  const started = apply(run('running', 'done', 'pending'), { type: 'round-start', index: 1, unit: 'part', questions: 2, asked: ['a'], at: AT });
  assert.deepEqual(started.spec.rounds[1], { round: 2, questions: 2, sectionIds: ['a'], status: 'running', startedAt: AT, unit: 'part', askedKeys: ['a'] });
  assert.equal(started.marker.state, 'running');
  illegal(started, { type: 'round-start', index: 0, at: AT });
  illegal(run('paused'), { type: 'round-start', index: 0, at: AT });
  illegal(run('stopped'), { type: 'round-start', index: 0, at: AT });
  illegal(run('running'), { type: 'round-start', index: 9, at: AT });
  const finished = apply(started, { type: 'round-finish', index: 1, status: 'done', kept: 2, covered: 1, tokens: 10, ms: 20, asked: ['a'], left: new Set(), at: LATER });
  assert.deepEqual([finished.spec.rounds[1].status, finished.spec.rounds[1].kept, finished.spec.rounds[1].finishedAt, finished.spec.rounds[1].triedKeys], ['done', 2, LATER, ['a']]);
  illegal(finished, { type: 'round-finish', index: 1, status: 'done', at: LATER });
  illegal(run('running'), { type: 'round-finish', index: 0, status: 'done', at: LATER });
});

test('a pass that finished but owes sections no pass asked for leaves its round pending', () => {
  const started = apply({ marker: marker(), spec: { quotas: [{ sectionId: 'a', quota: 2 }, { sectionId: 'b', quota: 3 }], rounds: [{ round: 1, questions: 5, sectionIds: ['a', 'b'] }] } }, { type: 'round-start', index: 0, asked: ['a'], at: AT });
  const after = apply(started, { type: 'round-finish', index: 0, status: 'done', asked: ['a'], left: new Set(['b']), at: LATER });
  assert.deepEqual([after.spec.rounds[0].status, after.spec.rounds[0].questions], ['pending', 3]);
});

test('a run stopped with a round in flight: failed, or pending again when the round owes sections no pass asked for; nothing in flight, nothing changes', () => {
  const asked = { marker: marker(), spec: { rounds: [{ round: 1, status: 'running', sectionIds: ['a', 'b'], askedKeys: ['a'] }] } };
  const owing = apply(asked, { type: 'round-stopped', tokens: 5, ms: 6, reason: 'cancelled', uncovered: new Set(['b']), at: AT }).spec.rounds[0];
  assert.deepEqual([owing.status, owing.triedKeys, owing.reason, owing.kept, owing.tokens], ['pending', [], 'cancelled', 0, 5], 'the stopped pass counts nothing as tried');
  const whole = { marker: marker(), spec: { rounds: [{ round: 1, status: 'running', sectionIds: ['a'], askedKeys: ['a'] }] } };
  assert.equal(apply(whole, { type: 'round-stopped', reason: 'boom', uncovered: new Set(['a']), at: AT }).spec.rounds[0].status, 'failed');
  assert.equal(apply(whole, { type: 'round-stopped', reason: 'boom', at: AT }).spec.rounds[0].status, 'failed', 'what is left may not be known');
  const later = { marker: marker(), spec: { rounds: [{ round: 1, status: 'running', sectionIds: ['a'], askedKeys: ['a'], triedKeys: ['a'] }] } };
  assert.equal(apply(later, { type: 'round-stopped', reason: 'boom', uncovered: new Set(), at: AT }).spec.rounds[0].status, 'failed', 'with nothing left the round owes nothing');
  const idle = run('running', 'done');
  assert.deepEqual(apply(idle, { type: 'round-stopped', reason: 'boom', at: AT }), idle);
});

test('a round skipped: done if a pass of it ran or was cut short, else skipped; a round in flight is not skipped', () => {
  assert.equal(apply(run('running', 'pending'), { type: 'round-skip', index: 0 }).spec.rounds[0].status, 'skipped');
  assert.equal(apply(run('running', 'pending'), { type: 'round-skip', index: 0 }).spec.rounds[0].reason, 'covered');
  const tried = { marker: marker(), spec: { rounds: [{ round: 1, status: 'pending', triedKeys: ['a'], sectionIds: ['a'] }] } };
  assert.equal(apply(tried, { type: 'round-skip', index: 0 }).spec.rounds[0].status, 'done');
  illegal(run('running', 'running'), { type: 'round-skip', index: 0 });
});

test('a fill round is added at the end, pending', () => {
  const { spec: added } = apply(run('running', 'done'), { type: 'fill-append', keys: ['a'], questions: 2 });
  assert.deepEqual(added.rounds[1], { round: 2, questions: 2, sectionIds: ['a'], fill: true, status: 'pending' });
});

test('pause and go on: only between rounds of a run that runs', () => {
  assert.equal(apply(run('running', 'done'), { type: 'pause' }).marker.state, 'paused');
  assert.equal(apply(run('paused', 'done'), { type: 'unpause' }).marker.state, 'running');
  for (const state of ['paused', 'waiting', 'stopped', 'complete']) illegal(run(state), { type: 'pause' });
  for (const state of ['running', 'waiting', 'stopped', 'complete']) illegal(run(state), { type: 'unpause' });
  illegal(run('running', 'running'), { type: 'pause' });
});

test('wait: the round is done and the learner presses for the next', () => {
  assert.equal(apply(run('running', 'done'), { type: 'wait' }).marker.state, 'waiting');
  for (const state of ['paused', 'waiting', 'stopped', 'complete']) illegal(run(state), { type: 'wait' });
});

test('stop says why, once: a met plan is complete, anything else stopped', () => {
  for (const reason of ['complete', 'target']) assert.equal(apply(run('running', 'done'), { type: 'stop', reason, round: 1, at: AT }).marker.state, 'complete');
  for (const reason of ['learner', 'budget', 'no-progress', 'sections-left', 'refused', 'round-failed']) for (const state of ['running', 'paused', 'waiting']) {
    const { marker: made } = apply(run(state, 'done'), { type: 'stop', reason, round: 2, at: AT, extra: { left: 3 } });
    assert.deepEqual([made.state, made.stop], ['stopped', { reason, at: AT, round: 2, left: 3 }]);
  }
  illegal(run('running'), { type: 'stop', reason: 'no-such-reason', round: 1, at: AT });
  for (const state of ['stopped', 'complete']) illegal(run(state), { type: 'stop', reason: 'learner', round: 1, at: AT });
  illegal({ marker: marker('running', { stop: { reason: 'refused' } }), spec: spec('done') }, { type: 'stop', reason: 'learner', round: 1, at: AT });
});

test('what is no change of state: usage, the 自动补到完整 switch, the time of a save', () => {
  for (const state of RUN_STATES) {
    assert.equal(apply(run(state), { type: 'usage', tokensUsed: 99 }).marker.tokensUsed, 99);
    assert.equal(apply(run(state), { type: 'auto', autoComplete: false }).marker.autoComplete, false);
    assert.equal(apply(run(state), { type: 'touch', at: LATER }).marker.updatedAt, LATER);
    assert.equal(apply(run(state), { type: 'touch', at: LATER }).marker.state, state);
  }
});

test('recover is the reading of a stopped host: a round in flight is owed again, the marker stays, and doing it twice is doing it once', () => {
  const given = { marker: marker('running'), spec: { rounds: [{ round: 1, status: 'done' }, { round: 2, status: 'running', askedKeys: ['a'], triedKeys: ['a', 'b'], sectionIds: ['a', 'b'] }, { round: 3 }] } };
  const once = apply(given, { type: 'recover' }), twice = apply(once, { type: 'recover' });
  assert.deepEqual(once.spec.rounds[1], { round: 2, status: 'pending', askedKeys: ['a'], triedKeys: ['b'], sectionIds: ['a', 'b'] });
  assert.deepEqual(twice, once);
  assert.deepEqual(once.marker, given.marker);
  assert.deepEqual(apply({ marker: null, spec: undefined }, { type: 'recover' }).spec.rounds, [], 'nothing to read');
});

test('a run that wrote everything and lost its closing write is closed: rounds in flight settle, nothing else is asked', () => {
  const sections = states => ({ sections: Object.entries(states).map(([key, state]) => ({ key, state })) });
  const left = { marker: marker('running', { stop: undefined }), spec: { quotas: [{ sectionId: 'a', quota: 1 }, { sectionId: 'b', quota: 1 }], rounds: [{ round: 1, status: 'done', sectionIds: ['a'] }, { round: 2, status: 'running', sectionIds: ['b'], askedKeys: ['b'] }] } };
  const closed = closeRun(left, sections({ a: 'covered', b: 'covered' }), { jobId: 'k', at: LATER });
  assert.deepEqual(closed.spec.rounds.map(round => round.status), ['done', 'done'], 'the round in flight wrote its section: it did the work, it was not skipped');
  assert.equal(closed.spec.rounds[1].reason, undefined);
  assert.deepEqual([closed.spec.rounds[1].kept, closed.spec.rounds[1].covered, closed.spec.rounds[1].tokens], [undefined, undefined, undefined], 'what that pass kept and cost was lost with the host: unknown, never a made-up 0');
  assert.deepEqual([closed.marker.jobId, closed.marker.state, closed.marker.stop.reason, closed.marker.stop.round, closed.marker.tokensUsed], ['k', 'complete', 'complete', 2, 5], 'every round ran: what the run says when nothing cut it short');
  const allDone = { marker: marker('paused'), spec: { quotas: [{ sectionId: 'a', quota: 1 }], rounds: [{ round: 1, status: 'done', sectionIds: ['a'] }] } };
  assert.equal(closeRun(allDone, sections({ a: 'covered' }), { jobId: 'k', at: LATER }).marker.stop.reason, 'complete');
  assert.equal(closeRun(left, sections({ a: 'covered', b: 'none' }), { jobId: 'k', at: LATER }), null, 'a section still has no question');
  assert.equal(closeRun(left, sections({ a: 'covered' }), { jobId: 'k', at: LATER }), null, 'a section that is no longer in the material was not written: this is not done');
  assert.equal(closeRun({ marker: marker(), spec: { rounds: [] } }, sections({}), { jobId: 'k', at: LATER }), null, 'nothing was planned');
  assert.deepEqual(['running', 'paused', 'waiting', 'stopped', 'complete', undefined].map(state => isOpenRun({ state })), [true, true, false, false, false, false]);
  assert.equal(isOpenRun(undefined), false);
});

test('a close looks at what each round did: a round that never started is skipped and the plan met early; one from before askedKeys was kept is known by its status', () => {
  const covered = { sections: [{ key: 'a', state: 'covered' }, { key: 'b', state: 'covered' }] };
  const at = (...rounds) => ({ marker: marker('running'), spec: { quotas: [{ sectionId: 'a', quota: 1 }, { sectionId: 'b', quota: 1 }], rounds } });
  const never = closeRun(at({ round: 1, status: 'running', sectionIds: ['a'], askedKeys: ['a'] }, { round: 2, status: 'pending', sectionIds: ['b'] }), covered, { jobId: 'k', at: LATER });
  assert.deepEqual(never.spec.rounds.map(round => round.status), ['done', 'skipped']);
  assert.equal(never.spec.rounds[1].reason, 'covered');
  assert.equal(never.marker.stop.reason, 'target', 'a round that never ran was not needed: the target was met early');
  const old = closeRun(at({ round: 1, status: 'running', sectionIds: ['a', 'b'] }), covered, { jobId: 'k', at: LATER });
  assert.deepEqual([old.spec.rounds[0].status, old.marker.stop.reason], ['done', 'complete']);
  const again = closeRun(at({ round: 1, status: 'pending', sectionIds: ['a', 'b'], askedKeys: ['a', 'b'] }), covered, { jobId: 'k', at: LATER });
  assert.equal(again.spec.rounds[0].status, 'done', 'a second kill finds the round that was in flight pending, with its pass still on it');
});

test('a closed run has no pending row: a fill round in flight is settled like any other', () => {
  const covered = { sections: [{ key: 'a', state: 'covered' }] };
  const closed = closeRun({ marker: marker('running'), spec: { quotas: [{ sectionId: 'a', quota: 1 }], rounds: [{ round: 1, status: 'done', sectionIds: ['a'] }, { round: 2, status: 'running', fill: true, sectionIds: ['a'], askedKeys: ['a'] }, { round: 3, fill: true, status: 'pending', sectionIds: ['a'] }] } }, covered, { jobId: 'k', at: LATER });
  assert.deepEqual(closed.spec.rounds.map(round => round.status), ['done', 'done', 'skipped']);
  assert.equal(closed.marker.stop.reason, 'complete', 'a fill round that was not needed says nothing about the plan');
  assert.equal(runFacts({ rounds: roundList(closed.spec), run: closed.marker }).left, 0);
});

test('a close reads what a library holds: an empty row of the plan is not a mistake of the executor', () => {
  const closed = closeRun({ marker: marker('running'), spec: { quotas: [{ sectionId: 'a', quota: 1 }], rounds: [null, { round: 2, status: 'running', sectionIds: ['a'], askedKeys: ['a'] }, 7] } }, { sections: [{ key: 'a', state: 'covered' }] }, { jobId: 'k', at: LATER });
  assert.deepEqual([closed.spec.rounds.map(round => [round.round, round.status]), closed.marker.state], [[[2, 'done']], 'complete']);
});

test('a round-skip after a resume: the pass that was cut short ran, and wrote what the round asked for', () => {
  const given = { marker: marker(), spec: { rounds: [{ round: 1, status: 'pending', sectionIds: ['a'], askedKeys: ['a'] }] } };
  assert.equal(apply(given, { type: 'round-skip', index: 0 }).spec.rounds[0].status, 'done');
});

test('the function changes nothing it was given, and an event it does not know is refused', () => {
  const given = run('running', 'pending'), copy = structuredClone(given);
  apply(given, { type: 'round-start', index: 0, at: AT }); apply(given, { type: 'pause' }); apply(given, { type: 'stop', reason: 'learner', round: 1, at: AT });
  assert.deepEqual(given, copy);
  illegal(given, { type: 'explode' });
  illegal(given, { type: 'constructor' });
});

test('every event is in the table and in the document, with the glossary', async () => {
  const words = await readFile(new URL('../docs/plans/coverage-generation/run-state.md', import.meta.url), 'utf8');
  for (const event of RUN_EVENTS) assert.ok(words.includes(`\`${event}\``), `run-state.md names ${event}`);
  for (const state of RUN_STATES) assert.ok(words.includes(`\`${state}\``), `run-state.md names ${state}`);
  for (const term of ['Run', 'Round', 'Pass', 'Plan', 'Marker', 'Checkpoint', 'Job', 'Attempt', 'Manifest', 'Interrupted']) assert.match(words, new RegExp(`\\*\\*${term}\\*\\*`), `the glossary has ${term}`);
});
