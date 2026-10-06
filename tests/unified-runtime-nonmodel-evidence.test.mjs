import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* S5-7: the rollback evidence file is a record of a drill run by hand (tests/fixtures/runtime-s57/run-drill.mjs: it needs the older version's tree), so this test does not run
   the drill: it holds the recorded numbers to what the acceptance document claims and to the properties a rollback must have. Re-run the drill and this test checks the new file. */

const DIR = new URL('../docs/plans/unified-job-runtime/', import.meta.url);
const evidence = JSON.parse(await readFile(new URL('s5-7-evidence.json', DIR), 'utf8'));
const doc = await readFile(new URL('s5-7-acceptance.md', DIR), 'utf8');
const { settled, pdf, install, setup, index } = evidence.scenarios;
const STABLE = ['pages', 'pageHash', 'history', 'indexed', 'missing', 'install', 'installed'];
const pick = (view, keys = STABLE) => Object.fromEntries(keys.map(key => [key, view[key]]));

test('the evidence names the fixed version it rolled back to, and the document says the same', () => {
  assert.equal(evidence.schema, 1);
  assert.match(evidence.rollbackSha, /^[0-9a-f]{40}$/);
  assert.ok(doc.includes(evidence.rollbackSha) && doc.includes(evidence.rollbackTag), 'the document quotes the tag and its SHA');
  assert.deepEqual(Object.keys(evidence.scenarios), ['settled', 'pdf', 'install', 'setup', 'index']);
  for (const name of Object.keys(evidence.scenarios)) assert.ok(doc.includes(`\`${name}\``), `the document explains the ${name} scenario`);
  assert.ok(!/[A-Z]:[\\/]|Users/.test(JSON.stringify(evidence)), 'no local path in a committed file');
});

test('finished work: the older version reads every artifact the current code wrote, and the current code reads it again after the rollback', () => {
  const written = pick(settled.rolledBack.prepared);
  assert.equal(settled.rolledBack.seen.pages, 7, 'a Markdown book, a converted PDF, nothing lost');
  for (const side of [settled.rolledBack.seen, settled.rolledForward.seen, settled.sameCode.seen]) assert.deepEqual(pick(side), written);
  assert.equal(written.installed, true);
  assert.equal(written.missing, 0, 'the whole index is read as covered');
  assert.equal(settled.rolledBack.seen.setup, 'idle', 'a finished setup is not kept by StudyHub in either version: the tool itself says whether it is ready');
});

test('no new persistent format: the files the current code leaves are of kinds the older version already writes', () => {
  assert.deepEqual(evidence.fileKinds.filter(kind => /job|runtime|kernel|attempt|step/i.test(kind) && !/conversion-history/.test(kind)), []);
  for (const kind of ['library/conversion-history/<id>.json', 'home/study/marker-install.json', 'home/study/retrieval/manifests/<id>.json']) assert.ok(evidence.fileKinds.includes(kind), kind);
});

test('PDF conversion unfinished at the rollback: the older version lists it as interrupted, resumes it, and makes the same pages the current code makes', () => {
  assert.deepEqual(pdf.rolledBack.seen.history, ['interrupted+retry']);
  assert.deepEqual(pdf.sameCode.seen.history, ['interrupted+retry']);
  assert.equal(pdf.rolledBack.finished.pagesAdded, 120);
  assert.deepEqual(pdf.rolledBack.after, pdf.sameCode.after, 'old and new finish into the same library state (page count and page hash)');
  const keys = STABLE.filter(key => key !== 'history');
  assert.deepEqual(pick(pdf.rolledForward.seen, keys), pick(pdf.rolledBack.after, keys), 'the current code reads what the older one finished');
  assert.equal(pdf.rolledBack.after.pages, pdf.rolledBack.seen.pages + 120, 'the pages are added once');
});

test('Marker install, MinerU setup and index build unfinished at the rollback: each is "not done" in both versions and finishes by starting it again', () => {
  assert.deepEqual([install.rolledBack.seen.install, install.sameCode.seen.install], ['interrupted', 'interrupted']);
  assert.deepEqual([install.rolledBack.finished.status, install.rolledBack.after.installed, install.rolledForward.seen.installed], ['complete', true, true]);
  assert.deepEqual([setup.rolledBack.seen.setup, setup.sameCode.seen.setup], ['idle', 'idle'], 'nothing kept: not "running", not "ready"');
  assert.equal(setup.rolledBack.finished.status, 'complete');
  assert.deepEqual([index.rolledBack.seen.indexed, index.sameCode.seen.indexed], [0, 0], 'a half-built index is not counted as built');
  assert.deepEqual([index.rolledBack.finished.indexed, index.rolledForward.seen.indexed], [4, 4]);
  for (const scenario of [install, setup, index]) assert.deepEqual(scenario.rolledBack.after.history, scenario.sameCode.after.history);
});
