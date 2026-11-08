import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQaArgs, runQa } from '../scripts/qa/harness.mjs';

test('#840: runQa builds and serves its own isolated preview bundle under <out>/work/dist', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'study-qa-dist-isolation-'));
  t.after(() => rm(out, { recursive: true, force: true }));

  const options = parseQaArgs(['--lang', 'zh', '--theme', 'dark', '--width', '1280', '--out', out], 'dist-isolation');
  let seenDistDir = null;
  const summary = await runQa({
    name: 'dist-isolation',
    options,
    seed: async () => {},
    run: async ({ page, distDir, check }) => {
      seenDistDir = distDir;
      await check('app-shell-booted', async () => {
        const navCount = await page.locator('aside, nav').count();
        assert.ok(navCount >= 1, 'isolated preview bundle booted app shell');
      });
    },
  });

  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(seenDistDir, join(out, 'work', 'dist'));
  const jsInfo = await stat(join(seenDistDir, 'app.js'));
  const cssInfo = await stat(join(seenDistDir, 'app.css'));
  assert.ok(jsInfo.size > 1000, 'isolated app.js bundle exists and is non-empty');
  assert.ok(cssInfo.size > 100, 'isolated app.css bundle exists and is non-empty');
  const summaryDisk = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
  assert.equal(summaryDisk.ok, true);
});
