import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* S4-9: the rollback evidence of the model families is a record of a drill run by hand (tests/fixtures/runtime-s49/run-drill.mjs: it needs the older version's tree), so this test does not
   run the drill: it holds the recorded results to what the document claims and to the properties a rollback must have. Re-run the drill and this test checks the new file. */

const DIR = new URL('../docs/plans/unified-job-runtime/', import.meta.url);
const evidence = JSON.parse(await readFile(new URL('s4-9-rollback-evidence.json', DIR), 'utf8'));
const doc = await readFile(new URL('s4-9-rollback.md', DIR), 'utf8');
const FAMILIES = ['recap', 'note', 'translation', 'workflow', 'assist', 'coach'];

test('the evidence names the fixed version it rolled back to, every family and both phases, and the document says the same', () => {
  assert.equal(evidence.schema, 1);
  assert.match(evidence.rollbackSha, /^[0-9a-f]{40}$/);
  assert.ok(doc.includes(evidence.rollbackSha) && doc.includes(evidence.rollbackTag), 'the document quotes the tag and its SHA');
  assert.deepEqual(Object.keys(evidence.families), FAMILIES);
  for (const family of FAMILIES) {
    assert.deepEqual(Object.keys(evidence.families[family]), ['settled', 'crash']);
    assert.ok(doc.includes(`\`${family}\``), `the document explains ${family}`);
  }
  assert.ok(!/[A-Z]:[\\/]|Users/.test(JSON.stringify(evidence)), 'no local path in a committed file');
});

test('what the current code wrote, the older version reads exactly as the current code does, in every family and phase', () => {
  for (const family of FAMILIES) for (const phase of ['settled', 'crash']) {
    const { rolledBack, rolledForward, sameCode } = evidence.families[family][phase];
    assert.deepEqual(rolledBack.seen, sameCode.seen, `${family} ${phase}: the older version shows what the current code shows of the same library`);
    assert.deepEqual(rolledForward.seen, rolledBack.after, `${family} ${phase}: the current code reads what the older version left`);
    assert.equal(rolledBack.lib, 'older'); assert.equal(sameCode.lib, 'current');
  }
});

test('the work can be started again after a rollback, and it ends in the same state whichever version does it', () => {
  for (const family of FAMILIES) for (const phase of ['settled', 'crash']) {
    const { rolledBack, sameCode } = evidence.families[family][phase];
    assert.deepEqual([rolledBack.again.outcome, sameCode.again.outcome], ['finished', 'finished'], `${family} ${phase}`);
    assert.deepEqual(rolledBack.after, sameCode.after, `${family} ${phase}: the same library state afterwards`);
  }
});

test('what a run that was still going leaves, per family: a recap reads as interrupted, a note draft and a teaching stay "running" until started again, a translation and an assistant answer left nothing', () => {
  const crash = family => evidence.families[family].crash;
  assert.equal(crash('recap').rolledBack.seen.notes[0].generation, 'interrupted', '2.7.1 reconciles the dead run of a recap');
  assert.equal(crash('note').rolledBack.seen.notes[0].generation, 'running', 'a note draft has no such check in either version: the learner starts it again');
  assert.equal(crash('workflow').rolledBack.seen.status, 'running');
  assert.equal(crash('translation').rolledBack.seen.items, 0, 'a translation writes its paragraphs as they pass; nothing had passed');
  assert.equal(crash('assist').rolledBack.seen.followups, 0);
  assert.deepEqual([crash('recap').rolledBack.after.notes[0].generation, crash('note').rolledBack.after.notes[0].generation, crash('workflow').rolledBack.after.status], ['done', 'done', 'done']);
  assert.deepEqual([crash('translation').rolledBack.after.items, crash('assist').rolledBack.after.followups], [9, 1]);
});

test('no new persistent format: the files the current code leaves are of kinds the older version already writes', () => {
  assert.deepEqual(evidence.fileKinds.filter(kind => /job|runtime|kernel|attempt|step/i.test(kind) && !/^library\/shards\/attempts\//.test(kind)), []);
  for (const kind of ['library/study-workspace.json', 'library/shards/misc/notes.<id>.json', 'library/shards/workflowSessions/<id>.<id>.json']) assert.ok(evidence.fileKinds.includes(kind), kind);
  assert.ok(!evidence.fileKinds.some(kind => kind.startsWith('home/')), 'these families write nothing under the DSH home');
});
