import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { importExample } from '../ui/json-prompts.js';

async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'study-publication-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root, { complete });
}
const input = (label, course) => {
  const data = JSON.parse(importExample('flashcard'));
  data.title = label;
  data.cards[0].objective = `Explain ${label}`;
  data.cards[0].prompt = `How does ${label} work?`;
  if (course !== undefined) data.course = course;
  return data;
};
const deck = (id, course, cards = []) => ({ id, title: id, course, folder: 'Shared folder', cards });
const answer = (question) => ({ grounded: false,
  note: 'Binary search compares the midpoint of a sorted range and discards the half that cannot contain the target.',
  card: { kind: 'flashcard', topic: 'Search', objective: `Explain ${question}`, prompt: question,
    answer: 'It discards half the sorted interval.', hint: 'Consider the remaining interval.',
    explanation: 'The midpoint comparison determines which half can contain the target.',
    misconception: 'Binary search works on unsorted data.',
    citations: [{ sourceId: 'NOTE', quote: 'Binary search compares the midpoint of a sorted range' }] } });
const pasted = n => `Question ${n}: How does binary search narrow the interval? Answer: Compare the midpoint and discard one half.`;
const ingestAnswer = (text) => JSON.stringify({ items: [{ ...answer(text).card, quotes: [text], answerFrom: 'material' }], ignored: [] });

for (const action of ['draft.publish.quick', 'draft.publish', 'draft.publish.start']) {
  for (const field of ['mergeTargetId', 'deck', 'deckId']) test(`${action} honours an explicit ${field} destination at publication time`, async t => {
    const service = await setup(t);
    const old = await service.call('draft.import', { text: JSON.stringify(input('Original', 'A')) });
    await service.call('draft.publish.quick', { id: old.id, draftVersion: old.draftVersion });
    const before = await service.call('deck.get', { id: old.id });
    await service.store.update(s => s.attempts.push({ id: 'history', deckId: old.id, quiz_id: old.cards[0].id, grade: 4 }));
    const next = await service.call('draft.import', { text: JSON.stringify(input('Supplement', 'B')) });
    let result = await service.call(action, { id: next.id, draftVersion: next.draftVersion, [field]: old.id });
    if (action.endsWith('.start')) result = await service.call('job.wait', { jobId: result.jobId, timeoutSeconds: 5 });
    assert.equal(result.publishedId || result.id, old.id);
    if (!action.endsWith('.start')) {
      assert.equal(result.deckId, old.id);
      assert.equal(result.added, 1);
      assert.equal(result.total, 2);
    }
    const state = await new StudyService(service.store.root).call('export');
    assert.equal(state.decks.length, 1);
    assert.equal(state.decks[0].cards.length, 2);
    assert.equal(state.decks[0].course, 'A');
    assert.deepEqual(state.decks[0].cards[0], before.cards[0]);
    assert.equal(state.attempts[0].deckId, old.id);
    assert.equal(state.drafts.length, 0);
  });
}

test('publication rejects missing or conflicting destinations without changing the library', async t => {
  const service = await setup(t);
  const draft = await service.call('draft.import', { text: JSON.stringify(input('Supplement')) });
  await service.store.update(s => s.decks.push(deck('a', 'A'), deck('b', 'B')));
  for (const action of ['draft.publish', 'draft.publish.quick', 'draft.publish.start']) {
    const before = await service.call('export');
    for (const target of [{ deck: 'missing' }, { deck: '' }, { deck: {} }, { deck: 'a', mergeTargetId: 'b' }]) {
      await assert.rejects(service.call(action, { id: draft.id, draftVersion: draft.draftVersion, ...target }), /目标|destination|conflict/i);
      assert.deepEqual(await service.call('export'), before);
    }
  }
});

test('four supplemental drafts grow a 90-card target and return persisted totals', async t => {
  const service = await setup(t);
  const original = await service.call('draft.import', { text: JSON.stringify(input('Original', 'A')) });
  await service.call('draft.publish.quick', { id: original.id, draftVersion: original.draftVersion });
  await service.store.update(s => {
    const target = s.decks[0], seed = target.cards[0];
    target.cards = Array.from({ length: 90 }, (_, n) => ({ ...structuredClone(seed), id: `original-${n}`,
      prompt: `Original question ${n}?`, objective: `Original objective ${n}` }));
    s.attempts.push({ id: 'prior-answer', deckId: target.id, quiz_id: 'original-0', grade: 4 });
  });
  let total = 90;
  for (const [batch, count] of [8, 9, 4, 2].entries()) {
    const body = input(`Supplement ${batch}`, 'B');
    body.cards = Array.from({ length: count }, (_, n) => ({ ...structuredClone(body.cards[0]), id: `supplement-${batch}-${n}`,
      prompt: `Supplement question ${batch}/${n}?`, objective: `Supplement objective ${batch}/${n}` }));
    const draft = await service.call('draft.import', { text: JSON.stringify(body) });
    const result = await service.call('draft.publish', { id: draft.id, draftVersion: draft.draftVersion, deck: { id: original.id } });
    total += count;
    assert.equal(result.added, count); assert.equal(result.total, total); assert.equal(result.id, original.id);
    assert.equal((await new StudyService(service.store.root).call('deck.get', { id: original.id })).cards.length, total);
  }
  const state = await service.call('export');
  assert.equal(total, 113); assert.equal(state.decks.length, 1); assert.equal(state.drafts.length, 0);
  assert.equal(state.attempts[0].quiz_id, 'original-0');
});

for (const action of ['draft.publish.quick', 'draft.publish', 'draft.publish.start']) {
  test(`${action} publishes into the confirmed target and preserves its existing history`, async (t) => {
    const service = await setup(t);
    const old = await service.call('draft.import', { text: JSON.stringify(input('Original', 'A')) });
    await service.call('draft.publish.quick', { id: old.id, draftVersion: old.draftVersion });
    await service.store.update(s => s.attempts.push({ id: 'history', deckId: old.id, quiz_id: old.cards[0].id, grade: 4 }));
    const next = await service.call('draft.import', { text: JSON.stringify(input('Additional', 'B')), mergeTargetId: old.id });
    let result = await service.call(action, { id: next.id, draftVersion: next.draftVersion });
    if (action.endsWith('.start')) result = await service.call('job.wait', { jobId: result.jobId, timeoutSeconds: 5 });
    assert.equal(result.publishedId || result.id, old.id);
    const state = await service.call('export');
    assert.equal(state.decks.length, 1);
    assert.equal(state.decks[0].cards.length, 2);
    assert.equal(state.decks[0].course, 'A', 'explicit destination beats imported course');
    assert.equal(state.attempts[0].quiz_id, old.cards[0].id);
    assert.equal(state.attempts[0].deckId, old.id);
    assert.deepEqual(state.sources.map(s => s.courses), [['A'], ['A']]);
  });
}

test('partial reviewed publication repairs into the same confirmed target', async (t) => {
  const service = await setup(t);
  const old = await service.call('draft.import', { text: JSON.stringify(input('Original')), course: 'A' });
  await service.call('draft.publish.quick', { id: old.id, draftVersion: old.draftVersion });
  const body = input('Good');
  body.cards.push({ ...input('Repair').cards[0], answer: '' });
  const imported = await service.call('draft.import', { text: JSON.stringify(body), course: 'A', mergeTargetId: old.id });
  const partial = await service.call('draft.publish', { id: imported.id, draftVersion: imported.draftVersion });
  assert.equal(partial.id, old.id);
  assert.equal(partial.rejectedDraft.editorial.repairOfDeckId, old.id);
  const repaired = await service.call('draft.save', { deck: { ...partial.rejectedDraft,
    cards: partial.rejectedDraft.cards.map(card => ({ ...card, answer: 'Discard half the sorted interval.' })) } });
  const done = await service.call('draft.publish', { id: repaired.id, draftVersion: repaired.draftVersion });
  assert.equal(done.id, old.id);
  assert.equal((await service.call('export')).decks.length, 1);
  assert.equal((await service.call('deck.get', { id: old.id })).cards.length, 3);
});

test('course changes update open editing drafts and reject stale editor saves', async (t) => {
  const service = await setup(t);
  const imported = await service.call('draft.import', { text: JSON.stringify(input('Original')), course: 'A' });
  await service.call('draft.publish.quick', { id: imported.id, draftVersion: imported.draftVersion });
  const editing = await service.call('deck.edit', { id: imported.id });
  await service.call('deck.course', { id: imported.id, course: 'B' });
  await assert.rejects(service.call('draft.save', { deck: editing }), /Draft changed/);
  const refreshed = await service.call('draft.get', { id: editing.id });
  assert.equal(refreshed.course, 'B');
  await service.call('draft.publish', { id: refreshed.id, draftVersion: refreshed.draftVersion });
  assert.equal((await service.call('deck.get', { id: imported.id })).course, 'B');
});

test('JSON course and explicit unassigned survive import, while same titles stay in their own course', async (t) => {
  const service = await setup(t);
  await service.store.update(s => { s.decks.push(deck('focus', 'Focus')); s.focus = { course: 'Focus' }; });
  const imported = await service.call('draft.import', { text: JSON.stringify(input('Imported', 'Body course')) });
  assert.equal(imported.course, 'Body course');
  const unassigned = await service.call('draft.import', { text: JSON.stringify(input('Loose')), course: '' });
  assert.equal(unassigned.course, '');
  assert.deepEqual((await service.call('export')).sources.at(-1).courses, []);
  for (const course of ['A', 'B']) {
    const result = await service.call('deck.import', { text: JSON.stringify(input('Same title', course)) });
    assert.equal(result.added, 1);
  }
  const same = (await service.call('export')).decks.filter(d => d.title === 'Same title');
  assert.deepEqual(same.map(d => d.course), ['A', 'B']);
  const merged = await service.call('deck.import', { text: JSON.stringify(input('Targeted', 'C')), into: same[0].id, course: 'D' });
  assert.equal(merged.results[0].deckId, same[0].id);
  assert.equal((await service.call('deck.get', { id: same[0].id })).course, 'A');
  assert.deepEqual((await service.call('export')).sources.at(-1).courses, ['A']);
});

for (const course of ['A', '']) test(`explicit capture destination (${course || 'unassigned'}) is not replaced by a duplicate in another course`, async (t) => {
  const question = 'Why does binary search require sorted data?';
  const service = await setup(t, async () => JSON.stringify(answer(question)));
  await service.store.update(s => { s.decks.push(deck('a', course), deck('b', 'B', [{ ...answer(question).card, id: 'old' }])); s.focus = { course: 'B' }; });
  const result = await service.call('capture', { deckId: 'a', course: 'B', question });
  assert.equal(result.status, 'added');
  assert.equal(result.deckId, 'a');
  const state = await service.call('export');
  assert.equal(state.decks[1].cards.length, 1);
  assert.deepEqual(state.sources.at(-1).courses, course ? [course] : []);
  const recording = await service.call('ingest.start', { deckId: 'a', course: 'B' });
  assert.equal(recording.course, course);
});

test('queued capture keeps submitted course after focus changes', async (t) => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  const service = await setup(t, async (system, prompt) => {
    const data = JSON.parse(system.startsWith('You file') ? prompt : prompt.split('DATA:\n')[1]);
    if (first) { first = false; entered(); await gate; }
    return JSON.stringify(system.startsWith('You file')
      ? { newDeck: { title: `New ${data.question}`, folder: 'Model folder' }, topic: 'Search' }
      : answer(data.question));
  });
  await service.store.update(s => { s.decks.push(deck('a', 'A'), deck('b', 'B')); s.focus = { course: 'A' }; });
  const firstCall = service.call('capture', { question: 'First search question?' });
  await started;
  const secondCall = service.call('capture', { question: 'Second search question?' });
  await new Promise(resolve => setImmediate(resolve));
  await service.call('focus.set', { course: 'B' });
  release();
  await Promise.all([firstCall, secondCall]);
  const state = await service.call('export');
  assert.deepEqual(state.decks.slice(2).map(d => d.course), ['A', 'A']);
  assert.deepEqual(state.sources.map(s => s.courses), [['A'], ['A']]);
});

test('recording context and queued pasted source keep their chosen course and destination', async (t) => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  const service = await setup(t, async (_system, prompt) => {
    if (first) { first = false; entered(); await gate; }
    return ingestAnswer(JSON.parse(prompt.split('DATA:\n')[1]).pasted);
  });
  await service.store.update(s => { s.decks.push(deck('b', 'B')); s.focus = { course: 'B' }; });
  const mode = await service.call('ingest.start', { deckTitle: 'New A', course: 'A' });
  assert.equal(mode.course, 'A');
  const firstCall = service.call('ingest', { text: pasted(1) });
  await started;
  const secondCall = service.call('ingest', { text: pasted(2) });
  await new Promise(resolve => setImmediate(resolve));
  await service.call('ingest.start', { deckId: 'b' });
  release();
  await Promise.all([firstCall, secondCall]);
  const state = await service.call('export');
  assert.equal(state.decks.find(d => d.id === 'b').cards.length, 0);
  assert.equal(state.decks.find(d => d.title === 'New A').cards.length, 2);
  assert.deepEqual(state.sources.map(s => s.courses), [['A'], ['A']]);
  assert.equal((await service.call('ingest.status')).added, 0, 'a replacement recording does not inherit an older submission count');
});

for (const action of ['draft.publish.quick', 'draft.publish', 'draft.publish.start', 'deck.import']) {
  test(`${action} into a deck preserves the members of an active workflow`, async t => {
    const service = await setup(t);
    const original = await service.call('draft.import', { text: JSON.stringify(input('Original')) });
    await service.call('draft.publish.quick', { id: original.id, draftVersion: original.draftVersion });
    const template = await service.call('workflow.save', { title: 'Recall', steps: [{ id: 'recall', kind: 'recall', title: 'Recall' }] });
    const session = await service.call('workflow.session.start', { templateId: template.id, topic: 'Original', scope: [{ deckId: original.id }], requestId: 'original' });
    const unrelated = await service.call('workflow.session.start', { templateId: template.id, topic: 'Other', scope: [], requestId: 'other' });
    if (action === 'deck.import') {
      const result = await service.call(action, { text: JSON.stringify(input('Additional')), into: original.id });
      assert.equal(result.failed, 0, JSON.stringify(result.results));
      assert.equal(result.added, 1);
    } else {
      const next = await service.call('draft.import', { text: JSON.stringify(input('Additional')), mergeTargetId: original.id });
      const args = { id: next.id, draftVersion: next.draftVersion };
      const before = await service.call('export');
      const plan = await service.runtime.invoke('authoring.v1', 'draft.publish.plan', { ...args, quick: action === 'draft.publish.quick' });
      assert.equal(plan.expect.deckId, original.id);
      assert.deepEqual(await service.call('export'), before, 'planning does not persist cards or normalize workflow scopes');
      const result = await service.call(action, args);
      if (action.endsWith('.start')) {
        const done = await service.call('job.wait', { jobId: result.jobId, timeoutSeconds: 5 });
        assert.equal(done.status, 'complete', done.error || done.stage);
      }
    }
    const state = await new StudyService(service.store.root).call('export');
    assert.equal(state.decks.length, 1);
    assert.equal(state.decks[0].cards.length, 2);
    const saved = state.workflowSessions.find(item => item.id === session.id);
    assert.deepEqual(saved.scope, original.cards.map(card => ({ deckId: original.id, cardId: card.id })), 'new cards are not silently added to the running workflow');
    assert.equal(saved.version, session.version + 1);
    assert.deepEqual(saved.template, session.template);
    assert.deepEqual(state.workflowSessions.find(item => item.id === unrelated.id), unrelated);
  });
}
