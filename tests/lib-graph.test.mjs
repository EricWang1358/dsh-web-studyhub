import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ALLOW_LIST_FILE, ALLOW_LIST_PATH, REFRESH_COMMAND, REPORT_FILE, allowListProblems, allowListText, classify, importEdges, opaqueUiImports, parseAllowList, reachesLibOpaquely, reportText,
  trackedFiles, uiLibImports,
} from '../scripts/qa/lib-graph.mjs';

/* #902 S1 and S3. ui/ may import only the lib modules on tests/fixtures/ui-lib-allow-list.txt, and docs/lib-classification.md is what the code says now
   about who uses each top-level lib module. Both files are written by `npm run lib-graph`; the pattern is the case-study facts snapshot
   (tests/case-study.test.mjs): compare the committed copy with what the code gives, fail with the command that rewrites it. */
// A Windows checkout with core.autocrlf turns the committed LF into CRLF on disk; the generator writes LF, and so does the repository.
const read = (file) => { try { return readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const files = trackedFiles();
const edges = await importEdges(files);
const imports = uiLibImports(edges);

test('the allow-list is exactly the lib modules ui/ imports today, static and dynamic, in both directions', () => {
  assert.deepEqual(allowListProblems(imports, parseAllowList(read(ALLOW_LIST_FILE)), opaqueUiImports(edges)), []);
});

test('the allow-list file is the one `npm run lib-graph` writes (sorted, LF, the same header)', () => {
  // Its own entries in the canonical form: a stray comment or blank line is caught here, a wrong entry is the test above.
  assert.equal(read(ALLOW_LIST_FILE), allowListText(parseAllowList(read(ALLOW_LIST_FILE))), `${ALLOW_LIST_PATH} is not in the form ${REFRESH_COMMAND} writes`);
});

test('the scan sees dynamic imports, and nothing that is only a comment or build output', () => {
  const dynamic = [...imports].filter(([, users]) => users.some(({ kind }) => kind === 'dynamic')).map(([target]) => target);
  assert.ok(dynamic.includes('lib/chemistry-balance.js') && dynamic.includes('lib/symbolic-proof.js'), 'ScienceSettings loads these two with import()');
  assert.ok(![...imports.keys()].some((target) => /^lib\/client(?:\.|\/)/.test(target)), 'lib/client*.js is build output');
  assert.ok(![...imports.keys()].includes('lib/types.js'), 'lib/types.js is named only in JSDoc type comments');
});

test('an import that is not on the list fails the check and names the list, the file and the way to add it', () => {
  // A fixed picture, not the live graph: a real violation fails the first test only.
  const synthetic = new Map([['lib/brand-new.js', [{ from: 'ui/Thing.jsx', kind: 'static' }, { from: 'ui/Thing.jsx', kind: 'static' }]], ['lib/known.js', [{ from: 'ui/A.jsx', kind: 'static' }]],
    ['lib/lazy-new.js', [{ from: 'ui/Lazy.jsx', kind: 'dynamic' }]]]);
  const problems = allowListProblems(synthetic, ['lib/known.js']);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^ui\/Thing\.jsx \(import\) imports lib\/brand-new\.js,/, 'a file that imports it twice is named once');
  assert.match(problems[0], /ui\/Thing\.jsx \(import\) imports lib\/brand-new\.js, which is not in tests\/fixtures\/ui-lib-allow-list\.txt/);
  assert.match(problems[1], /ui\/Lazy\.jsx \(dynamic import\(\)\) imports lib\/lazy-new\.js/);
  assert.match(problems[0], /add it: run `npm run lib-graph` and commit the change to tests\/fixtures\/ui-lib-allow-list\.txt; the review then sees the new coupling/);
});

test('an entry that nothing imports any more, or an unsorted list, fails too', () => {
  const fixed = new Map([['lib/a.js', [{ from: 'ui/A.jsx', kind: 'static' }]], ['lib/z.js', [{ from: 'ui/Z.jsx', kind: 'static' }]]]);
  const [stale, ...rest] = allowListProblems(fixed, ['lib/a.js', 'lib/gone.js', 'lib/z.js']);
  assert.match(stale, /^lib\/gone\.js is in tests\/fixtures\/ui-lib-allow-list\.txt but no ui file imports it any more\. To drop the entry, run `npm run lib-graph`/);
  assert.deepEqual(rest, []);
  assert.match(allowListProblems(fixed, ['lib/a.js', 'lib/z.js', 'lib/gone.js']).join('\n'), /sorted/, 'lib/gone.js is out of order');
  assert.deepEqual(allowListProblems(new Map([['lib/a.js', []], ['lib/b.js', []]]), ['lib/b.js', 'lib/a.js']).length, 1);
});

test('the bundler scan of a scratch repository finds a new static import, a new dynamic import, and ignores comments', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lib-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  put('lib/known.js', 'export const known = 1;\n');
  put('lib/fresh.js', 'export const fresh = 1;\n');
  put('lib/lazy.js', 'export const lazy = 1;\n');
  put('lib/only-in-comment.js', 'export const none = 1;\n');
  put('ui/A.jsx', "import { known } from '../lib/known.js';\nexport const A = () => <b>{known}</b>;\n");
  put('ui/B.jsx', "import { fresh } from '../lib/fresh.js';\n/** @typedef {import('../lib/only-in-comment.js').X} X */\n// import { z } from '../lib/only-in-comment.js';\nexport const B = fresh;\n");
  put('ui/C.js', "export const load = () => import('../lib/lazy.js');\n");
  const scratch = ['lib/known.js', 'lib/fresh.js', 'lib/lazy.js', 'lib/only-in-comment.js', 'ui/A.jsx', 'ui/B.jsx', 'ui/C.js'];
  const found = uiLibImports(await importEdges(scratch, root));
  assert.deepEqual([...found].map(([target, users]) => [target, users.map(({ from, kind }) => `${from} ${kind}`)]),
    [['lib/fresh.js', ['ui/B.jsx static']], ['lib/known.js', ['ui/A.jsx static']], ['lib/lazy.js', ['ui/C.js dynamic']]]);
  const problems = allowListProblems(found, ['lib/known.js']);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /ui\/B\.jsx \(import\) imports lib\/fresh\.js[\s\S]*ui\/C\.js \(dynamic import\(\)\) imports lib\/lazy\.js/);
});

test('trackedFiles counts what git tracks, not what is on the disk, and says so when git cannot answer', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lib-graph-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, '.gitignore'), 'lib/client*.js\n');
  for (const file of ['package.json', 'lib/a.js', 'lib/client.js', 'lib/client.chunk.js', 'lib/untracked.js']) writeFileSync(join(root, file), '{}\n');
  git('add', '.gitignore', 'package.json', 'lib/a.js');
  assert.deepEqual(trackedFiles(root).sort(), ['.gitignore', 'lib/a.js', 'package.json']);
  assert.throws(() => trackedFiles(root, 'git-that-does-not-exist'), /git is not installed or not on PATH[\s\S]*cannot run without git/);
  const bare = mkdtempSync(join(tmpdir(), 'lib-graph-nogit-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.throws(() => trackedFiles(bare), /git ls-files failed/);
});

test('classify puts a module in the first class that fits, from direct imports only', () => {
  const edge = (from, to) => ({ from, to, kind: 'static' });
  const lib = ['lib/ui-used.js', 'lib/shared.js', 'lib/solo.js', 'lib/deep.js', 'lib/cyc-a.js', 'lib/cyc-b.js', 'lib/orphan.js', 'lib/runtime/r.js'];
  const rows = Object.fromEntries(classify(lib, [
    edge('ui/A.jsx', 'lib/ui-used.js'), edge('lib/contexts/bank/x.js', 'lib/ui-used.js'),
    edge('lib/contexts/bank/x.js', 'lib/shared.js'), edge('lib/contexts/study/y.js', 'lib/shared.js'),
    edge('lib/contexts/bank/x.js', 'lib/solo.js'),
    edge('lib/contexts/study/y.js', 'lib/cyc-a.js'), edge('lib/cyc-a.js', 'lib/cyc-b.js'), edge('lib/cyc-b.js', 'lib/cyc-a.js'),
    edge('lib/contexts/bank/x.js', 'lib/runtime/r.js'), edge('lib/runtime/r.js', 'lib/deep.js'),
    edge('lib/orphan.js', 'lib/orphan.js'), edge('lib/index.js', 'lib/orphan.js'),
  ]).map((row) => [row.module, row]));
  assert.equal(rows['lib/ui-used.js'].class, 'ui');
  assert.equal(rows['lib/shared.js'].class, 'several');
  assert.equal(rows['lib/solo.js'].class, 'one');
  assert.deepEqual([rows['lib/deep.js'].class, rows['lib/deep.js'].lib], ['none', 1], 'imported only by lib/runtime/r.js: a helper of a helper is not a context user');
  assert.deepEqual([rows['lib/cyc-a.js'].class, rows['lib/cyc-a.js'].contexts, rows['lib/cyc-a.js'].lib], ['one', ['study'], 1]);
  assert.deepEqual([rows['lib/cyc-b.js'].class, rows['lib/cyc-b.js'].lib], ['none', 1], 'an import cycle is no problem');
  assert.deepEqual([rows['lib/orphan.js'].class, rows['lib/orphan.js'].lib], ['none', 1], 'its own import does not count, lib/index.js does');
});

test('the classification report is what the code says now: run `npm run lib-graph` after adding, moving or importing a lib module', () => {
  const committed = read(REPORT_FILE);
  assert.equal(committed, reportText(files, edges), `docs/lib-classification.md is out of date. Run \`${REFRESH_COMMAND}\`, read the diff and commit it with the change that moved a module.`);
});

test('the report is stable and complete: every tracked top-level lib module once, counts add up, no date or absolute path', () => {
  const text = reportText(files, edges), modules = files.filter((file) => /^lib\/[^/]+\.js$/.test(file));
  const listed = [...text.matchAll(/^- `(lib\/[^`]+)`/gm)].map((match) => match[1]);
  assert.deepEqual([...listed].sort(), [...modules].sort());
  assert.equal(new Set(listed).size, listed.length);
  const counts = [...text.matchAll(/^\| Used by [^|]+\| (\d+) \|$/gm)].map((match) => Number(match[1]));
  assert.equal(counts.length, 4);
  assert.equal(counts.reduce((sum, n) => sum + n, 0), modules.length);
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\\|\r|\b20\d\d-\d\d-\d\d\b|[一-鿿]/, 'LF only, no absolute path, date or Han character');
  assert.ok(!allowListText([...imports.keys()]).includes('\r'));
  assert.equal(reportText(files, edges), text, 'two runs give the same text');
});

function scratchRepository(t, sources) {
  const root = mkdtempSync(join(tmpdir(), 'lib-graph-scratch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(sources)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
  return { root, files: Object.keys(sources) };
}

test('an import of lib through a template, a concatenation or the package name is a problem of its own, not silence', async (t) => {
  const { root, files: scratch } = scratchRepository(t, {
    'lib/one.js': 'export const one = 1;\n',
    'lib/service.js': 'export const service = 1;\n',
    'ui/locales/en.json': '{}\n',
    'ui/locales.js':'export const load = (l) => import(`./locales/${l}.json`);\n',
    'ui/Template.js': 'export const load = (n) => import(`../lib/${n}.js`);\n',
    'ui/Concat.js': "export const load = (n) => import('../lib/' + n + '.js');\n",
    'ui/Package.js': "export const load = () => import('@ericwang1358/dsh-daily-flashcard/service');\n",
    'ui/Plain.js': "export const load = () => import('../lib/one.js');\n",
    'ui/External.js': "import React from 'react';\nexport const R = React;\n",
  });
  const found = await importEdges(scratch, root);
  const opaque = opaqueUiImports(found);
  assert.deepEqual(opaque.map(({ from }) => from), ['ui/Concat.js', 'ui/Package.js', 'ui/Template.js'], 'the plain import, react and a pattern into ui/ are not opaque');
  const problems = allowListProblems(uiLibImports(found), ['lib/one.js'], opaque);
  assert.equal(problems.length, 3);
  for (const problem of problems) assert.match(problem, /^ui\/\w+\.js imports lib through a pattern or the package name \(`.+`\); import the module by its relative path so the allow-list can see it\.$/);
  assert.match(problems[2], /ui\/Template\.js .*`\.\.\/lib\/\*\*\/\*\.js`/, 'the metafile spells the template as a pattern');
});

test('which unresolved imports can reach lib/: patterns that may land there, relative paths into it, the package itself', () => {
  const reaches = (from, path) => reachesLibOpaquely(from, path, '@scope/pkg');
  assert.ok(reaches('ui/a.js', '../lib/**/*.js') && reaches('ui/deep/a.js', '../../lib/*.js') && reaches('ui/a.js', '../*/x.js') && reaches('ui/a.js', '../**'));
  assert.ok(reaches('ui/a.js', '@scope/pkg') && reaches('ui/a.js', '@scope/pkg/service') && reaches('ui/a.js', '../lib/x.js'));
  assert.ok(!reaches('ui/a.js', './locales/*.json') && !reaches('ui/a.js', '../locale/*.json') && !reaches('ui/a.js', 'react') && !reaches('ui/a.js', '@scope/pkg-other'));
});

test('TypeScript and CommonJS files are read too, and a file type the bundler cannot read fails the scan instead of being skipped', async (t) => {
  const { root, files: scratch } = scratchRepository(t, {
    'lib/store.js': 'export const store = 1;\n',
    'lib/other.js': 'export const other = 1;\n',
    'ui/Typed.ts': "import { store } from '../lib/store.js';\nexport const typed: number = store;\n",
    'ui/View.tsx': "import { other } from '../lib/other.js';\nexport const View = () => <b>{other}</b>;\n",
  });
  assert.deepEqual([...uiLibImports(await importEdges(scratch, root))].map(([target, users]) => [target, users.map(({ from }) => from)]),
    [['lib/other.js', ['ui/View.tsx']], ['lib/store.js', ['ui/Typed.ts']]]);
  const cjs = scratchRepository(t, { 'lib/store.js': 'exports.store = 1;\n', 'ui/Old.cjs': "const { store } = require('../lib/store.js');\nmodule.exports = store;\n" });
  assert.deepEqual([...uiLibImports(await importEdges(cjs.files, cjs.root)).keys()], ['lib/store.js']);
  const odd = scratchRepository(t, { 'lib/store.js': 'export const store = 1;\n', 'ui/Odd.mjsx': "import '../lib/store.js';\n" });
  await assert.rejects(() => importEdges(odd.files, odd.root), /No loader is configured/);
});

test('a file that imports a module twice counts once in the report', () => {
  const edge = (from, to) => ({ from, to, kind: 'static' });
  const [row] = classify(['lib/x.js'], [edge('ui/A.jsx', 'lib/x.js'), edge('ui/A.jsx', 'lib/x.js'), edge('ui/B.jsx', 'lib/x.js'), edge('lib/y.js', 'lib/x.js'), edge('lib/y.js', 'lib/x.js')]);
  assert.deepEqual([row.ui, row.lib], [2, 1]);
});
