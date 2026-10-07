import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* S2-7: the rollback evidence file is a record of a drill run by hand (tests/fixtures/runtime-s27/run-drill.mjs: it needs the older version's tree), so this test does not
   run the drill: it holds the recorded numbers to what the acceptance document claims and to the properties a rollback must have. Re-run the drill and this test checks the new file. */

const DIR = new URL('../docs/plans/unified-job-runtime/', import.meta.url);
const evidence = JSON.parse(await readFile(new URL('s2-7-evidence.json', DIR), 'utf8'));
const doc = await readFile(new URL('s2-7-acceptance.md', DIR), 'utf8');
const { settled, single, batch, batchAnswered, text } = evidence.scenarios;
const STABLE = ['sources', 'sourceHash', 'ids', 'closingLetters'];
const pick = (view, keys = STABLE) => Object.fromEntries(keys.map(key => [key, view[key]]));

test('the evidence names the fixed version it rolled back to, and the document says the same', () => {
  assert.equal(evidence.schema, 1);
  assert.match(evidence.rollbackSha, /^[0-9a-f]{40}$/);
  assert.ok(doc.includes(evidence.rollbackSha) && doc.includes(evidence.rollbackTag), 'the document quotes the tag and its SHA');
  assert.deepEqual(Object.keys(evidence.scenarios), ['settled', 'single', 'batch', 'batchAnswered', 'text']);
  for (const name of Object.keys(evidence.scenarios)) assert.ok(doc.includes(`\`${name}\``), `the document explains the ${name} scenario`);
  assert.ok(!/[A-Z]:[\\/]|Users/.test(JSON.stringify(evidence)), 'no local path in a committed file');
});

test('nothing the current code wrote is unreadable to the older version, in any scenario', () => {
  const unreadable = [];
  for (const [name, scenario] of Object.entries(evidence.scenarios)) for (const [side, record] of Object.entries(scenario)) {
    if (record.seen.unreadable) unreadable.push(`${name}/${side}: ${record.seen.unreadable}`);
    for (const answer of Object.values(record.finished ?? {})) if (JSON.stringify(answer).includes('invalid-store')) unreadable.push(`${name}/${side}: ${JSON.stringify(answer)}`);
  }
  assert.deepEqual(unreadable, []);
});

test('finished work: the older version reads every document and letter the current code made, and the current code reads it again after the rollback', () => {
  const written = pick(settled.rolledBack.prepared);
  assert.equal(written.sources, 5, 'a single recording, a batch, subtitles, a class save and the reviewed transcript');
  assert.deepEqual(written.closingLetters, Array(5).fill('audio-result'));
  for (const side of [settled.rolledBack.seen, settled.rolledForward.seen, settled.sameCode.seen]) assert.deepEqual(pick(side), written);
});

test('no new kind of file but one: the checkpoint files of a runtime batch, which the older version never reads', () => {
  assert.deepEqual(settled.rolledForward.fileKinds.filter(kind => !evidence.olderFileKinds.includes(kind)), ['audio-batches/<id>/checkpoints/<id>.json']);
  assert.ok(doc.includes('checkpoints/'), 'the document names the one new kind');
  assert.deepEqual(settled.rolledForward.fileKinds.filter(kind => /runtime|attempt|kernel/i.test(kind)), []);
});

test('a single recording unfinished at the rollback: both versions list it as interrupted and offer "接着做"; the older version may refuse the first clicks, and giving the file again finishes into the same document', () => {
  assert.deepEqual([single.rolledBack.seen.jobs, single.sameCode.seen.jobs], [['failed+retry'], ['failed+retry']]);
  assert.deepEqual([single.sameCode.finished.status, single.sameCode.finished.requests], ['complete', { proofread: 1, translate: 1, title: 1 }], 'the saved transcript is reused');
  assert.equal(single.rolledBack.finished.firstRefusal, 'revision-conflict', 'recorded: the retry of the older version meets its own revision conflict');
  assert.deepEqual([single.rolledBack.finished.resubmitted.status, single.rolledBack.finished.resubmittedRequests], ['complete', { proofread: 1, translate: 1, title: 1 }]);
  assert.deepEqual(pick(single.rolledBack.after, ['sources', 'sourceHash']), pick(single.sameCode.after, ['sources', 'sourceHash']), 'old and new finish into the same document');
  assert.deepEqual(pick(single.rolledForward.seen, ['sources', 'sourceHash']), pick(single.rolledBack.after, ['sources', 'sourceHash']));
  assert.ok(doc.includes('revision-conflict'), 'the document says what the learner meets');
});

test('a batch with a request in flight at the crash: the current code refuses to ask again, the older version asks again — recorded as the known difference', () => {
  assert.deepEqual([batch.sameCode.finished.refused, batch.sameCode.finished.requests, batch.sameCode.after.sources], ['remote-result-unknown', {}, 0]);
  assert.deepEqual(batch.rolledBack.seen.jobs, ['failed+retry']);
  assert.equal(batch.rolledBack.finished.status, 'complete');
  assert.equal(batch.rolledBack.finished.requests.transcribe, 1, 'the recording whose answer was unknown is transcribed again');
  assert.equal(batch.rolledBack.after.sources, 1);
  assert.ok(doc.includes('remote-result-unknown'), 'the document states the difference');
});

test('a batch whose every answer was saved: both versions finish it with no model request, into the same documents', () => {
  for (const side of [batchAnswered.rolledBack, batchAnswered.sameCode]) assert.deepEqual([side.seen.jobs, side.finished.status, side.finished.requests], [['failed+retry'], 'complete', {}]);
  assert.deepEqual(pick(batchAnswered.rolledBack.after, ['sources', 'sourceHash']), pick(batchAnswered.sameCode.after, ['sources', 'sourceHash']));
  assert.deepEqual(pick(batchAnswered.rolledForward.seen, ['sources', 'sourceHash']), pick(batchAnswered.rolledBack.after, ['sources', 'sourceHash']));
});

test('subtitles, review, class save and class correction unfinished at the rollback: no job in either version, and asking again gives the same documents', () => {
  assert.deepEqual([text.rolledBack.seen.jobs, text.sameCode.seen.jobs], [[], []], 'these paths keep nothing: the job is gone after a restart');
  for (const side of [text.rolledBack, text.sameCode]) assert.deepEqual(Object.values(side.finished).map(done => done.status ?? done.covered), ['complete', 'complete', 'complete', true]);
  assert.deepEqual(pick(text.rolledBack.after, ['sources', 'sourceHash']), pick(text.sameCode.after, ['sources', 'sourceHash']));
  assert.deepEqual(pick(text.rolledForward.seen, ['sources', 'sourceHash']), pick(text.rolledBack.after, ['sources', 'sourceHash']));
});
