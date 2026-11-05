/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, seedWrongBookLibrary, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* The owner's report (2026-11-05): 生成变式 on 错题与待巩固 did not show in 任务, and there was no sub-agent transcript to read. The mistakes page asked the
   host for the variants without refreshing the library the console reads, so the console opened right after drew its old list (「还没有任务」) until the
   next background poll; and its 实时输出 asked job.output of the 为你定制 day, which has no sub-agent and no output, and waited forever.
   Here: three mistakes in one course, the fake model holds the variant call until the test lets it go, so the batch is in flight while the console is read. */

const VARIANT_PROMPT = '为每个 target';

test('生成变式 shows in the 任务 console at once: the day row with its batch 进行中, then what it kept; the light model writes it, so no transcript is promised', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to drive the page with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-variants-console-'));
  const dist = join(base, 'dist'), root = join(base, 'library');
  await buildPreview({ outdir: dist });
  await seedWrongBookLibrary(root, { wrong: 3 });
  let release;
  const held = new Promise((done) => { release = done; });
  const fake = createFakeModel({ latencyMs: 20, usage: true });
  const model = async (system, prompt, options) => { if (String(prompt).includes(VARIANT_PROMPT)) await held; return fake(system, prompt, options); };
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model, distDir: dist });
  try {
    const { page, errors, context } = await openPage(browser, { server }, { width: 1440, theme: 'light' });
    const asked = [];
    page.on('request', (request) => { if (request.url().includes('/api/call')) asked.push(/"action":"([^"]+)"/.exec(request.postData() || '')?.[1]); });
    await page.goto(server.url);
    await (await revealNavRow(page, 'wrongbook')).dispatchEvent('click');
    await page.locator('.wb-row, .wb-group-toggle').first().waitFor({ timeout: 30000 });
    for (const fold of await page.locator('.wb-group-toggle[aria-expanded="false"]').all()) await fold.dispatchEvent('click');
    await page.locator('.wb-row').first().getByRole('button', { name: '生成变式' }).dispatchEvent('click');
    await page.getByRole('button', { name: '同意并生成' }).dispatchEvent('click');
    await until(async () => /已开始为 1 道题生成变式/.test(await page.locator('.wb').innerText()), 'the page to say the variants started');

    // Straight to 任务, as the learner did: the console's first drawing already has the day's row, running.
    await (await revealNavRow(page, 'tasks')).dispatchEvent('click');
    await page.locator('.tc').waitFor({ timeout: 30000 });
    const first = await page.evaluate(() => ({ none: !!document.querySelector('.tc-none'),
      rows: [...document.querySelectorAll('.tc-row')].map((row) => ({ id: row.dataset.taskId, text: row.textContent.replace(/\s+/g, ' ').trim() })) }));
    assert.equal(first.none, false, 'right after 生成变式 the console must not say there are no tasks');
    const day = first.rows.find((row) => row.id?.startsWith('coach:'));
    assert.ok(day, `the 为你定制 day is listed at once (rows: ${JSON.stringify(first.rows)})`);
    assert.match(day.text, /为你定制/);

    // 批次: the batch is in flight, for the one question asked.
    await page.getByRole('tab', { name: /^批次/ }).dispatchEvent('click');
    await until(async () => (await page.locator('.tc-batch[data-status="running"]').count()) === 1, 'the batch to show as 进行中');
    assert.match(await page.locator('.tc-batch[data-status="running"]').innerText(), /为 1 道题备变式[\s\S]*进行中/);

    // 实时输出 says plainly that there is no sub-agent and so no transcript, and asks the host for none.
    const note = page.locator('[data-coach-output]');
    await note.waitFor({ timeout: 30000 });
    assert.match(await note.innerText(), /没有子代理原文/);
    assert.match(await note.innerText(), /轻量模型直接写/);
    await frames(page, 6);
    assert.equal(asked.filter((action) => action === 'job.output').length, 0, 'no job.output is asked of a day of 为你定制');

    // The model answers: the batch ends with what it wrote and kept, and the note shows that batch's figures and tokens.
    release();
    await until(async () => (await page.locator('.tc-batch[data-status="ok"]').count()) === 1, 'the batch to end', { timeoutMs: 60000 });
    assert.match(await page.locator('.tc-batch[data-status="ok"]').innerText(), /写了 1 道，留下 1 道[\s\S]*tok/);
    await until(async () => /写了 1 道，留下 1 道/.test(await note.innerText()), 'the note to show the ended batch');
    assert.match(await note.innerText(), /tok/);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { release(); await browser.close(); await server.close(); await rm(base, { recursive: true, force: true }); }
});
