import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* `npm run test:fast` runs every test file except those named in tests/slow-tests.json: the ones that launch a browser, run ffmpeg, or start
   another program (a CLI, a fake CLI, a child Node process). This guard keeps that list honest: a test file that does one of those things
   without being listed fails here, with the line to add. `npm test` and `npm run verify` always run everything. */

const root = fileURLToPath(new URL('../', import.meta.url));
const LIST = 'tests/slow-tests.json';
const CATEGORIES = ['browser', 'ffmpeg', 'cli'];
const SELF = 'tests/slow-tests-list.test.mjs'; // its own text spells out every marker

/** What a source file starts, judged by its text. `imported`: a helper that a test imports may be used for a part of it only, so what counts is
 *  what it plainly does itself (a helper that exports a CLI launcher is no reason for every test that imports its other helpers). */
const MARKERS = {
  browser: /\blaunchChromium\b|\bchromium\.launch\b|\bfrom\s+['"]playwright(?:-core)?['"]|\bqa\/browser(?:\.mjs)?['"]/,
  ffmpeg: /\bfindFfmpeg\b|\bspawn(?:Sync)?\(\s*['"]ff(?:mpeg|probe)['"]/,
  cli: /\bfrom\s+['"](?:node:)?child_process['"]|\brequire\(\s*['"](?:node:)?child_process['"]/,
};
const OWN_ONLY = { cli: /\bpatientCli\(|\bfake-(?:mineru|marker)-cli\b|\bfake-python\b/ };
export const reasonsIn = (source, { imported = false } = {}) => CATEGORIES.filter(category => MARKERS[category].test(source) || (!imported && OWN_ONLY[category]?.test(source)));

/** Files a source imports by a relative path, resolved against its folder (extension and index files are not guessed: the repo writes them out). */
const importsOf = (source, file) => [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => resolve(dirname(file), match[1]));
const WATCHED = [join(root, 'tests'), join(root, 'scripts', 'qa')];
const watched = file => WATCHED.some(folder => file.startsWith(folder));

/** The reasons a test file is slow: its own text and the tests/ and scripts/qa/ files it imports, followed all the way down. */
async function slowReasons(file, seen = new Set(), imported = false) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const source = await readFile(file, 'utf8').catch(() => '');
  const found = new Set(reasonsIn(source, { imported }));
  for (const next of importsOf(source, file)) if (watched(next)) for (const reason of await slowReasons(next, seen, true)) found.add(reason);
  return found;
}

const list = JSON.parse(await readFile(join(root, LIST), 'utf8'));
const testFiles = (await readdir(join(root, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);

test('the list is shaped as {browser, ffmpeg, cli}, each sorted, naming test files that exist', () => {
  assert.deepEqual(Object.keys(list).sort(), [...CATEGORIES].sort());
  for (const category of CATEGORIES) {
    assert.ok(Array.isArray(list[category]), `${category} is a list`);
    assert.deepEqual(list[category], [...new Set(list[category])].sort(), `${category} is sorted and lists a file once`);
    for (const file of list[category]) assert.ok(testFiles.includes(file), `${LIST} names ${file}, which is not a tests/*.test.mjs file`);
  }
});

test('every test file that launches a browser, runs ffmpeg or starts another program is on the slow list', async () => {
  const missing = [];
  for (const file of testFiles.filter(name => name !== SELF)) {
    for (const reason of await slowReasons(join(root, file))) {
      if (!list[reason].includes(file)) missing.push(`${file} (${reason})`);
    }
  }
  assert.deepEqual(missing, [], `${LIST} must list these so that npm run test:fast can skip them; add each file under its reason, keeping the lists sorted`);
});

test('the markers recognise what they are meant to and nothing ordinary', () => {
  assert.deepEqual(reasonsIn("import { launchChromium } from '../scripts/qa/browser.mjs';"), ['browser']);
  assert.deepEqual(reasonsIn("import { chromium } from 'playwright';"), ['browser']);
  assert.deepEqual(reasonsIn('const command = await findFfmpeg();'), ['ffmpeg']);
  assert.deepEqual(reasonsIn('const probe = spawnSync("ffprobe", ["-version"]);'), ['ffmpeg']);
  assert.deepEqual(reasonsIn('assert.match(error, /what needs ffmpeg/); const options = { ffmpeg: null };'), [], 'talking about ffmpeg is not running it');
  assert.deepEqual(reasonsIn("import { spawn } from 'node:child_process';"), ['cli']);
  assert.deepEqual(reasonsIn("import { spawnSync } from \"child_process\";"), ['cli']);
  assert.deepEqual(reasonsIn("const cli = patientCli({ file: process.execPath });"), ['cli']);
  assert.deepEqual(reasonsIn("export const patientCli = () => 1; patientCli({ file });", { imported: true }), [], 'a helper file that merely offers a launcher');
  assert.deepEqual(reasonsIn("import { launchChromium } from 'x'; import { spawn } from 'node:child_process';"), ['browser', 'cli']);
  assert.deepEqual(reasonsIn("import { StudyService } from '../lib/service.js'; const text = 'spawn a child'; // an ordinary page"), []);
  assert.deepEqual(importsOf("import a from './helpers/a.mjs'; import('../scripts/qa/x.mjs'); import b from 'node:fs';", join(root, 'tests', 't.test.mjs')).map(file => relative(root, file).split('\\').join('/')),
    ['tests/helpers/a.mjs', 'scripts/qa/x.mjs']);
});
