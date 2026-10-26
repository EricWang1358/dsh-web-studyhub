import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// The 任务 console's 删除 notice (ui/tasks/delete-notice.js) says what job.delete really removes (lib/contexts/jobs/operations.js removeLive): the working files of an
// audio import and of a PDF conversion still in the list with its 接着做 hold, and nothing of a question run but its record (its draft stays). Review of #506, round 3.
const m = await loadUi(`export { deleteNoticeText, losesWorkingFiles, keepsDraft } from './ui/tasks/delete-notice.js'; export { jobContract, archivedContract } from './lib/job-contract.js'; export { setUiLanguage } from './ui/i18n.js';`);

const at = (minute) => new Date(Date.UTC(2026, 9, 5, 10, minute)).toISOString();
const audio = { id: 'a1', type: 'audio-import', filename: 'Week 3.wav', status: 'complete', phase: 'done', startedAt: at(1), finishedAt: at(2), members: [] };
const pdf = { id: 'p1', type: 'pdf-convert', filename: 'Book.pdf', status: 'failed', retryable: true, phase: 'parse', done: 3, total: 10, startedAt: at(3) };
const archivedOf = (job) => { const contract = m.archivedContract(m.jobContract(job), at(30)); return { id: job.id, status: job.status, archived: { at: at(30) }, contract }; };
const run = { id: 'g1', status: 'failed', retryable: true, deckTitle: '复制与共识', draftId: 'draft-1', requestedTotal: 10, savedCount: 4, startedAt: at(5), finishedAt: at(6), stage: 'rate limit' };

test('an audio import loses its working copy; the notice says so and that sources, drafts and decks stay', () => {
  assert.equal(m.losesWorkingFiles(audio), true);
  const text = m.deleteNoticeText([audio]);
  assert.match(text, /^已删除「Week 3\.wav」/);
  assert.match(text, /其中 1 个任务的中间文件也会删除，之后不能接着做/);
  assert.match(text, /资料、草稿和题组不会删除$/);
});

test('a PDF conversion in the list with its 接着做 hold loses its pieces; the same conversion from the archive does not (the archive kept no hold)', () => {
  assert.equal(m.losesWorkingFiles(pdf), m.jobContract(pdf).actions.retry.available, 'the hold is what goes');
  assert.equal(m.losesWorkingFiles({ ...pdf, retryable: false, status: 'complete' }), false);
  assert.equal(m.losesWorkingFiles(archivedOf(pdf)), false);
  assert.doesNotMatch(m.deleteNoticeText([archivedOf(pdf)]), /中间文件/);
});

test('a failed question run: only its record goes, never 「之后不能接着做」; its draft stays and questions can still be added from it', () => {
  assert.equal(m.losesWorkingFiles(run), false);
  assert.equal(m.keepsDraft(run), true);
  const text = m.deleteNoticeText([run]);
  assert.doesNotMatch(text, /中间文件|不能接着做/);
  assert.match(text, /草稿还在，可以从草稿接着出题；资料和题组也不会删除$/);
  const mixed = m.deleteNoticeText([audio, run], 2);
  assert.match(mixed, /^已删除 2 个任务；跳过 2 个进行中的任务；其中 1 个任务的中间文件也会删除，之后不能接着做；草稿还在/);
});

test('English: the same facts, no Chinese left', () => {
  m.setUiLanguage('en');
  try {
    for (const text of [m.deleteNoticeText([audio]), m.deleteNoticeText([run], 1), m.deleteNoticeText([archivedOf(pdf), run])])
      assert.doesNotMatch(text.replace(/复制与共识/g, ''), /[一-鿿]/, text);
  } finally { m.setUiLanguage('zh'); }
});
