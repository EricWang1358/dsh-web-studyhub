/* The import graph of ui/ and lib/ (#902), read from the code with the bundler the way tests/architecture-boundaries.test.mjs does:
   comments and strings never count, static and dynamic imports both do, and only git-tracked files are looked at (lib/client*.js is build
   output, ignored by git, and must not count). Three things stand on it: the ui -> lib allow-list (tests/fixtures/ui-lib-allow-list.txt),
   the ceiling on top-level lib files (tests/lib-top-level.test.mjs) and the classification report (docs/lib-classification.md).
   Rebuild both committed files with one command:  npm run lib-graph          (check only: node scripts/qa/lib-graph.mjs --check) */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ALLOW_LIST_FILE = join(ROOT, 'tests/fixtures/ui-lib-allow-list.txt');
export const REPORT_FILE = join(ROOT, 'docs/lib-classification.md');
export const REFRESH_COMMAND = 'npm run lib-graph';
export const ALLOW_LIST_PATH = 'tests/fixtures/ui-lib-allow-list.txt';
// Every extension the bundler reads as code (js, jsx, mjs, cjs, ts, tsx, mts, cts). A tracked file of a shape this lets through but the bundler has no loader for
// makes the scan throw instead of skipping the file: the scan fails closed.
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const PACKAGE_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;

/** The files git tracks (never the disk: build output and local files do not count). Fails loudly when git cannot answer. */
export function trackedFiles(root = ROOT, git = 'git') {
  let out;
  try { out = execFileSync(git, ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    throw new Error(`git ls-files failed (${error.code === 'ENOENT' ? 'git is not installed or not on PATH' : String(error.stderr || error.message).trim()}). `
      + 'This check counts git-tracked files, not the disk, so it cannot run without git in a git checkout.');
  }
  const files = out.split('\0').filter(Boolean);
  if (!files.includes('package.json')) throw new Error('git ls-files did not list package.json: run this from a normal checkout of the repository.');
  return files;
}

/** Every tracked top-level lib/*.js file, sorted. */
export const topLevelLib = (files) => files.filter((file) => /^lib\/[^/]+\.js$/.test(file)).sort();

/** An import the bundler could not resolve to one file but that may reach lib/: a pattern (a template or a concatenation: `../lib/**\/*.js`), a relative path into lib/,
 *  or this package under its own name (its exports map to lib/ files). The allow-list cannot see where these land, so a ui file may not have one. */
export function reachesLibOpaquely(from, path, packageName = PACKAGE_NAME) {
  if (path === packageName || path.startsWith(`${packageName}/`)) return true;
  if (!path.startsWith('.')) return false;
  const target = posix.normalize(posix.join(posix.dirname(from), path)), star = target.indexOf('*');
  if (star < 0) return /^lib(?:\/|$)/.test(target);
  const head = target.slice(0, star); // what is fixed before the first wildcard: the pattern can land in lib/ unless that already points elsewhere
  return 'lib/'.startsWith(head) || head.startsWith('lib/');
}

/** { from, to, kind } for every import of a tracked ui/ or lib/ source file that lands on another tracked ui/ or lib/ source file.
 *  A ui/ import that the bundler leaves external but that reaches lib/ opaquely (see reachesLibOpaquely) is an edge of kind 'opaque' whose `to` is the path as written. */
export async function importEdges(files = trackedFiles(), root = ROOT) {
  const sources = files.filter((file) => SOURCE.test(file) && /^(?:ui|lib)\//.test(file)).sort();
  const known = new Set(sources);
  // One bundle from one stdin that imports every file: each file is read once; no output is written.
  const { metafile } = await build({
    stdin: { contents: sources.map((file) => `import ${JSON.stringify(`./${file}`)};`).join('\n'), resolveDir: root, loader: 'js' },
    absWorkingDir: root, bundle: true, write: false, platform: 'neutral', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent',
    outdir: join(root, 'lib-graph-unused-output'), loader: { '.js': 'jsx', '.css': 'text', '.woff2': 'empty', '.json': 'json' },
  });
  const edges = [];
  for (const [from, input] of Object.entries(metafile.inputs)) {
    if (!known.has(from)) continue;
    for (const imported of input.imports) {
      if (imported.external && from.startsWith('ui/') && reachesLibOpaquely(from, imported.path)) edges.push({ from, to: imported.path, kind: 'opaque' });
      if (imported.external || !known.has(imported.path)) continue;
      edges.push({ from, to: imported.path, kind: imported.kind === 'dynamic-import' ? 'dynamic' : 'static' });
    }
  }
  return edges;
}

/** The lib modules ui/ imports, with who imports them: Map(target -> [{ from, kind }]), sorted by target. */
export function uiLibImports(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!edge.from.startsWith('ui/') || !edge.to.startsWith('lib/')) continue;
    map.set(edge.to, [...(map.get(edge.to) ?? []), { from: edge.from, kind: edge.kind }]);
  }
  return new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const HEADER = [
  '# The lib modules that ui/ imports, static and dynamic (#902). One path per line, sorted.',
  '# This list is a picture of the code, not a permission slip that nobody reads: a ui file importing a lib module that is not here fails',
  '# tests/lib-graph.test.mjs, and so does a line here that no ui file imports any more. The scan reads git-tracked files: `git add` a new file',
  '# before the check sees it on your machine (CI always sees it).',
  `# To add or drop an entry run \`${REFRESH_COMMAND}\` and commit the diff; the reviewer sees the new coupling there.`,
];
export const allowListText = (targets) => `${[...HEADER, ...targets].join('\n')}\n`;
export const parseAllowList = (text) => text.replace(/\r\n/g, '\n').split('\n').filter((line) => line && !line.startsWith('#'));

/** The ui/ imports that reach lib/ in a way the list cannot see (see reachesLibOpaquely): [{ from, to }] from importEdges, sorted. */
export const opaqueUiImports = (edges) => edges.filter((edge) => edge.kind === 'opaque').map(({ from, to }) => ({ from, to })).sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));

/** What is wrong between the imports found in the code (Map from uiLibImports, plus the opaque ones from opaqueUiImports) and the committed list; each message says how to fix it. [] when they agree. */
export function allowListProblems(imports, allowed, opaque = []) {
  const listed = new Set(allowed), how = `run \`${REFRESH_COMMAND}\` and commit the change to ${ALLOW_LIST_PATH}`;
  const hidden = opaque.map(({ from, to }) => `${from} imports lib through a pattern or the package name (\`${to}\`); import the module by its relative path so the allow-list can see it.`);
  const unlisted = [...imports].filter(([target]) => !listed.has(target)).map(([target, users]) => {
    const where = [...new Set(users.map(({ from, kind }) => `${from} (${kind === 'dynamic' ? 'dynamic import()' : 'import'})`))].join(', ');
    return `${where} imports ${target}, which is not in ${ALLOW_LIST_PATH}. ui/ may import only the lib modules on that list. If ui really needs this one, add it: ${how}; the review then sees the new coupling. Otherwise take the import out.`;
  });
  const stale = allowed.filter((target) => !imports.has(target)).map((target) => `${target} is in ${ALLOW_LIST_PATH} but no ui file imports it any more. To drop the entry, ${how}.`);
  const unsorted = allowed.some((target, index) => index && allowed[index - 1] >= target) ? [`${ALLOW_LIST_PATH} must be sorted with no duplicates: ${how}.`] : [];
  return [...hidden, ...unlisted, ...stale, ...unsorted];
}

/** The context that owns a file ('lib/contexts/<id>/...'), 'ui' for ui/, otherwise a plain label for what kind of file it is. */
export function ownerOf(file) {
  const context = /^lib\/contexts\/([^/]+)\//.exec(file);
  if (context) return `context:${context[1]}`;
  if (file.startsWith('ui/')) return 'ui';
  if (/^lib\/[^/]+\.js$/.test(file)) return 'flat';
  return 'lib-folder';
}

/* The four classes of the report, from DIRECT imports. A module that fits several is listed once, at the first one that fits: ui first (that is
   the boundary this issue is about), then several contexts, then one context, then none of these. A helper that only another flat module
   imports lands in the last class on purpose: following chains of helpers reaches almost every context from almost every module (tried), which
   says nothing about where a module could live. Each line shows its other lib importers, so a leaf is easy to tell from a hub. */
export const CLASSES = [
  { id: 'ui', title: 'Used by ui' },
  { id: 'several', title: 'Used by several contexts' },
  { id: 'one', title: 'Used by exactly one context' },
  { id: 'none', title: 'Used by none of these (other lib files, entry points, scripts and tests only)' },
];

/** For every top-level lib module: which ui files and which contexts import it directly, how many other lib files do, and its class. */
export function classify(files, edges) {
  const users = new Map(topLevelLib(files).map((module) => [module, { contexts: new Set(), ui: new Set(), lib: new Set() }]));
  for (const { from, to } of edges) {
    const entry = users.get(to), owner = ownerOf(from);
    if (!entry || from === to) continue;
    // Distinct importing files: a file that imports the module twice counts once.
    if (owner === 'ui') entry.ui.add(from);
    else if (owner.startsWith('context:')) entry.contexts.add(owner.slice('context:'.length));
    else entry.lib.add(from);
  }
  return [...users].map(([module, { contexts, ui, lib }]) => {
    const id = ui.size ? 'ui' : contexts.size > 1 ? 'several' : contexts.size === 1 ? 'one' : 'none';
    return { module, class: id, contexts: [...contexts].sort(), ui: ui.size, lib: lib.size };
  });
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const note = (entry) => [
  entry.ui && count(entry.ui, 'ui file', 'ui files'),
  entry.contexts.length && `${entry.contexts.length === 1 ? 'context' : 'contexts'} ${entry.contexts.join(', ')}`,
  entry.lib && count(entry.lib, 'other lib file', 'other lib files'),
].filter(Boolean).join('; ') || 'no import found in ui/ or lib/';

export function reportText(files, edges) {
  const rows = classify(files, edges);
  const lines = [
    '# Top-level lib modules by who imports them',
    '',
    '<!-- Generated by scripts/qa/lib-graph.mjs. Do not edit by hand: run `npm run lib-graph`. tests/lib-graph.test.mjs fails when this file no longer matches the code. -->',
    '',
    `The ${rows.length} git-tracked \`lib/*.js\` files, each in the first of these classes that fits, from the imports of the tracked sources in \`ui/\` and \`lib/\` (static and dynamic; comments do not count).`,
    'Only direct imports count: a module that only other `lib/` files import (a helper of a helper) is in the last class, and its line says how many.',
    'Imports from `scripts/`, `tests/` and `packages/` are not read: a module whose only users are there is in the last class too.',
    'The report moves nothing (#902): it is the data for deciding what could later go into a context or a named shared folder, leaves first.',
    '',
    '| Class | Modules |',
    '| --- | ---: |',
    ...CLASSES.map(({ id, title }) => `| ${title} | ${rows.filter((row) => row.class === id).length} |`),
    '',
  ];
  for (const { id, title } of CLASSES) {
    const members = rows.filter((row) => row.class === id);
    lines.push(`## ${title} (${members.length})`, '');
    for (const row of members) lines.push(`- \`${row.module}\`: ${note(row)}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const readText = (file) => { try { return readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

async function main() {
  const check = process.argv.includes('--check');
  const files = trackedFiles();
  const edges = await importEdges(files);
  const outputs = [[ALLOW_LIST_FILE, allowListText([...uiLibImports(edges).keys()])], [REPORT_FILE, reportText(files, edges)]];
  let stale = 0;
  for (const [file, text] of outputs) {
    const path = relative(ROOT, file).split('\\').join('/');
    if (readText(file) === text) { console.log(`${path}: up to date`); continue; }
    stale += 1;
    if (check) { console.log(`${path}: out of date, run ${REFRESH_COMMAND}`); continue; }
    writeFileSync(file, text);
    console.log(`${path}: written`);
  }
  if (check && stale) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
