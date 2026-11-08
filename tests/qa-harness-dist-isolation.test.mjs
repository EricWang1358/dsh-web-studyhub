import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { parseQaArgs, resolveQaDistDir, runQa } from '../scripts/qa/harness.mjs';

test('#840: resolveQaDistDir isolates each QA output root while honoring explicit distDir overrides', async (t) => {
  const outA = await mkdtemp(join(tmpdir(), 'study-qa-dist-a-'));
  const outB = await mkdtemp(join(tmpdir(), 'study-qa-dist-b-'));
  t.after(async () => {
    await rm(outA, { recursive: true, force: true });
    await rm(outB, { recursive: true, force: true });
  });
  const optsA = parseQaArgs(['--out', outA], 'dist-a');
  const optsB = parseQaArgs(['--out', outB], 'dist-b');
  assert.equal(resolveQaDistDir(optsA), join(outA, 'work', 'dist'));
  assert.equal(resolveQaDistDir(optsB), join(outB, 'work', 'dist'));
  assert.notEqual(resolveQaDistDir(optsA), resolveQaDistDir(optsB));
  const shared = join(outA, 'shared-dist');
  const optsShared = parseQaArgs(['--out', outB, '--distDir', shared], 'dist-shared', { distDir: null });
  assert.equal(resolveQaDistDir(optsShared), shared);
});

test('#840: runQa builds and serves its own isolated preview bundle under <out>/work/dist', async (t) => {
  try {
    const probe = await launchChromium();
    await probe.close();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }

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
