import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';
import { importExample } from '../ui/json-prompts.js';

const contexts = ['system', 'notifications', 'learner', 'workflow-data', 'skeleton-data', 'materials', 'bank', 'study',
  'generation', 'audio', 'notes', 'recording', 'coach', 'workflows', 'skeleton', 'jobs', 'library', 'authoring'];
const sample = JSON.parse(importExample('flashcard'));
sample.sources = [{ id: 'source', title: 'Binary search', text: sample.cards[0].explanation }];
sample.cards[0].id = 'card';
sample.cards[0].citations = [{ sourceId: 'source', quote: sample.cards[0].explanation }];

for (const id of contexts) test(`${id} loads without the workbench and exposes only its persisted state`, async t => {
  const root = await mkdtemp(join(tmpdir(), `study-standalone-${id}-`));
  const storage = new Store(root);
  await storage.update(state => {
    state.sources = sample.sources;
    state.decks = [{ ...sample, id: 'deck' }];
    state.runs = [{ id: 'run', deckId: 'deck', mode: 'flashcard', entries: [], index: 0 }];
    state.inbox = [{ id: 'letter', kind: 'help', title: 'A saved letter' }];
    state.notes = [{ id: 'note', title: 'A saved note', markdown: 'Text', cards: [], status: 'draft' }];
    state.workflowTemplates = [{ id: 'workflow', title: 'A saved workflow' }];
    state.skeletons = [{ id: 'skeleton', title: 'A saved skeleton' }];
    state.audioResults = [{ id: 'transcript', title: 'Lecture', text: 'A retained transcription.' }];
  });
  const runtime = createStudyRuntime(root, { contexts: [id], storage });
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(runtime.describe().map(context => context.id), [id]);
  const state = await runtime.invoke(`${id}.v1`, 'state.read');
  assert.equal(state.decks?.[0].id, id === 'bank' ? 'deck' : undefined);
  assert.equal(state.sources?.length, id === 'materials' ? sample.sources.length : undefined);
  assert.equal(state.runs?.[0].id, id === 'study' ? 'run' : undefined);
  if (id === 'system') {
    await runtime.call('settings', { first_interval_days: 7 });
    assert.equal((await runtime.call('settings')).first_interval_days, 7);
  } else if (id === 'materials') {
    const source = await runtime.call('source.add', { title: 'New material', text: 'A source added by the standalone plugin.' });
    assert.ok((await runtime.invoke('materials.v1', 'state.read')).sources.some(item => item.id === source.id));
  } else if (id === 'bank') {
    await runtime.call('card.flag', { deckId: 'deck', cardId: sample.cards[0].id, reason: 'Review this question' });
    assert.equal((await runtime.call('bank.get', { deckId: 'deck' })).deck.cards[0].flag, 'Review this question');
  } else if (id === 'audio') {
    assert.equal((await runtime.call('audio.result.get', { id: 'transcript' })).text, 'A retained transcription.');
  } else if (id === 'notifications') {
    assert.equal((await runtime.call('inbox.raw'))[0].id, 'letter');
  } else if (id === 'notes') {
    assert.equal((await runtime.call('note.list')).notes[0].title, 'A saved note');
  } else if (id === 'recording') {
    const recording = await runtime.call('ingest.start', { deckTitle: 'New capture destination' });
    assert.equal(recording.active, true);
    assert.equal((await runtime.invoke('recording.v1', 'state.read')).ingest.active, true);
  } else if (id === 'coach') {
    assert.equal((await runtime.call('coach.profile')).consent, null);
  } else if (id === 'jobs') {
    assert.equal((await runtime.call('job.wait')).status, 'none');
  } else if (id === 'authoring') {
    assert.deepEqual((await runtime.call('authoring.validate', { deck: sample, sources: sample.sources })).errors, []);
  }
  runtime.disposeContext(id);
  await assert.rejects(runtime.invoke(`${id}.v1`, 'state.read'), /Capability unavailable/);
});
