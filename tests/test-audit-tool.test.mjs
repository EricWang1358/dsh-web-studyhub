/* Tests of the audit itself (#1468): one fixture per category, one clean fixture that must stay quiet, and the report/argument surface.
   The audit is imported, not started as a child process, so this file stays out of tests/slow-tests.json. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditSource, auditTree, buildSourceIndex, maskSource, normalizeTitle, objectKeys, parseArgs, run } from '../scripts/test-audit.mjs';

const INDEX = {
  fields: new Set(['publicCard', 'sourcePages', 'run', 'id', 'ok', 'error']),
  constants: new Map([['MAX_ITEMS', '7'], ['CONTRACT_VERSION', '1']]),
};
const audit = (source, extra = {}) => auditSource('tests/fixture.test.mjs', source, INDEX, extra.helpers ?? new Set());
const category = (source, id, extra) => audit(source, extra).hits.filter(hit => hit.category === id);

test('category 1: reading a program source and matching a string is a hit; reading a document is not', () => {
  const flag = category(`import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('the sidebar has a page row', () => {
  const sidebar = readFileSync('ui/app/SidebarNav.jsx', 'utf8');
  assert.ok(sidebar.includes('page-row'));
});`, 1);
  assert.equal(flag.length, 1);
  assert.match(flag[0].message, /SidebarNav/);

  const document = category(`test('the changelog has a heading', () => {
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  assert.ok(changelog.includes('## 1.0.0'));
});`, 1);
  assert.deepEqual(document, [], 'a generated document is not program source');
});

test('category 2: a fake return object whose fields the real backend never has is flagged, the known ones are not', () => {
  const hits = category(`const fakeBackend = () => ({ publicCard: { id: 'c1' }, inventedField: 1 });
test('a card is returned', () => {
  const card = fakeBackend();
  assert.equal(card.inventedField, 1);
});`, 2);
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /inventedField/);
  assert.doesNotMatch(hits[0].message, /publicCard/);
});

test('category 3: assert.ok(true), assert.equal(x, x) and a call count alone are tautologies', () => {
  const always = category(`test('always', () => { assert.ok(true); });`, 3);
  assert.equal(always.length, 1);
  const same = category(`test('same', () => { const value = 1; assert.equal(value, value); });`, 3);
  assert.equal(same.length, 1);
  const count = category(`test('called', () => {
  const spy = () => {};
  spy();
  assert.equal(spy.calls.length, 1);
});`, 3);
  assert.equal(count.length, 1);
});

test('category 4: the same test title in two files is duplicate coverage', async t => {
  const root = await fixture(t, {
    'lib/x.js': 'export const x = 1;\n',
    'tests/one.test.mjs': "test('adds a card to the deck', () => { assert.equal(add(), 1); });\n",
    'tests/two.test.mjs': "test('adds a card to the deck!', () => { assert.equal(add(), 1); });\n",
  });
  const result = await auditTree(root, { only: [4] });
  assert.equal(result.totals.byCategory[4], 2);
  assert.deepEqual(result.files.map(entry => entry.file), ['tests/one.test.mjs', 'tests/two.test.mjs']);
});

test('category 5: a test block without an assert is a hit, one that asserts through a helper is not', () => {
  const empty = category(`test('logs the card', () => { console.log('card'); });`, 5);
  assert.equal(empty.length, 1);

  const throughHelper = category(`const checkCard = card => assert.equal(card.id, 'c1');
test('holds a card', () => { const card = { id: 'c1' }; checkCard(card); });`, 5);
  assert.deepEqual(throughHelper, [], 'a local helper that asserts counts as an assertion');

  const throughImport = audit(`test('holds a card', () => { pinnedCard({ id: 'c1' }); });`, { helpers: new Set(['pinnedCard']) });
  assert.deepEqual(throughImport.hits.filter(hit => hit.category === 5), [], 'an imported helper that asserts counts too');
});

test('category 6: asserting a constant equals the literal it is declared with has no behaviour in it', () => {
  const hits = category(`test('the limit', () => { assert.equal(MAX_ITEMS, 7); });`, 6);
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /MAX_ITEMS/);
  const behaviour = category(`test('the limit is applied', () => { assert.equal(items(9).length, MAX_ITEMS); });`, 6);
  assert.deepEqual(behaviour, [], 'using the constant in a behaviour is not a constant test');
});

test('category 7: test.skip, test.todo and a skip option are counted', () => {
  const hits = category(`test.skip('a', () => { assert.ok(1); });
test.todo('b');
test('c', { skip: 'not yet' }, () => { assert.ok(1); });
test('d', () => { assert.ok(1); });`, 7);
  assert.equal(hits.length, 3);
});

test('a test that asserts a behaviour has no hits at all', () => {
  const result = audit(`import test from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from '../lib/cards.js';

test('a card keeps its topic', () => {
  assert.equal(cardOf({ topic: 'Availability' }).topic, 'Availability');
});

test('an unknown id is refused', () => {
  assert.throws(() => cardOf(null), /id/);
});`);
  assert.deepEqual(result.hits, []);
  assert.equal(result.blocks, 2);
});

test('maskSource hides code inside strings and templates but keeps positions', () => {
  const source = "const a = 'test(\\'x\\', () => { assert.ok(true) })';\nconst b = `test('y')`;\n// test('z')";
  const masked = maskSource(source);
  assert.equal(masked.length, source.length);
  assert.doesNotMatch(masked, /test\(/);
  assert.match(masked, /const a =/);
});

test('normalizeTitle folds case and punctuation; objectKeys reads one level of a literal', () => {
  assert.equal(normalizeTitle('Adds a card, twice!'), normalizeTitle('adds a card twice'));
  assert.deepEqual(objectKeys("{ id: 'c1', 'sourcePages': [], nested: { ignored: true }, method() {} }"), ['id', 'sourcePages', 'nested', 'method']);
});

test('parseArgs defaults, --only, --top, --json and --write', () => {
  assert.deepEqual(parseArgs([]), { write: false, json: false, only: [1, 2, 3, 4, 5, 6, 7], top: 25, root: null });
  assert.deepEqual(parseArgs(['--only=2,1', '--top=9', '--json', '--write']).only, [1, 2]);
  assert.equal(parseArgs(['--top=9']).top, 9);
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--write']).write, true);
  assert.throws(() => parseArgs(['--only=9']), /category/i);
});

test('auditTree scans tests/ and packages/*/tests, writes the report, and ranks the worst file first', async t => {
  const root = await fixture(t, {
    'lib/cards.js': "export const MAX_ITEMS = 7;\nexport const cardOf = ({ topic }) => ({ publicCard: topic });\n",
    'docs/.keep': '',
    'tests/clean.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
test('a card keeps its topic', () => { assert.equal(cardOf({ topic: 'x' }).publicCard, 'x'); });
`,
    'tests/dirty.test.mjs': `import { readFileSync } from 'node:fs';
test('the source mentions a card', () => {
  const card = readFileSync('lib/cards.js', 'utf8');
  assert.ok(card.includes('publicCard'));
});
test.skip('later', () => { assert.equal(MAX_ITEMS, 7); });
`,
    'packages/tui/tests/pack.test.mjs': "test('logs', () => { console.log(1); });\n",
  });
  const index = buildSourceIndex(root);
  assert.ok(index.fields.has('publicCard'));
  assert.equal(index.constants.get('MAX_ITEMS'), '7');

  const result = await auditTree(root);
  assert.equal(result.scanned.testFiles, 3);
  assert.equal(result.totals.byCategory[1], 1);
  assert.equal(result.totals.byCategory[7], 1);
  assert.equal(result.totals.byCategory[6], 1, 'assert.equal(MAX_ITEMS, 7) inside the skipped test is still a constant test');
  assert.equal(result.totals.byCategory[5], 1, 'the packages test asserts nothing');
  assert.equal(result.files[0].file, 'tests/dirty.test.mjs');

  const logged = [];
  run(['--root=' + root, '--write', '--top=5'], { log: line => logged.push(line) });
  const report = await readFile(join(root, 'docs/test-audit.md'), 'utf8');
  assert.match(report, /Test quality audit/);
  assert.match(report, /tests\/dirty\.test\.mjs:4/);
  assert.ok(logged.join('\n').includes('Report written'));
  assert.ok(existsSync(join(root, 'docs/test-audit.md')));
});

/** A throwaway checkout with the given files. */
async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'test-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}
