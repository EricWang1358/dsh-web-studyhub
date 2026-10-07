import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renameWithRetry } from '../lib/atomic-json.js';

// Found by the 3.0.0 full run on Windows: board.json's replacement was denied once (EPERM, a scanner holding the file) and the card edit failed.
// store.js and atomic-json.js already retry the same completed file; the board and the notebook registry did not.
const denied = code => Object.assign(new Error(`${code}: denied`), { code });
const quick = { wait: async () => {} };

test('a replacement that is briefly denied is retried and then lands', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const calls = [];
    const rename = async (from, to) => { calls.push([from, to]); if (calls.length < 4) throw denied(code); };
    await renameWithRetry('a.tmp', 'a.json', { rename, ...quick });
    assert.equal(calls.length, 4, code);
    assert.ok(calls.every(call => call[0] === 'a.tmp' && call[1] === 'a.json'), 'the same completed file every time');
  }
});

test('a replacement that stays denied fails with the last error after a bounded number of tries; other errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(renameWithRetry('a.tmp', 'a.json', { rename: async () => { calls++; throw denied('EPERM'); }, ...quick }), { code: 'EPERM' });
  assert.equal(calls, 8);
  calls = 0;
  await assert.rejects(renameWithRetry('a.tmp', 'a.json', { rename: async () => { calls++; throw denied('ENOENT'); }, ...quick }), { code: 'ENOENT' });
  assert.equal(calls, 1);
});

test('every writer that replaces a file in the shared study folder goes through the retry', async () => {
  const lineBreaks = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g');
  for (const file of ['lib/atomic-json.js', 'lib/board.js', 'lib/notebooks.js']) {
    const source = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(lineBreaks, String.fromCharCode(10));
    assert.match(source, /renameWithRetry\(/, file);
    assert.doesNotMatch(source.replace(/export async function renameWithRetry[\s\S]*?\n}\n/, ''), /[^.\w]rename\(/, `${file} replaces a file with a bare rename`);
  }
});
