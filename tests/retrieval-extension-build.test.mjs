import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_BUILD } from '../lib/retrieval-extension.js';
import { extensionBuildProblem, extensionFingerprint } from '../scripts/extension-fingerprint.mjs';

/* Every release repacks the search extension under its own version, so learners are asked to update it only when its code changed:
   lib/retrieval-extension.js EXTENSION_BUILD records which extension ships (its fingerprint) and the first release that shipped it.
   This is the check that keeps that record true to packages/studyhub-retrieval; the release pack runs the same check. */

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'packages', 'studyhub-retrieval');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

async function copy(t) {
  const dir = await mkdtemp(join(tmpdir(), 'extension-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(source, dir, { recursive: true, filter: path => !path.split(sep).includes('node_modules') });
  return dir;
}

test('the record of the search extension that ships matches packages/studyhub-retrieval', async () => {
  assert.equal(await extensionBuildProblem({ dir: source, build: EXTENSION_BUILD, version }), '');
});

test('a release\'s version bump, line endings and the README leave the fingerprint alone; code, dependencies and display text change it', async t => {
  const dir = await copy(t);
  const before = await extensionFingerprint(dir);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const index = await readFile(join(dir, 'index.js'), 'utf8');
  const locale = await readFile(join(dir, 'locale', 'en.json'), 'utf8');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ ...manifest, version: '99.0.0' }, null, 2));
  await writeFile(join(dir, 'index.js'), index.includes('\r\n') ? index.replace(/\r\n/g, '\n') : index.replace(/\n/g, '\r\n'));
  await writeFile(join(dir, 'README.md'), 'Rewritten.');
  assert.equal(await extensionFingerprint(dir), before, 'nothing a learner runs changed');

  await writeFile(join(dir, 'index.js'), `${index}\n// changed\n`);
  assert.notEqual(await extensionFingerprint(dir), before, 'the plugin code');
  await writeFile(join(dir, 'index.js'), index);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'mcp-local-rag': '0.21.0' } }, null, 2));
  assert.notEqual(await extensionFingerprint(dir), before, 'the search server it installs');
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'locale', 'en.json'), locale.replace(/"title":\s*"/, '"title": "New '));
  assert.notEqual(await extensionFingerprint(dir), before, 'the text DSH shows for it');
});

test('a changed extension is refused until its record moves, and says what to record; the release refuses a since above itself', async t => {
  const dir = await copy(t);
  await writeFile(join(dir, 'heal.js'), '\n// changed\n', { flag: 'a' });
  const problem = await extensionBuildProblem({ dir, build: EXTENSION_BUILD, version: '3.7.2' });
  assert.match(problem, /packages\/studyhub-retrieval changed/);
  assert.match(problem, /EXTENSION_BUILD/);
  assert.match(problem, /3\.7\.3/, 'the release after this one is what to record');
  const fingerprint = await extensionFingerprint(dir);
  assert.ok(problem.includes(fingerprint), 'and the new fingerprint');
  assert.equal(await extensionBuildProblem({ dir, build: { since: '3.7.3', fingerprint }, version: '3.7.2' }), '', 'a change records the release that will ship it');
  assert.equal(await extensionBuildProblem({ dir, build: { since: '3.7.3', fingerprint }, version: '3.7.3', release: true }), '');
  assert.match(await extensionBuildProblem({ dir, build: { since: '3.8.0', fingerprint }, version: '3.7.3', release: true }), /3\.8\.0[^]*3\.7\.3/,
    'packed as 3.7.3, an extension recorded for 3.8.0 would ask every later release for an update');
  assert.match(await extensionBuildProblem({ dir, build: { since: 'next', fingerprint }, version: '3.7.2' }), /not a version/);
});
