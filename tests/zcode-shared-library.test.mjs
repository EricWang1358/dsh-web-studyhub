import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { StudyService } from '../lib/service.js';

/* DSH and ZCode on one computer can open the same library at the same time (the ZCode home is ~/.dsh when DSH is
   installed). Every library write takes lib/store-lock.js's file lock, which arbitrates between processes, and every read
   reloads a manifest another process replaced. Two processes writing at once must both land, with nothing lost. */
const run = promisify(execFile);
const writer = fileURLToPath(new URL('./helpers/zcode-shared-writer.mjs', import.meta.url));

test('two processes writing one library at once lose nothing', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const count = 6;
  const outputs = await Promise.all(['dsh', 'zcode'].map((name) => run(process.execPath, [writer, root, name, String(count)], { windowsHide: true })));
  assert.deepEqual(outputs.map((output) => output.stdout), ['done', 'done']);
  const service = new StudyService(root, {});
  t.after(() => service.dispose());
  const state = await service.store.read();
  const titles = state.sources.map((source) => source.title).sort();
  const expected = ['dsh', 'zcode'].flatMap((name) => Array.from({ length: count }, (_, index) => `${name} ${index}`)).sort();
  assert.deepEqual(titles, expected);
  assert.equal(state.revision, count * 2, 'every write committed one revision after the other');
});
