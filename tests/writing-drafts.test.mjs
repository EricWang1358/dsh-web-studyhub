import test from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, readDraft, writeDraft, clearDraft } from '../ui/writing-drafts.js';
import { readExamTarget } from '../ui/learning-navigation.js';
import { reviewEntryKey } from '../ui/async.js';

const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('writing survives remount by library, object and field, and a late save clears only its revision', () => {
  const storage = memory(), key = draftKey('A', 'note', 'n');
  const submitted = writeDraft(key, { markdown: 'First' }, storage);
  const newer = writeDraft(key, { markdown: 'Still typing' }, storage);
  clearDraft(key, submitted.revision, storage);
  assert.deepEqual(readDraft(key, storage), newer);
  assert.equal(readDraft(draftKey('B', 'note', 'n'), storage), null);
  const answer = draftKey('A', 'oral', ['run', 'q', 'answer']);
  writeDraft(answer, 'Answer', storage);
  assert.equal(readDraft(draftKey('A', 'oral', ['run', 'q', 'followup']), storage), null);
  clearDraft(key, undefined, storage); // Published notes remove local longform recovery too.
  assert.equal(readDraft(key, storage), null);
  assert.equal(readDraft(answer, storage).value, 'Answer');
});

test('draft write failures are visible and do not discard the last stored input', () => {
  const storage = memory(), key = draftKey('A', 'note', 'n');
  writeDraft(key, 'Saved locally', storage);
  storage.setItem = () => { throw new Error('Quota'); };
  assert.throws(() => writeDraft(key, 'Still in editor', storage), /Quota/);
  assert.equal(readDraft(key, storage).value, 'Saved locally');
});

test('explicit completed exam destinations reopen their own report', async () => {
  const result = await readExamTarget(async (action, args) => {
    assert.equal(args.runId, 'old-exam');
    return action === 'review.get' ? { id: 'old-exam', mode: 'exam', complete: true } : { runId: 'old-exam', scorePct: 70 };
  }, 'old-exam');
  assert.equal(result.report.runId, 'old-exam');
  await assert.rejects(readExamTarget(async () => { throw new Error('Exam removed'); }, 'missing'), /removed/);
});

test('unsubmitted review input belongs to the exact question version', () => {
  const run = { id: 'r', index: 6, card: { id: 'q' }, queueVersion: 2, revision: 3 };
  assert.notEqual(reviewEntryKey(run), reviewEntryKey({ ...run, index: 7 }));
  assert.notEqual(reviewEntryKey(run), reviewEntryKey({ ...run, queueVersion: 3 }));
});
