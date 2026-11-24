// #1436 Batch 4 Item 4:
// Deleting or archiving reference-question materials must:
// 1) Detect both deleted AND archived reference sources consistently with structured `code: 'reference-material-missing'` and Chinese user copy (no raw English)
// 2) Support explicit `allowMissingReferences: true` in `resolveQuestionReferences`, `applyReferences`, and `draft.publish.start`
// 3) Never silently ignore missing references when `allowMissingReferences` is not explicitly set (#851 guardrail preserved)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REFERENCE_MISSING_CODE, resolveQuestionReferences } from '../lib/question-references.js';
import { applyReferences } from '../lib/contexts/generation/generate/materials.js';

test('#1436 Item 4a: resolveQuestionReferences detects missing AND archived references with structured code and Chinese message', () => {
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

  // Archived reference -> also fails closed consistently with archived title included (no UUIDs)
  assert.throws(
    () => resolveQuestionReferences(state, { referenceSourceIds: ['ref-archived'] }),
    (err) => err?.code === REFERENCE_MISSING_CODE && err.message.includes('旧版期中样题') && !err.message.includes('ref-archived'),
    'archived reference must throw localized Chinese error naming title without raw UUID',
  );

  // Explicit allowMissingReferences: true -> keeps active references and drops missing/archived ones cleanly
  const allowed = resolveQuestionReferences(state, {
    referenceSourceIds: ['ref-active', 'ref-archived', 'ref-deleted'],
    allowMissingReferences: true,
  });
  assert.deepEqual(allowed.map((s) => s.id), ['ref-active']);
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
