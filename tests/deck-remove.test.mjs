import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-remove-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(s => {
    s.sources.push({ id: 's', title: 'Source', text: 'Evidence' });
    s.decks.push({ id: 'd', title: 'Deck', cards: [{ id: 'q', kind: 'flashcard', prompt: 'Question', answer: 'Answer', citations: [{ sourceId: 's', quote: 'Evidence' }] }] });
  });
  return service;
}

test('deck removal requires archive and explicit confirmation, preserving sources and readable history', async t => {
  const service = await fixture(t);
  await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /归档/);
  const run = await service.call('review.start', { deckId: 'd', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: 'q' });
  await service.call('review.answer', { runId: run.id, cardId: 'q', grade: 4 });
  await service.call('deck.archive', { id: 'd', archived: true });
  await assert.rejects(service.call('deck.remove', { id: 'd' }), /确认/);
  await assert.rejects(service.call('deck.remove', { id: 'd', confirm: 'true' }), /确认/);
  const before = await service.call('export');
  assert.deepEqual(await service.call('deck.remove', { id: 'd', confirm: true }), { ok: true });
  const after = await service.call('export');
  assert.equal(after.decks.length, 0);
  assert.deepEqual(after.sources, before.sources);
  assert.deepEqual(after.attempts, before.attempts);
  assert.deepEqual(after.runs, before.runs);
  assert.equal((await service.call('review.get', { runId: run.id })).closed, true);
  await assert.rejects(service.call('deck.get', { id: 'd' }), /not found/i);
});

test('restoring a deck invalidates a pending permanent delete', async t => {
  const service = await fixture(t);
  await service.call('deck.archive', { id: 'd', archived: true });
  await service.call('deck.archive', { id: 'd', archived: false });
  await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /归档/);
});

test('deck deletion protects editing drafts, prerequisite links and slain-card restoration', async t => {
  for (const target of ['editingDeckId', 'mergeTargetId', 'repairOfDeckId']) {
    const service = await fixture(t);
    await service.call('deck.archive', { id: 'd', archived: true });
    await service.store.update(s => s.drafts.push({ id: 'draft', title: 'Draft', cards: [],
      ...(target === 'repairOfDeckId' ? { editorial: { repairOfDeckId: 'd' } } : { [target]: 'd' }) }));
    await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /草稿/);
    assert.equal((await service.call('export')).decks.length, 1);
  }
  const service = await fixture(t);
  await service.store.update(s => s.decks.push({ id: 'peer', title: 'Peer', cards: [{ id: 'other', kind: 'flashcard', prompt: 'Other', answer: 'A', requires: [{ deckId: 'd', cardId: 'q' }] }] }));
  await service.call('deck.archive', { id: 'd', archived: true });
  await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /前置题/);
  await service.store.update(s => { s.decks.find(d => d.id === 'peer').cards[0].requires = [{ cardId: 'q' }]; });
  await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /前置题/);
  await service.store.update(s => { s.decks.find(d => d.id === 'peer').cards[0].requires = []; });
  await service.call('card.slay', { deckId: 'd', cardId: 'q' });
  await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /斩题组/);
  const slain = (await service.call('export')).decks.find(d => d.systemKind === 'slain');
  await assert.rejects(service.call('deck.remove', { id: slain.id, confirm: true }), /系统题组/);
  await service.call('card.restore', { deckId: slain.id, cardId: 'q' });
  await service.call('deck.remove', { id: 'd', confirm: true });
});

test('active jobs prevent deleting their target deck; finished jobs do not', async t => {
  for (const field of ['deckId', 'mergeTargetId']) {
    const service = await fixture(t);
    await service.call('deck.archive', { id: 'd', archived: true });
    const job = { id: 'job', status: 'running', [field]: 'd' };
    service.runtime.work.jobs.set(job.id, job);
    for (const status of ['running', 'queued', 'cancelling']) {
      job.status = status;
      await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /后台任务/);
      assert.equal((await service.call('export')).decks.length, 1);
    }
    job.status = 'complete';
    await service.call('deck.remove', { id: 'd', confirm: true });
  }
});

test('real queued generation and publication retain their target before the first checkpoint', async t => {
  for (const action of ['generate', 'draft.publish.start']) {
    const service = await fixture(t);
    service.complete = async () => { throw new Error('Cancelled queued work must not call the model'); };
    let args;
    if (action === 'generate') args = { sourceIds: ['s'], count: 1, kind: 'flashcard', mergeTargetId: 'd' };
    else {
      await service.call('draft.save', { deck: { id: 'draft', title: 'Draft', cards: [{ id: 'new', kind: 'flashcard', topic: 'Topic', objective: 'Recall evidence', prompt: 'New', answer: 'Answer', hint: 'Recall', explanation: 'Evidence', misconception: 'Unknown', citations: [{ sourceId: 's', quote: 'Evidence' }] }] } });
      const draft = await service.call('draft.get', { id: 'draft' });
      args = { id: draft.id, draftVersion: draft.draftVersion, mergeTargetId: 'd' };
    }
    let release, jobId;
    service.runtime.work.queues.set(service.store.root, new Promise(resolve => { release = resolve; }));
    try {
      ({ jobId } = await service.call(action, args));
      await service.call('deck.archive', { id: 'd', archived: true });
      await assert.rejects(service.call('deck.remove', { id: 'd', confirm: true }), /后台任务/);
    } finally {
      if (jobId && action === 'generate') await service.call('job.cancel', { jobId });
      release();
      if (jobId) await service.call('job.wait', { jobId, timeoutSeconds: 3 });
    }
  }
});
