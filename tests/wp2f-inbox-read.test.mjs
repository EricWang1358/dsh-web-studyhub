import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuickActions, markInboxRead } from '../ui/quick-actions.js';
import { openInboxResult } from '../ui/app/inbox-open.js';

// UI wave 2 · WP-F (#93): "seen means read" goes through the same quick path as 全部已读, and a letter opens by its registry row.

const inbox = () => ({ unread: 3, items: [{ id: 'a', read: false, kind: 'followup', cardId: 'c1' }, { id: 'b', read: false, kind: 'coach', cardId: 'c1' }, { id: 'c', read: false, kind: 'link', cardId: 'c2' }, { id: 'd', read: true, kind: 'note' }] });

test('全部已读 still marks everything at once', async () => {
  const calls = [];
  const quick = createQuickActions({ call: async (action, args) => { calls.push([action, args]); return {}; }, timers: false });
  markInboxRead(quick);
  const view = quick.view({ inbox: inbox() });
  assert.equal(view.inbox.unread, 0);
  assert.ok(view.inbox.items.every((item) => item.read));
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls, [['inbox.read', { all: true }]]);
});

test('letters seen on screen are marked read by id through the quick path: the badge drops at once, the rest stay unread', async () => {
  const calls = [];
  const quick = createQuickActions({ call: async (action, args) => { calls.push([action, args]); return {}; }, timers: false });
  const raw = { inbox: inbox() };
  markInboxRead(quick, { ids: ['a', 'b'] });
  const view = quick.view(raw);
  assert.equal(view.inbox.unread, 1, 'two of three unread letters were seen');
  assert.deepEqual(view.inbox.items.map((item) => item.read), [true, true, false, true]);
  assert.equal(raw.inbox.unread, 3, 'the server snapshot is never mutated');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls, [['inbox.read', { ids: ['a', 'b'] }]]);
  quick.reconcile({ inbox: { unread: 1, items: [{ id: 'a', read: true }, { id: 'b', read: true }, { id: 'c', read: false }] } });
});

test('seeing letters never drives the count below zero, and two batches do not shadow each other', async () => {
  const calls = [];
  const quick = createQuickActions({ call: async (action, args) => { calls.push(args); return {}; }, timers: false });
  markInboxRead(quick, { ids: ['a'] });
  markInboxRead(quick, { ids: ['b'] });
  const view = quick.view({ inbox: { unread: 1, items: [{ id: 'a', read: false }, { id: 'b', read: false }] } });
  assert.equal(view.inbox.unread, 0, 'clamped');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls, [{ ids: ['a'] }, { ids: ['b'] }], 'each batch is sent');
});

test('a failed mark-as-read drops the patch and keeps the message under its own key', async () => {
  const quick = createQuickActions({ call: async () => { throw new Error('host busy'); }, timers: false });
  const raw = { inbox: inbox() };
  await markInboxRead(quick, { ids: ['a'] });
  assert.equal(quick.view(raw), raw, 'the letters come back unread');
  assert.deepEqual(Object.keys(quick.failures()), ['inbox:read:a']);
});

test('the patch is confirmed by a snapshot that shows the letters read', async () => {
  const quick = createQuickActions({ call: async () => ({}), timers: false, holdMs: 60000 });
  const raw = { inbox: inbox() };
  await markInboxRead(quick, { ids: ['a'] });
  assert.notEqual(quick.view(raw), raw);
  quick.reconcile({ inbox: { unread: 2, items: [{ id: 'a', read: false }] } });
  assert.notEqual(quick.view(raw), raw, 'not yet confirmed');
  quick.reconcile({ inbox: { unread: 2, items: [{ id: 'a', read: true }] } });
  assert.equal(quick.view(raw), raw, 'confirmed, so the patch is dropped');
});

const result = (extra) => ({ id: 'r', ...extra });
const nothing = () => {};
const sink = () => {
  const log = [];
  const record = (name) => (...args) => log.push([name, ...args]);
  return { log, remember: record('remember'), showPage: record('page'), openAudioSources: record('sources'), showNote: record('note'), enterRun: record('run'),
    explain: record('explain'), detour: record('detour') };
};

test('a letter opens through its registry row: PDF and translation to Sources, audio to Sources or the audio page, a note to the notes', () => {
  for (const kind of ['pdf-result', 'pdf-failed', 'translate-result', 'translate-failed']) {
    const out = sink();
    openInboxResult({ item: { kind }, result: result({ kind: 'pdf', sourceIds: ['s1'] }), from: { runId: 'x' }, fromReview: false }, out);
    assert.deepEqual(out.log, [['remember', { runId: 'x' }], ['page', 'sources'], ['sources', ['s1']]], kind);
  }
  const noSources = sink();
  openInboxResult({ item: { kind: 'pdf-result' }, result: result({ kind: 'pdf', sourceIds: [] }), from: {}, fromReview: false }, noSources);
  assert.deepEqual(noSources.log, [['remember', {}], ['page', 'sources']], 'nothing to open: just the page');
  for (const kind of ['audio-transcribe', 'audio-result', 'audio-failed']) {
    const out = sink();
    openInboxResult({ item: { kind }, result: result({ kind: 'audio', sourceIds: ['s1'] }), from: {}, fromReview: false }, out);
    assert.deepEqual(out.log, [['remember', {}], ['page', 'sources'], ['sources', ['s1']]], kind);
  }
  const bare = sink();
  openInboxResult({ item: { kind: 'audio-failed' }, result: result({ kind: 'audio' }), from: {}, fromReview: false }, bare);
  assert.deepEqual(bare.log, [['remember', {}], ['page', 'audio']], 'a failed import has no transcript: the audio page');
  const note = sink();
  openInboxResult({ item: { kind: 'note' }, result: result({ kind: 'note', noteId: 'n1' }), from: {}, fromReview: false }, note);
  assert.deepEqual(note.log, [['remember', {}], ['note', 'n1']]);
});

test('a letter about a card opens the run, keeps the way back, and shows the explanation where the answer lives', () => {
  const plain = sink();
  openInboxResult({ item: { kind: 'coach' }, result: result({ index: 2, revealed: true }), from: { runId: 'other', index: 0 }, fromReview: false }, plain);
  assert.deepEqual(plain.log, [['run', result({ index: 2, revealed: true })], ['remember', { runId: 'other', index: 0 }]]);
  for (const kind of ['followup', 'improve', 'rewrite']) {
    const out = sink();
    openInboxResult({ item: { kind }, result: result({ revealed: true }), from: {}, fromReview: false }, out);
    assert.ok(out.log.some(([name]) => name === 'explain'), kind);
    const hidden = sink();
    openInboxResult({ item: { kind }, result: result({ revealed: false }), from: {}, fromReview: false }, hidden);
    assert.ok(!hidden.log.some(([name]) => name === 'explain'), `${kind}: nothing to show before the answer`);
  }
  const inRun = sink();
  openInboxResult({ item: { kind: 'coach' }, result: result({ id: 'r2', index: 1 }), from: { runId: 'r1', index: 3 }, fromReview: true }, inRun);
  assert.deepEqual(inRun.log.at(-1), ['detour', { runId: 'r1', index: 3 }], 'opened another question from a question: the detour');
  const same = sink();
  openInboxResult({ item: { kind: 'coach' }, result: { id: 'r1', index: 3 }, from: { runId: 'r1', index: 3 }, fromReview: true }, same);
  assert.deepEqual(same.log.map(([name]) => name), ['run'], 'the same question: nothing to come back to');
  void nothing;
});
