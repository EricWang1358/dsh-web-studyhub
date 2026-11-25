/* Tests of the audit itself (#1468): one fixture per category, one clean fixture that must stay quiet, and the report/argument surface.
   The audit is imported, not started as a child process, so this file stays out of tests/slow-tests.json. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  auditSource,
  auditTree,
  buildSourceIndex,
  diffAgainstBaseline,
  formatAnnotations,
  maskSource,
  normalizeTitle,
  objectKeys,
  parseArgs,
  parseBaselineMarkdown,
  renderDiffReport,
  renderMarkdown,
  run,
} from '../scripts/test-audit.mjs';

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

test('parseArgs defaults, --only, --top, --json, --write, --compare-baseline and --annotations', () => {
  assert.deepEqual(parseArgs([]), {
    write: false,
    json: false,
    only: [1, 2, 3, 4, 5, 6, 7],
    top: 25,
    root: null,
    compareBaseline: null,
    annotations: false,
  });
  assert.deepEqual(parseArgs(['--only=2,1', '--top=9', '--json', '--write']).only, [1, 2]);
  assert.equal(parseArgs(['--top=9']).top, 9);
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--write']).write, true);
  assert.equal(parseArgs(['--compare-baseline']).compareBaseline, 'docs/test-audit.md');
  assert.equal(parseArgs(['--compare-baseline=custom/audit.md']).compareBaseline, 'custom/audit.md');
  assert.equal(parseArgs(['--annotations']).annotations, true);
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

test('parseBaselineMarkdown parses rendered markdown including No hits and >20 overflow items', () => {
  const overflowHits = Array.from({ length: 25 }, (_, index) => ({
    category: 1,
    file: 'tests/big.test.mjs',
    line: 10 + index,
    message: `读取源码变量 src（'lib/a.js'）后对文本片段断言 #${index}`,
  }));
  const mockResult = {
    scanned: { testFiles: 2, helperFiles: 0, testBlocks: 5 },
    totals: {
      hits: 27,
      byCategory: { 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 2, 7: 0 },
    },
    files: [
      { file: 'tests/big.test.mjs', score: 250, counts: { 1: 25 }, hits: overflowHits },
      {
        file: 'tests/consts.test.mjs',
        score: 8,
        counts: { 6: 2 },
        hits: [
          { category: 6, file: 'tests/consts.test.mjs', line: 12, message: '断言常量 MAX_ITEMS 等于它自己的定义值 7：没有行为含义' },
          { category: 6, file: 'tests/consts.test.mjs', line: 18, message: '断言常量 CONTRACT_VERSION 等于它自己的定义值 1：没有行为含义' },
        ],
      },
    ],
  };

  const markdown = renderMarkdown(mockResult, { top: 10 });
  assert.match(markdown, /No hits\./);
  assert.match(markdown, /…and 5 more in this file/);

  const parsed = parseBaselineMarkdown(markdown);
  assert.equal(parsed.totals.hits, 27);
  assert.deepEqual(parsed.totals.byCategory, { 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 2, 7: 0 });
  assert.equal(parsed.counts['tests/big.test.mjs'][1], 25);
  assert.equal(parsed.hits['tests/big.test.mjs'][1].length, 20, 'first 20 hits recorded individually');
  assert.equal(parsed.counts['tests/consts.test.mjs'][6], 2);
  assert.equal(parsed.hits['tests/consts.test.mjs'][6][0].line, 12);
  assert.equal(parsed.hits['tests/consts.test.mjs'][6][1].line, 18);

  // CRLF line endings produce the exact same result.
  const parsedCrlf = parseBaselineMarkdown(markdown.replace(/\n/g, '\r\n'));
  assert.deepEqual(parsedCrlf, parsed);
});

test('parseBaselineMarkdown parses the real docs/test-audit.md consistently', async () => {
  const realMarkdown = await readFile(new URL('../docs/test-audit.md', import.meta.url), 'utf8');
  const parsed = parseBaselineMarkdown(realMarkdown);
  for (const id of [1, 2, 3, 4, 5, 6, 7]) {
    let summed = 0;
    for (const fileCounts of Object.values(parsed.counts)) summed += fileCounts[id] ?? 0;
    assert.equal(summed, parsed.totals.byCategory[id], `category ${id} per-file counts match heading total`);
  }
});

test('diffAgainstBaseline reports ONLY newly added or increased hits and ignores unchanged/decreased files', () => {
  const baseline = parseBaselineMarkdown(renderMarkdown({
    scanned: { testFiles: 3, helperFiles: 0, testBlocks: 6 },
    totals: { hits: 5, byCategory: { 1: 3, 2: 0, 3: 0, 4: 0, 5: 0, 6: 2, 7: 0 } },
    files: [
      {
        file: 'tests/unchanged.test.mjs',
        score: 10,
        counts: { 1: 1 },
        hits: [{ category: 1, file: 'tests/unchanged.test.mjs', line: 5, message: 'hit A' }],
      },
      {
        file: 'tests/improved.test.mjs',
        score: 20,
        counts: { 1: 2 },
        hits: [
          { category: 1, file: 'tests/improved.test.mjs', line: 10, message: 'old 1' },
          { category: 1, file: 'tests/improved.test.mjs', line: 20, message: 'old 2' },
        ],
      },
      {
        file: 'tests/grew.test.mjs',
        score: 8,
        counts: { 6: 2 },
        hits: [
          { category: 6, file: 'tests/grew.test.mjs', line: 15, message: 'const A' },
          { category: 6, file: 'tests/grew.test.mjs', line: 25, message: 'const B' },
        ],
      },
    ],
  }));

  const current = {
    totals: { hits: 6, byCategory: { 1: 3, 2: 0, 3: 0, 4: 0, 5: 0, 6: 3, 7: 0 } },
    files: [
      {
        file: 'tests/unchanged.test.mjs',
        score: 10,
        counts: { 1: 1 },
        hits: [{ category: 1, file: 'tests/unchanged.test.mjs', line: 9, message: 'hit A' }],
      },
      {
        file: 'tests/improved.test.mjs',
        score: 10,
        counts: { 1: 1 },
        hits: [{ category: 1, file: 'tests/improved.test.mjs', line: 10, message: 'old 1' }],
      },
      {
        file: 'tests/grew.test.mjs',
        score: 12,
        counts: { 6: 3 },
        hits: [
          { category: 6, file: 'tests/grew.test.mjs', line: 15, message: 'const A' },
          { category: 6, file: 'tests/grew.test.mjs', line: 20, message: 'const NEW' },
          { category: 6, file: 'tests/grew.test.mjs', line: 28, message: 'const B' },
        ],
      },
      {
        file: 'tests/brand-new.test.mjs',
        score: 10,
        counts: { 1: 1 },
        hits: [{ category: 1, file: 'tests/brand-new.test.mjs', line: 4, message: 'brand new grep' }],
      },
    ],
  };

  const diff = diffAgainstBaseline(current, baseline);
  assert.equal(diff.newHits, 2);
  assert.equal(diff.removedHits, 1);
  assert.equal(diff.netDelta, 1);
  assert.equal(diff.improvedFiles, 1);
  assert.deepEqual(diff.files.map(entry => entry.file), ['tests/brand-new.test.mjs', 'tests/grew.test.mjs']);
  assert.equal(diff.files[1].hits.length, 1);
  assert.equal(diff.files[1].hits[0].line, 20, 'line-shift matching isolates the newly inserted hit');
  assert.equal(diff.files[1].hits[0].message, 'const NEW');

  const report = renderDiffReport(diff, { baselinePath: 'docs/test-audit.md' });
  assert.match(report, /advisory, non-blocking/i);
  assert.match(report, /\+2 new hit\(s\)/);
  assert.match(report, /tests\/brand-new\.test\.mjs:4/);
  assert.match(report, /tests\/grew\.test\.mjs:20/);
  assert.doesNotMatch(report, /tests\/unchanged\.test\.mjs/);
  assert.doesNotMatch(report, /tests\/improved\.test\.mjs/);

  const annotations = formatAnnotations(diff, { max: 20 });
  assert.equal(annotations.length, 2);
  assert.match(annotations[0], /^::warning file=tests\/brand-new\.test\.mjs,line=4,title=test-audit \(cat 1\)::/);
  assert.match(annotations[1], /^::warning file=tests\/grew\.test\.mjs,line=20,title=test-audit \(cat 6\)::/);
});

test('run --compare-baseline handles clean tree, newly added hits with GITHUB_STEP_SUMMARY & annotations, and missing baseline without failing', async t => {
  const root = await fixture(t, {
    'lib/cards.js': "export const MAX_ITEMS = 7;\nexport const cardOf = ({ topic }) => ({ publicCard: topic });\n",
    'docs/.keep': '',
    'tests/clean.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
test('a card keeps its topic', () => { assert.equal(cardOf({ topic: 'x' }).publicCard, 'x'); });
`,
    'tests/existing.test.mjs': `import { readFileSync } from 'node:fs';
test('existing source check', () => {
  const card = readFileSync('lib/cards.js', 'utf8');
  assert.ok(card.includes('publicCard'));
});
`,
  });

  // 1. Missing baseline -> advisory notice, exitCode remains unset / 0.
  const prevExitCode = process.exitCode;
  const missingLogs = [];
  const missingSummary = join(root, 'summary-missing.md');
  const missingRes = run(['--root=' + root, '--compare-baseline=docs/test-audit.md', '--annotations'], {
    log: line => missingLogs.push(line),
    env: { GITHUB_STEP_SUMMARY: missingSummary },
  });
  assert.equal(missingRes.baselineMissing, true);
  assert.equal(process.exitCode, prevExitCode);
  assert.match(missingLogs.join('\n'), /baseline file not found/i);
  assert.match(await readFile(missingSummary, 'utf8'), /baseline file not found/i);

  // 2. Write baseline, then compare clean tree -> 0 new hits, 1-line status, no annotations.
  run(['--root=' + root, '--write'], { log: () => {} });
  const cleanLogs = [];
  const cleanSummary = join(root, 'summary-clean.md');
  const cleanRes = run(['--root=' + root, '--compare-baseline=docs/test-audit.md', '--annotations'], {
    log: line => cleanLogs.push(line),
    env: { GITHUB_STEP_SUMMARY: cleanSummary },
  });
  assert.equal(cleanRes.diff.newHits, 0);
  assert.equal(process.exitCode, prevExitCode);
  assert.equal(cleanLogs.length, 1);
  assert.match(cleanLogs[0], /0 new low-value test hits/);
  assert.doesNotMatch(cleanLogs.join('\n'), /::warning/);
  assert.match(await readFile(cleanSummary, 'utf8'), /0 new low-value test hits/);

  // 3. Add a new low-value test -> reports only the new file, writes summary, emits ::warning, still exits 0.
  await writeFile(join(root, 'tests/regression.test.mjs'), `import { readFileSync } from 'node:fs';
test('newly added grep test', () => {
  const card = readFileSync('lib/cards.js', 'utf8');
  assert.ok(card.includes('MAX_ITEMS'));
});
`);
  const regLogs = [];
  const regSummary = join(root, 'summary-reg.md');
  const regRes = run(['--root=' + root, '--compare-baseline=docs/test-audit.md', '--annotations'], {
    log: line => regLogs.push(line),
    env: { GITHUB_STEP_SUMMARY: regSummary },
  });
  assert.equal(regRes.diff.newHits, 1);
  assert.deepEqual(regRes.diff.files.map(entry => entry.file), ['tests/regression.test.mjs']);
  assert.equal(process.exitCode, prevExitCode, 'advisory mode must never set non-zero exitCode');
  assert.match(regLogs.join('\n'), /tests\/regression\.test\.mjs:4/);
  assert.match(regLogs.join('\n'), /::warning file=tests\/regression\.test\.mjs,line=4,title=test-audit \(cat 1\)::/);
  assert.doesNotMatch(regLogs.join('\n'), /tests\/existing\.test\.mjs/);
  const summaryText = await readFile(regSummary, 'utf8');
  assert.match(summaryText, /## Test audit \(advisory, non-blocking\)/);
  assert.match(summaryText, /tests\/regression\.test\.mjs/);
});

test('diffAgainstBaseline handles >20 overflow baseline accurately and caps annotations at 20', () => {
  const baseHits = Array.from({ length: 24 }, (_, idx) => ({
    category: 1,
    file: 'tests/large.test.mjs',
    line: 10 + idx,
    message: 'existing grep pattern',
  }));
  const baseline = parseBaselineMarkdown(renderMarkdown({
    scanned: { testFiles: 1, helperFiles: 0, testBlocks: 1 },
    totals: { hits: 24, byCategory: { 1: 24, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } },
    files: [{ file: 'tests/large.test.mjs', score: 240, counts: { 1: 24 }, hits: baseHits }],
  }));

  // Same 24 hits -> 0 new hits despite markdown truncation at 20.
  const unchanged = diffAgainstBaseline({
    totals: { hits: 24, byCategory: { 1: 24, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } },
    files: [{ file: 'tests/large.test.mjs', score: 240, counts: { 1: 24 }, hits: baseHits }],
  }, baseline);
  assert.equal(unchanged.newHits, 0);

  // Add 1 brand-new hit -> delta is 1 and representative list picks the new hit.
  const withOneMore = [...baseHits, { category: 1, file: 'tests/large.test.mjs', line: 99, message: 'brand new pattern' }];
  const grew = diffAgainstBaseline({
    totals: { hits: 25, byCategory: { 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } },
    files: [{ file: 'tests/large.test.mjs', score: 250, counts: { 1: 25 }, hits: withOneMore }],
  }, baseline);
  assert.equal(grew.newHits, 1);
  assert.equal(grew.hits.length, 1);
  assert.equal(grew.hits[0].line, 99);
  assert.equal(grew.hits[0].message, 'brand new pattern');

  // 25 new hits in a new file -> formatAnnotations caps at 20.
  const manyNew = Array.from({ length: 25 }, (_, idx) => ({
    category: 6,
    file: 'tests/many.test.mjs',
    line: idx + 1,
    message: `const #${idx}`,
  }));
  const manyDiff = diffAgainstBaseline({
    totals: { hits: 49, byCategory: { 1: 24, 2: 0, 3: 0, 4: 0, 5: 0, 6: 25, 7: 0 } },
    files: [
      { file: 'tests/large.test.mjs', score: 240, counts: { 1: 24 }, hits: baseHits },
      { file: 'tests/many.test.mjs', score: 100, counts: { 6: 25 }, hits: manyNew },
    ],
  }, baseline);
  assert.equal(manyDiff.newHits, 25);
  assert.equal(formatAnnotations(manyDiff).length, 20);
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
