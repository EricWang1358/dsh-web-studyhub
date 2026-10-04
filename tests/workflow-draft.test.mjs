import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// #115: a guided-study step keeps its unsaved text through the shared recovery-draft format instead of its own
// localStorage code; drafts from the old format are adopted once.
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const m = await loadUi(`export * from './ui/workflow-draft.js'; export { draftKey } from './ui/writing-drafts.js';`);
const memory = () => { const map = new Map(); return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => void map.set(key, String(value)), removeItem: key => void map.delete(key) }; };
const session = { id: 's1', currentStepId: 'recall', version: 4, records: { recall: { output: 'saved text' } } };
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };

test('a kept draft comes back with the text, the saved text it was written over and the session version', () => {
  const store = memory();
  m.keepStepDraft(session, 'typing…', 'lib-a', store);
  assert.deepEqual(m.readStepDraft(session, 'lib-a', store), { output: 'typing…', base: 'saved text', version: 4 });
  assert.equal(m.readStepDraft(session, 'lib-b', store), null, 'another library has its own draft');
  assert.equal(m.readStepDraft({ ...session, currentStepId: 'other' }, 'lib-a', store), null, 'and so does another step');
});

test('the draft is stored in the shared writing-draft format (versioned, with a revision)', () => {
  const store = memory();
  m.keepStepDraft(session, 'x', 'lib-a', store);
  const [[key, raw]] = [...store.map];
  assert.equal(key, m.draftKey('lib-a', 'workflow-step', ['s1', 'recall']));
  const saved = JSON.parse(raw);
  assert.equal(saved.version, 1);
  assert.equal(typeof saved.revision, 'string');
});

test('clearing removes it, and a blocked storage never throws', () => {
  const store = memory();
  m.keepStepDraft(session, 'x', 'lib-a', store);
  m.clearStepDraft(session, 'lib-a', store);
  assert.equal(m.readStepDraft(session, 'lib-a', store), null);
  assert.doesNotThrow(() => { m.keepStepDraft(session, 'x', 'lib-a', broken); m.clearStepDraft(session, 'lib-a', broken); });
  assert.equal(m.readStepDraft(session, 'lib-a', broken), null);
});

test('a draft from the old format is adopted once and then removed', () => {
  const store = memory();
  const legacy = 'study-workflow-output:lib-a:s1:recall';
  store.setItem(legacy, JSON.stringify({ output: 'old draft', base: 'saved text', version: 3 }));
  assert.deepEqual(m.readStepDraft(session, 'lib-a', store), { output: 'old draft', base: 'saved text', version: 3 });
  assert.equal(store.map.has(legacy), false);
  assert.equal(m.readStepDraft(session, 'lib-a', store), null);
});

test('savedOutput is the recorded text of the current step', () => {
  assert.equal(m.savedOutput(session), 'saved text');
  assert.equal(m.savedOutput({ ...session, currentStepId: 'none' }), '');
});
