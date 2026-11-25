// #1436 Batch 4 Item 4:
// Deleting or archiving reference-question materials must:
// 1) Detect both deleted AND archived reference sources consistently with structured `code: 'reference-material-missing'` and Chinese user copy (no raw English)
// 2) Support explicit `allowMissingReferences: true` in `resolveQuestionReferences`, `applyReferences`, and `draft.publish.start`
// 3) Never silently ignore missing references when `allowMissingReferences` is not explicitly set (#851 guardrail preserved)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { REFERENCE_MISSING_CODE, missingReferencesError, resolveQuestionReferences } from '../lib/question-references.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { applyReferences } from '../lib/contexts/generation/generate/materials.js';

test('#1436 Item 4a: resolveQuestionReferences fails closed on a missing sample with a structured code and Chinese message; an archived sample is still usable', () => {
  assert.equal(REFERENCE_MISSING_CODE, 'reference-material-missing');
  const state = {
    sources: [
      { id: 'ref-active', title: '有效样题', text: '1. 什么是死锁？' },
      { id: 'ref-archived', title: '旧版期中样题', text: '2. 什么是分页？', archived: true },
    ],
  };

  // Missing reference -> fails closed with structured Chinese error (no bare English)
  assert.throws(
    () => resolveQuestionReferences(state, { referenceSourceIds: ['ref-deleted'] }),
    (err) => err?.code === REFERENCE_MISSING_CODE && /参考样题/.test(err.message) && !/A selected reference-question material is missing/.test(err.message),
    'missing reference must throw localized Chinese error with code reference-material-missing',
  );

  // Archived reference -> its text is still there, so it stays usable exactly as before this batch (no dead end: nothing in the UI could confirm a degrade)
  assert.deepEqual(resolveQuestionReferences(state, { referenceSourceIds: ['ref-archived'] }).map((s) => s.id), ['ref-archived']);

  // Explicit allowMissingReferences: true -> keeps the usable references (archived included) and drops only the deleted one
  const allowed = resolveQuestionReferences(state, {
    referenceSourceIds: ['ref-active', 'ref-archived', 'ref-deleted'],
    allowMissingReferences: true,
  });
  assert.deepEqual(allowed.map((s) => s.id), ['ref-active', 'ref-archived']);
});

test('#1436 Item 4b: applyReferences & draft-publish.js propagate allowMissingReferences cleanly', () => {
  const state = {
    sources: [{ id: 'src-1', title: '讲义1', text: '正文内容' }],
  };
  const request = { sourceIds: ['src-1'], referenceSourceIds: ['ref-gone'] };

  assert.throws(
    () => applyReferences({ a: {}, s: state, previous: null, request: { ...request } }),
    (err) => err?.code === REFERENCE_MISSING_CODE,
    'without allowMissingReferences, applyReferences must fail closed',
  );

  const reqAllowed = { ...request };
  applyReferences({ a: { allowMissingReferences: true }, s: state, previous: null, request: reqAllowed });
  assert.deepEqual(reqAllowed.referenceSourceIds, []);
  assert.deepEqual(reqAllowed.questionReferences, []);

  const draftPublishSrc = readFileSync(new URL('../lib/contexts/generation/draft-publish.js', import.meta.url), 'utf8');
  assert.match(draftPublishSrc, /allowMissingReferences/, 'draft-publish.js must forward allowMissingReferences to draft.publish');
});

test('#1436 Item 4c: through the real service, continuing a draft works with an archived sample, fails with a code once the sample is deleted, and proceeds with allowMissingReferences', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-1436-refs-'));
  const fake = createFakeModel({ latencyMs: 1 });
  const service = new StudyService(root, { coach: false, complete: (system, prompt, context) => fake(system, prompt, context) });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const lesson = await service.call('source.add', { title: 'Lesson', text: 'Architecture includes principles guiding design and evolution.' });
  const sample = await service.call('source.add', { title: 'Sample paper', text: 'Sample question: which architecture is always best?' });
  const started = await service.call('generate', { sourceIds: [lesson.id], referenceSourceIds: [sample.id], count: 1, kind: 'flashcard' });
  const first = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(first.status, 'complete', first.stage);
  const wantMore = async () => {
    const draft = (await service.call('export')).drafts.find((d) => d.id === first.draftId);
    return service.call('draft.save', { deck: { ...draft, editorial: { ...draft.editorial, requested: (draft.editorial.requested || 1) + 1 } } });
  };
  const resume = async (extra = {}) => {
    const saved = await wantMore();
    const next = await service.call('generate', { resumeDraftId: first.draftId, draftVersion: saved.draftVersion, ...extra });
    return service.call('job.wait', { jobId: next.jobId, timeoutSeconds: 30 });
  };

  await service.call('source.archive', { id: sample.id, archived: true });
  const withArchived = await resume();
  assert.equal(withArchived.status, 'complete', `an archived sample still has its text: ${withArchived.stage}`);

  await service.call('source.remove', { id: sample.id, confirm: true });
  const saved = await wantMore();
  await assert.rejects(
    service.call('generate', { resumeDraftId: first.draftId, draftVersion: saved.draftVersion }),
    (err) => err?.code === REFERENCE_MISSING_CODE && /参考样题/.test(err.message) && /allowMissingReferences/.test(err.message),
    'a deleted sample is refused with the code, and the message names the switch that exists today',
  );
  const allowed = await service.call('generate', { resumeDraftId: first.draftId, draftVersion: saved.draftVersion, allowMissingReferences: true });
  const done = await service.call('job.wait', { jobId: allowed.jobId, timeoutSeconds: 30 });
  assert.equal(done.status, 'complete', done.stage);
});

test('#1436 Item 4d: the missing-sample message is Chinese in the Chinese UI and English in the English UI, for generation and repair', () => {
  const generation = missingReferencesError({ missingCount: 2 });
  const repair = missingReferencesError({ missingCount: 1, archivedTitles: ['旧版样题'], task: '修题' });
  for (const err of [generation, repair]) assert.equal(err.code, REFERENCE_MISSING_CODE);
  assert.match(generation.message, /^所选参考样题资料有 2 份已被删除或内容为空，无法按原样题出题。/);
  assert.match(repair.message, /含已归档：旧版样题/);
  for (const err of [generation, repair]) {
    const english = localizeAppMessage(err.message);
    assert.ok(!/[\u4e00-\u9fff]/.test(english.replace('旧版样题', '')), `no Chinese left in: ${english}`);
    assert.match(english, /allowMissingReferences: true/);
  }
});
