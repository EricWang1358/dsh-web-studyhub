import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { withQualityStages } from './helpers/assessment.mjs';

const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
const card = (id, sourceId = 'json') => ({ id, kind: 'flashcard', topic: 'Bridge', objective: `Explain dimension ${id}`,
  prompt: `Why separate report and renderer dimension ${id}?`, answer: 'They can vary independently.',
  hint: 'Consider two reasons to change.', explanation: 'Report types and rendering backends vary independently.',
  misconception: 'A subclass for every combination causes a cross product.', citations: [{ sourceId, quote: evidence }] });
async function fixture(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'study-main-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete });
  await service.store.update(s => {
    s.sources.push(
      { id: 'p1', title: 'Lecture page 1', text: evidence, courses: ['A'], createdAt: '2026-09-28T20:00:00.000Z', document: { id: 'pdf', page: 1 } },
      { id: 'p2', title: 'Lecture page 2', text: evidence, courses: ['A'], createdAt: '2026-09-28T20:00:00.000Z', document: { id: 'pdf', page: 2 } },
      { id: 'old', title: 'Old', text: evidence, courses: ['A'], createdAt: '2026-09-27T00:00:00.000Z' },
      { id: 'today', title: 'Today', text: evidence, courses: ['A'], createdAt: '2026-09-30T00:00:00.000Z' },
      { id: 'audio', title: 'Recording', text: evidence, courses: ['A'], createdAt: '2026-09-30T00:00:00.000Z', audio: { importedAt: '2026-09-28T20:00:00.000Z', batch: { id: 'batch', volume: 1 } } },
      { id: 'inferred', title: 'Legacy', text: evidence, courses: ['A'] },
      { id: 'unknown', title: 'Undated', text: evidence, courses: [] },
      { id: 'json', title: 'JSON 导入：Chapter 3', provenance: 'json-card-self-reference', text: evidence, courses: ['A'], createdAt: '2026-09-28T20:00:00.000Z' },
      { id: 'other', title: 'Other course', text: evidence, courses: ['B'], createdAt: '2026-09-28T20:00:00.000Z' });
    s.decks.push({ id: 'target', title: 'Chapter 3', course: 'A', cards: [card('original')], createdAt: '2026-09-29T00:00:00.000Z' },
      { id: 'archive', title: 'Chapter 3', course: 'A', archived: true, cards: [card('archived', 'p1')] },
      { id: 'other-deck', title: 'Chapter 3', course: 'B', cards: [card('other-card', 'other')] },
      { id: 'legacy', title: 'Old chapter', course: 'A', createdAt: '2026-09-29T00:00:00.000Z', cards: [card('legacy-card', 'inferred')] });
    s.drafts.push({ id: 'draft', title: 'Draft', course: 'A', cards: [card('draft-card', 'p2')] });
    s.attempts.push({ id: 'history', deckId: 'target', quiz_id: 'original', grade: 4 });
  });
  return service;
}

test('date constrained discovery shares exact scope, time basis and stable paging without broadening', async t => {
  const service = await fixture(t);
  const args = { importedOn: '2026-09-29', timeZone: 'Asia/Shanghai', course: 'A' };
  const first = await service.call('source.list', { ...args, limit: 2 });
  assert.equal(first.total, 4);
  assert.equal(first.filters.importedOn, '2026-09-29');
  assert.equal(first.filters.timeZone, 'Asia/Shanghai');
  assert.equal(first.dateCounts.inferred, 1);
  assert.equal(first.dateCounts.unknown, 0);
  assert.equal(first.nextOffset, 2);
  const second = await service.call('source.list', { ...args, offset: first.nextOffset, limit: 2 });
  assert.deepEqual([...first.sources, ...second.sources].map(x => x.id), ['p1', 'p2', 'audio', 'json']);
  assert.equal(second.nextOffset, null);
  const found = await service.call('source.search', { ...args, query: 'Bridge', limit: 2, offset: 2 });
  assert.equal(found.searchedSources, 4);
  assert.equal(found.matchedSources, 4);
  assert.deepEqual(found.results.map(x => x.sourceId), ['audio', 'json']);
  assert.equal(found.results[0].time.basis, 'audio.importedAt');
  assert.equal(first.sources[0].time.basis, 'createdAt');
  assert.equal((await service.call('source.get', { id: 'inferred' })).time.basis, 'inferred');
  assert.equal((await service.call('source.get', { id: 'unknown' })).time.at, null);
  assert.equal((await service.call('source.list', { ...args, timeZone: 'UTC' })).total, 0);
  assert.equal((await service.call('source.search', { query: 'Bridge', sourceIds: [] })).matchedSources, 0);
  assert.equal((await service.call('source.list', { ...args, course: 'absent' })).total, 0);
  assert.equal((await service.call('source.list', { importedFrom: '2026-09-29', importedTo: '2026-09-30', timeZone: 'Asia/Shanghai', course: 'A' })).total, 5);
  for (const bad of [{ importedOn: '2026-02-30' }, { importedOn: 'yesterday', importedFrom: '2026-09-01' },
    { importedFrom: '2026-09-30', importedTo: '2026-09-01' }, { timeZone: 'Not/AZone' }])
    await assert.rejects(service.call('source.list', bad), /date|日期|time.?zone|时区/i);
  const state = await service.call('export');
  assert.equal(state.sources.find(x => x.id === 'inferred').createdAt, undefined);
});

test('yesterday uses the requested calendar and context contracts stay bounded', async t => {
  const service = await fixture(t);
  const context = await service.call('library.context', { timeZone: 'Pacific/Kiritimati' });
  assert.equal(context.timeZone, 'Pacific/Kiritimati');
  assert.equal(context.counts.sources, 9);
  assert.ok(context.areas.includes('sources') && context.areas.includes('generation'));
  assert.ok(JSON.stringify(context).length < 6000);
  const today = new Date(`${context.today}T12:00:00Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  const result = await service.call('source.list', { importedOn: 'yesterday', timeZone: context.timeZone });
  assert.equal(result.filters.importedOn, today.toISOString().slice(0, 10));
  const contracts = await service.call('library.context', { area: 'sources' });
  assert.match(JSON.stringify(contracts), /source.coverage/);
  assert.match(JSON.stringify(contracts), /semantic|语义/);
  const generation = await service.call('library.context', { area: 'generation' });
  assert.match(JSON.stringify(generation), /mergeTargetId/);
  await assert.rejects(service.call('library.context', { area: 'nonexistent' }), /area|领域/);
});

test('document groups keep exact paged members and coverage separates self references, archive and drafts', async t => {
  const service = await fixture(t);
  const args = { importedOn: '2026-09-29', timeZone: 'Asia/Shanghai', course: 'A' };
  const list = await service.call('source.list', { ...args, groupBy: 'document', memberLimit: 1 });
  assert.equal(list.total, 3);
  const pdf = list.sources.find(x => x.group.id === 'pdf');
  assert.equal(pdf.group.kind, 'pdf');
  assert.equal(pdf.members.total, 2);
  assert.deepEqual(pdf.members.sourceIds, ['p1']);
  assert.equal(pdf.members.nextOffset, 1);
  assert.deepEqual(pdf.usedBy.map(x => [x.kind, x.id]), [['deck', 'archive'], ['draft', 'draft']]);
  const page = await service.call('source.list', { ...args, groupBy: 'document', memberOffset: 1, memberLimit: 1 });
  assert.deepEqual(page.sources.find(x => x.group.id === 'pdf').members.sourceIds, ['p2']);
  const report = await service.call('source.coverage', { ...args, deckIds: ['target'] });
  assert.equal(report.semanticCoverage, 'unassessed');
  assert.equal(report.directReferences.numerator, 0);
  assert.equal(report.directReferences.denominator, 3);
  assert.equal(report.selfReferences.sources, 1);
  assert.deepEqual(report.targets.active.map(x => x.id), ['target']);
  assert.equal(report.targets.active[0].selfCitedCards, 1);
  const all = await service.call('source.coverage', { sourceIds: ['p1', 'p2'] });
  assert.ok(all.targets.archived.some(x => x.id === 'archive'));
  assert.ok(all.targets.drafts.some(x => x.id === 'draft'));
  assert.equal(all.directReferences.numerator, 2);
  await assert.rejects(service.call('source.coverage', { deckIds: ['missing'] }), /不存在|not found/);
  assert.equal((await service.call('source.coverage', { sourceIds: [] })).directReferences.denominator, 0);
  assert.deepEqual((await service.call('card.search', { query: 'Bridge', course: 'A', deckIds: ['target'] })).results.map(x => x.cardId), ['original']);
  assert.equal((await service.call('card.search', { query: 'Bridge', deckIds: [] })).total, 0);
  assert.equal((await service.call('card.search', { query: 'Bridge', course: '' })).total, 0);
});

test('authorized supplementation generates and resumes into exact active target preserving history and prerequisites', async t => {
  const requests = [];
  let authored = 0;
  const complete = withQualityStages(async (system, prompt) => {
    if (system.startsWith('You author')) {
      const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
      requests.push(request);
      const n = ++authored;
      return JSON.stringify({ title: 'Supplement', cards: [card(`new-${n}`, 'p1')] });
    }
    return JSON.stringify({ issues: [], summary: 'Checked' });
  });
  const service = await fixture(t, complete);
  await service.call('card.link', { cardId: 'original', requires: { cardId: 'legacy-card' } });
  const schedule = { repetitions: 3, interval_days: 16, ease_factor: 2.6, due_at: '2026-10-16T00:00:00.000Z' };
  await service.store.update(s => { s.decks.find(x => x.id === 'target').cards[0].review = schedule; });
  const job = await service.call('generate', { sourceIds: ['p1'], count: 2, kind: 'flashcard', mergeTargetId: 'target', course: 'B' });
  const done = await service.call('job.wait', { jobId: job.jobId, timeoutSeconds: 5 });
  assert.equal(done.status, 'complete');
  const draft = await service.call('draft.get', { id: done.draftId });
  assert.equal(draft.mergeTargetId, 'target');
  assert.equal(draft.course, 'A');
  assert.equal(draft.editorial.generation.mergeTargetId, 'target');
  assert.match(JSON.stringify(requests[0].alreadyCovered), /original/);
  const more = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion });
  const resumed = await service.call('job.wait', { jobId: more.jobId, timeoutSeconds: 5 });
  assert.equal(resumed.status, 'complete');
  const finalDraft = await service.call('draft.get', { id: draft.id });
  assert.equal(finalDraft.cards.length, 2);
  assert.equal(finalDraft.mergeTargetId, 'target');
  const published = await service.call('draft.publish', { id: finalDraft.id, draftVersion: finalDraft.draftVersion });
  assert.equal(published.id, 'target');
  const newId = finalDraft.cards[0].id;
  await service.call('card.link', { deckId: 'target', cardId: 'original', requires: { deckId: 'target', cardId: newId } });
  const state = await service.call('export');
  const target = state.decks.find(x => x.id === 'target');
  assert.equal(target.cards.length, 3);
  assert.equal(state.decks.find(x => x.id === 'archive').cards.length, 1);
  assert.equal(target.cards[0].id, 'original');
  assert.deepEqual(target.cards[0].review, schedule);
  assert.ok(target.cards[0].requires.some(x => x.cardId === 'legacy-card'));
  assert.deepEqual(state.attempts, [{ id: 'history', deckId: 'target', quiz_id: 'original', grade: 4 }]);
  assert.equal(target.cards.find(x => x.id === newId).citations[0].sourceId, 'p1');
  assert.ok(target.cards[0].requires.some(x => x.cardId === newId));
  for (const mergeTargetId of ['missing', 'archive'])
    await assert.rejects(service.call('generate', { sourceIds: ['p1'], count: 1, mergeTargetId }), /不存在|not found|归档|普通题组/);
});

test('supplement finishes in the exact deck without a leftover draft or phase output in the parent session', async t => {
  const executions = [], notices = [];
  const model = withQualityStages(async system => system.startsWith('You author')
    ? JSON.stringify({ title: 'Supplement', cards: [card('added', 'p1')] })
    : JSON.stringify({ issues: [], summary: 'Checked' }));
  const service = await fixture(t, (system, prompt, execution) => {
    if (execution) executions.push(execution);
    return model(system, prompt);
  });
  service.notify = notice => notices.push(notice);
  const before = await service.call('export');
  const job = await service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 1, kind: 'flashcard' });
  const done = await service.call('job.wait', { jobId: job.jobId, timeoutSeconds: 5 });
  assert.equal(done.status, 'complete');
  assert.equal(done.publication.deckId, 'target');
  assert.equal(done.publication.added, 1);
  assert.equal(done.publication.total, 2);
  assert.equal(done.publication.remainingDraftId, null);
  assert.equal(done.draftId, undefined, 'published jobs must not point to a removed checkpoint');
  const after = await service.call('export');
  assert.deepEqual(after.drafts.map(d => d.id), before.drafts.map(d => d.id));
  assert.equal(after.decks.length, before.decks.length);
  assert.deepEqual(after.decks.find(d => d.id === 'target').cards[0], before.decks.find(d => d.id === 'target').cards[0]);
  assert.deepEqual(after.attempts, before.attempts);
  assert.ok(executions.length);
  assert.ok(executions.every(e => e.resultOwner === 'plugin'));
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /target/);
  assert.doesNotMatch(notices[0].text, /草稿里审阅或发布/);
});

test('supplement requires an exact active target before any model call', async t => {
  let calls = 0;
  const service = await fixture(t, async () => { calls++; return '{}'; });
  for (const deckId of [undefined, '', 'missing', 'archive'])
    await assert.rejects(service.call('supplement', { sourceIds: ['p1'], count: 1, deckId }));
  assert.equal(calls, 0);
});

test('supplement retains a checkpoint and reports failure when the target is archived during generation', async t => {
  let service;
  const model = withQualityStages(async system => {
    if (system.startsWith('You author')) {
      await service.call('deck.archive', { id: 'target', archived: true });
      return JSON.stringify({ title: 'Supplement', cards: [card('added', 'p1')] });
    }
    return JSON.stringify({ issues: [], summary: 'Checked' });
  });
  service = await fixture(t, model);
  const job = await service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 1, kind: 'flashcard' });
  const done = await service.call('job.wait', { jobId: job.jobId, timeoutSeconds: 5 });
  assert.equal(done.status, 'failed');
  assert.equal(done.publication, undefined);
  const state = await service.call('export');
  assert.equal(state.decks.find(d => d.id === 'target').cards.length, 1);
  assert.ok(state.drafts.some(d => d.id === done.draftId));
});

test('supplement refuses duplicate questions already in the target instead of reporting them as added', async t => {
  const model = withQualityStages(async system => system.startsWith('You author')
    ? JSON.stringify({ title: 'Supplement', cards: [{ ...card('original', 'p1'), id: 'copy' }] })
    : JSON.stringify({ issues: [], summary: 'Checked' }));
  const service = await fixture(t, model);
  const job = await service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 1, kind: 'flashcard' });
  const done = await service.call('job.wait', { jobId: job.jobId, timeoutSeconds: 5 });
  assert.equal(done.status, 'failed');
  assert.equal(done.publication.added, 0);
  assert.equal(done.publication.deckId, null);
  assert.equal((await service.call('export')).decks.find(d => d.id === 'target').cards.length, 1);
});

test('supplement cancellation stops publication and reports no additions', async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const model = withQualityStages(async system => {
    if (system.startsWith('You author')) {
      started(); await gate;
      return JSON.stringify({ title: 'Supplement', cards: [card('added', 'p1')] });
    }
    return JSON.stringify({ issues: [], summary: 'Checked' });
  });
  const service = await fixture(t, model);
  const job = await service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 1, kind: 'flashcard' });
  await entered;
  await service.call('job.cancel', { jobId: job.jobId });
  release();
  const done = await service.call('job.wait', { jobId: job.jobId, timeoutSeconds: 5 });
  assert.equal(done.status, 'cancelled');
  assert.equal(done.publication, undefined);
  assert.equal((await service.call('export')).decks.find(d => d.id === 'target').cards.length, 1);
});

test('partial supplementation returns the remaining checkpoint instead of the removed original draft', async t => {
  const model = withQualityStages(async system => system.startsWith('You author')
    ? JSON.stringify({ title: 'Supplement', cards: [card('added', 'p1'), { ...card('original', 'p1'), id: 'copy' }] })
    : JSON.stringify({ issues: [], summary: 'Checked' }));
  const service = await fixture(t, model);
  const job = await service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 2, kind: 'flashcard' });
  const done = await service.call('job.wait', { jobId: job.jobId, timeoutSeconds: 5 });
  assert.equal(done.status, 'complete');
  assert.equal(done.publication.added, 1);
  assert.equal(done.publication.rejected, 1);
  assert.equal(done.publication.total, 2);
  assert.equal(done.draftId, done.publication.remainingDraftId);
  assert.equal(done.draft.cards, 1);
  const state = await service.call('export');
  assert.ok(state.drafts.some(d => d.id === done.draftId));
  assert.equal(state.decks.length, 4);
});

test('strict publication keeps unreviewed questions out of the target when review fails', async t => {
  const service = await fixture(t, async () => { throw new Error('model unavailable'); });
  const draft = await service.call('draft.get', { id: 'draft' });
  const result = await service.call('draft.publish', { id: draft.id, draftVersion: draft.draftVersion,
    mergeTargetId: 'target', requireReviewed: true });
  assert.equal(result.id, null);
  assert.equal(result.accepted, 0);
  assert.equal((await service.call('export')).decks.find(d => d.id === 'target').cards.length, 1);
});

test('large catalogs stay paged, audio volumes remain grouped, and recorded/inferred/unknown timestamps stay distinct', async t => {
  const service = await fixture(t);
  await service.store.update(s => {
    s.focus = { mode: 'interview', course: 'A', role: 'Engineer', jd: 'x'.repeat(20000), targetTopics: ['Bridge'] };
    s.sources.push(...Array.from({ length: 105 }, (_, n) => ({ id: `volume-${n}`, title: `Volume ${n}`, text: evidence,
      courses: [], audio: { batch: { id: 'many', volume: n + 1 } }, createdAt: '2026-09-29T00:00:00Z' })),
    { id: 'explicit-inferred', title: 'Inferred', text: evidence, courses: [], createdAt: '2026-09-29T00:00:00Z', createdAtInferred: true },
    { id: 'imported', title: 'Recorded', text: evidence, courses: [], createdAt: '2026-09-30T00:00:00Z', importedAt: '2026-09-29T00:00:00Z' });
    s.decks.push(...Array.from({ length: 25 }, (_, n) => ({ id: `ref-${n}`, title: `Target ${n}`, course: 'A', cards: [card(`ref-card-${n}`, 'p1')] })));
  });
  const context = await service.call('library.context');
  assert.ok(JSON.stringify(context).length < 6000, 'summary does not load JD or source bodies');
  assert.equal(context.focus.course, 'A');
  const groups = await service.call('source.list', { course: '', groupBy: 'document', importedOn: '2026-09-29', timeZone: 'UTC' });
  assert.equal(groups.dateCounts.inferred, 1);
  assert.equal(groups.dateCounts.unknown, 1);
  const group = groups.sources.find(x => x.group.id === 'many');
  assert.equal(group.members.total, 105);
  assert.equal(group.members.sourceIds.length, 50);
  assert.equal(group.members.nextOffset, 50);
  const remaining = await service.call('source.list', { course: '', groupBy: 'document', memberOffset: 100 });
  assert.deepEqual(remaining.sources.find(x => x.group.id === 'many').members.sourceIds, ['volume-100', 'volume-101', 'volume-102', 'volume-103', 'volume-104']);
  const single = await service.call('source.list', { sourceIds: ['explicit-inferred', 'unknown', 'imported'], importedOn: '2026-09-29', timeZone: 'UTC' });
  assert.deepEqual(single.sources.map(x => x.id), ['imported']);
  assert.equal(single.sources[0].time.basis, 'importedAt');
  const source = await service.call('source.get', { id: 'p1', relationLimit: 2 });
  assert.equal(source.usedBy.length, 2);
  assert.equal(source.relations.total, 26);
  assert.equal(source.relations.nextOffset, 2);
  const coverage = await service.call('source.coverage', { sourceIds: ['p1'], targetLimit: 2 });
  assert.equal(coverage.targets.active.length, 2);
  assert.equal(coverage.targetPages.active.total, 28);
  assert.equal(coverage.directReferences.numerator, 1, 'full scoped count is independent of target pagination');
  assert.equal((await service.call('source.list', { sourceIds: [], importedOn: 'today' })).total, 0);
  await assert.rejects(service.call('source.get', { id: 'deleted' }), /not found/);
});
