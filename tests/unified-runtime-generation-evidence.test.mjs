import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* S3-7: the rollback evidence file is a record of a drill run by hand (tests/fixtures/runtime-s37/run-drill.mjs: it needs the older version's tree), so this test does not run the drill:
   it holds the recorded numbers to what the acceptance document claims and to the properties a rollback must have. Re-run the drill and this test checks the new file. */

const DIR = new URL('../docs/plans/unified-job-runtime/', import.meta.url);
const evidence = JSON.parse(await readFile(new URL('s3-7-evidence.json', DIR), 'utf8'));
const doc = await readFile(new URL('s3-7-acceptance.md', DIR), 'utf8');
const S = evidence.scenarios;
const STABLE = ['decks', 'drafts', 'graded', 'selection'];
const pick = (view, keys = STABLE) => Object.fromEntries(keys.map(key => [key, view[key]]));
const deck = (view, id) => view.decks.find(item => item.id === id);
const draft = (view, id) => view.drafts.find(item => item.id === id);

test('the evidence names the fixed version it rolled back to, and the document says the same', () => {
  assert.equal(evidence.schema, 1);
  assert.match(evidence.rollbackSha, /^[0-9a-f]{40}$/);
  assert.ok(doc.includes(evidence.rollbackSha) && doc.includes(evidence.rollbackTag), 'the document quotes the tag and its SHA');
  assert.deepEqual(Object.keys(S), ['settled', 'generate-mid', 'repair-mid', 'publish-before', 'publish-after', 'supplement-after', 'case-grading', 'selection-review']);
  for (const name of Object.keys(S)) assert.ok(doc.includes(`\`${name}\``), `the document explains the ${name} scenario`);
  assert.ok(!/[A-Z]:[\\/]|Users/.test(JSON.stringify(evidence)), 'no local path in a committed file');
});

test('no new persistent format the older version has to understand: what the current code adds is one folder of its own, which the older version never reads', () => {
  const added = evidence.fileKinds.filter(kind => /generation-runs|job|runtime|kernel|attempt|step/i.test(kind) && !kind.includes('selectionJobs'));
  assert.deepEqual(added, ['library/generation-runs/<id>.json', 'library/generation-runs/<id>.publish-quick.json', 'library/generation-runs/<id>.publish.json']);
  for (const kind of ['library/study-workspace.json', 'library/shards/decks/<id>.<id>.json', 'library/shards/drafts/<id>.<id>.json', 'library/shards/selectionJobs/item.<id>.json']) assert.ok(evidence.fileKinds.includes(kind), kind);
});

test('finished work: the older version reads everything the current code wrote, and the current code reads it again after the rollback', () => {
  const { rolledBack, rolledForward, sameCode } = S.settled;
  const written = pick(rolledBack.prepared);
  for (const side of [rolledBack.seen, rolledForward.seen, sameCode.seen]) assert.deepEqual(pick(side), written);
  assert.equal(deck(written, 't').cards.length, 5, 'the target deck holds its card, a publication, a supplement and a passage: nothing lost');
  assert.deepEqual(written.selection, ['complete']);
  assert.deepEqual(draft(written, 'r'), { id: 'r', cards: 2, fixed: 2, rejected: [] }, 'the repaired cards are read as repaired');
  assert.deepEqual(rolledBack.seen.jobs, [], 'the older version has no job table to show: the work is in the library');
});

test('work cut short at each point of a generation: the older version sees the draft the run kept, finishes it by its own tools, and gets what the current code gets by retrying', () => {
  const { 'generate-mid': g, 'repair-mid': r } = S;
  assert.equal(draft(g.rolledBack.seen, 'written').cards, 1, 'the part that was saved is in the draft');
  assert.equal(draft(g.rolledBack.after, 'written').cards, 3, 'the older version continues the draft by 接着做');
  assert.deepEqual(pick(g.rolledBack.after), pick(g.sameCode.after), 'old and new finish into the same library state');
  assert.deepEqual(pick(g.rolledForward.seen), pick(g.rolledBack.after), 'the current code reads what the older one finished');
  assert.deepEqual(draft(r.rolledBack.seen, 'r'), { id: 'r', cards: 2, fixed: 1, rejected: ['rb'] }, 'the card that was repaired stays repaired, the other is still to do');
  assert.deepEqual(draft(r.rolledBack.after, 'r'), { id: 'r', cards: 2, fixed: 2, rejected: [] });
  assert.deepEqual(pick(r.rolledBack.after), pick(r.sameCode.after));
  assert.deepEqual(pick(r.rolledForward.seen), pick(r.rolledBack.after));
  for (const side of [g.rolledForward.seen, g.sameCode.seen, r.rolledForward.seen, r.sameCode.seen]) assert.deepEqual(side.jobs.length > 0 ? side.jobs : ['failed'], ['failed'], 'the current code shows the cut-short job as one that did not finish, never as running');
});

test('a publication cut short before its write, after it, and a supplement\'s after it: nothing is lost, nothing is written twice, in either version', () => {
  const { 'publish-before': before, 'publish-after': after, 'supplement-after': supplement } = S;
  assert.equal(deck(before.rolledBack.seen, 't').cards.length, 1);
  assert.ok(draft(before.rolledBack.seen, 'd'), 'the draft is still there, to be published');
  for (const side of [before.rolledBack.after, before.sameCode.after]) { assert.equal(deck(side, 't').cards.length, 3); assert.equal(draft(side, 'd'), undefined, 'the draft became the deck'); }
  assert.deepEqual(pick(before.rolledBack.after), pick(before.sameCode.after));
  for (const scenario of [after, supplement]) {
    const written = pick(scenario.rolledBack.seen);
    assert.equal(deck(written, 't').cards.length, 3, 'the write is in the library when the older version opens it');
    assert.deepEqual(pick(scenario.rolledForward.seen), written);
    assert.deepEqual(pick(scenario.sameCode.after), written, 'the current code\'s retry finds the write done and leaves the library exactly as the write left it');
  }
  assert.equal(draft(after.rolledBack.seen, 'd'), undefined);
  assert.deepEqual(after.rolledBack.finished, { nothingLeft: true }, 'the older version has nothing left to publish');
});

test('a case that was published and not yet graded, and a passage cut short in its review: the older version finishes them without a second import and without a second grading', () => {
  const grading = S['case-grading'], passage = S['selection-review'];
  assert.equal(grading.rolledBack.seen.decks.length, 1);
  assert.equal(grading.rolledBack.seen.graded, 0);
  for (const side of [grading.rolledBack.after, grading.sameCode.after]) { assert.equal(side.decks.length, 1, 'one case deck, not two'); assert.equal(side.graded, 2, 'each answer graded once'); }
  assert.deepEqual(pick(grading.rolledForward.seen), pick(grading.rolledBack.after));
  assert.deepEqual([passage.rolledBack.seen.selection, passage.sameCode.seen.selection], [['reviewing'], ['reviewing']], 'the record of the operation is the same to both versions');
  for (const side of [passage.rolledBack.after, passage.sameCode.after]) { assert.deepEqual(side.selection, ['complete']); assert.equal(deck(side, 't').cards.length, 2, 'one append'); }
  assert.deepEqual(pick(passage.rolledForward.seen), pick(passage.rolledBack.after));
});
