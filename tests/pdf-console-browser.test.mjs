/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, settleAnimations, frames, until } from '../scripts/qa/layout-late.mjs';
import { startConsole } from '../scripts/qa/task-console.mjs';
import { StudyService } from '../lib/service.js';
import { makePdf } from './helpers/pdf.mjs';

/* The 任务 console of a Marker conversion in a real browser, at 1280 and 420 px: one conversion running (Marker printing progress bars) and one that failed the way the
   owner's did (marker-pdf 2.x without Docker). The two records are made by the real service with the stand-in Marker (tests/helpers/fake-marker-cli.mjs), then shown by
   the preview app (its snapshot answer carries them). No timeline or model-call panels, the log with the windows and Marker's lines, the failure in full with
   复制诊断信息 and 前往设置 first, nothing wider than the window. PDF_CONSOLE_SHOTS=<folder> keeps the screenshots. */

const fake = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));

async function conversion(state, { ended }) {
  const folder = await mkdtemp(join(tmpdir(), 'pdf-console-browser-')), statePath = join(folder, 'state.json'), log = join(folder, 'log.jsonl');
  await writeFile(statePath, JSON.stringify(state)); await writeFile(log, '');
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(folder, 'home');
  const service = new StudyService(join(folder, 'library'), { marker: { limits: {}, local: { cli: { file: process.execPath, prefix: [fake], env: { FAKE_MARKER_STATE: statePath, FAKE_MARKER_LOG: log } } } } });
  try {
    const bytes = await makePdf({ pages: 198 });
    const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name: '04. Design Secure Architecture v4.7.pdf', size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await service.call('mineru.upload.finish', { uploadId });
    await service.call('marker.import', { uploadId });
    const pick = async language => (await service.call('snapshot', { uiLanguage: language })).jobs.find(job => job.type === 'pdf-convert');
    await until(async () => { const job = await pick('zh'); return ended ? job?.status === 'failed' : job?.toolProgress && job.contract.events.some(event => event.code === 'tool-output'); }, 'the conversion', { timeoutMs: 60_000 });
    return { zh: await pick('zh'), en: await pick('en') };
  } finally {
    const running = (await service.call('snapshot')).jobs.find(job => job.type === 'pdf-convert' && job.status === 'running');
    if (running) { await service.call('job.cancel', { jobId: running.id }).catch(() => {}); await service.call('job.wait', { jobId: running.id }).catch(() => {}); }
    service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('the console of a running and of a failed Marker conversion at 1280 and 420 px', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  const running = await conversion({ progress: true, delayStart: 0 }, { ended: false });
  const failed = await conversion({ failStart: 0, traceback: 'docker' }, { ended: true });
  failed.zh.id = failed.en.id = `${failed.zh.id}-failed`;
  failed.zh.contract = { ...failed.zh.contract, jobId: failed.zh.id }; failed.en.contract = { ...failed.en.contract, jobId: failed.en.id };
  const shots = process.env.PDF_CONSOLE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const dist = await mkdtemp(join(tmpdir(), 'study-pdf-console-dist-'));
  await buildPreview({ outdir: dist });
  const preview = await startConsole({ distDir: dist });
  try {
    for (const [lang, width] of [['zh', 1280], ['zh', 420], ['en', 1280]]) {
      const { page, errors, context } = await openPage(browser, preview, { lang, theme: 'light', width, height: 900 });
      await page.route('**/api/call', async (route) => {
        let action = '';
        try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
        if (action !== 'snapshot') return route.continue();
        const answer = await (await route.fetch()).json();
        if (answer.ok) answer.value.jobs = [running[lang], failed[lang], ...(answer.value.jobs || [])];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) });
      });
      await page.goto(preview.server.url);
      await page.locator('[data-tour="nav-tasks"]').first().dispatchEvent('click');
      await page.locator('.tc-detail').first().waitFor({ state: 'attached', timeout: 30000 });
      for (const [name, job] of [['running', running[lang]], ['failed', failed[lang]]]) {
        await page.locator(`.tc-row[data-task-id="${job.contract.jobId}"]`).dispatchEvent('click');
        await page.locator(`.tc-detail[data-task-id="${job.contract.jobId}"]`).waitFor({ timeout: 15000 });
        await settleAnimations(page); await frames(page, 4);
        const seen = await page.evaluate(() => ({ timeline: !!document.querySelector('.tc-detail .tc-timeline'), lines: document.querySelectorAll('.tc-log__body .tc-line').length,
          failure: document.querySelector('.pdf-failure')?.innerText || '', block: document.querySelector('.tc-line__block')?.innerText || '', fix: !!document.querySelector('[data-fix="settings"]'),
          progress: document.querySelector('[data-tool-progress]')?.innerText || '', text: document.querySelector('.tc-detail')?.innerText || '', scrollWidth: document.documentElement.scrollWidth }));
        assert.equal(seen.timeline, false, `${name} ${lang} ${width}: no model-call timeline`);
        assert.ok(seen.lines >= 3, `${name} ${lang} ${width}: the log shows the run (${seen.lines} lines)`);
        assert.ok(seen.scrollWidth <= width, `${name} ${lang} ${width}: nothing wider than the window (${seen.scrollWidth})`);
        if (name === 'running') assert.match(seen.progress, /Recognizing/, 'Marker\'s bar, live');
        else {
          assert.match(seen.failure, lang === 'en' ? /Docker Desktop/ : /启动 Docker Desktop/);
          assert.match(seen.failure, /SpawnError/); assert.match(seen.block, /SpawnError/);
          assert.ok(seen.fix, 'Go to settings first');
          assert.doesNotMatch(seen.text, /已出的题|questions already made/);
        }
        if (shots) await page.screenshot({ path: join(shots, `pdf-console-${name}-${lang}-${width}.png`), fullPage: width < 768 });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await preview.close(); await rm(dist, { recursive: true, force: true }); }
});
