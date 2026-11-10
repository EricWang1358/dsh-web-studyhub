import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { until } from '../scripts/qa/layout-late.mjs';
import { startConsole, startJobs, openConsole } from '../scripts/qa/task-console.mjs';
import { LIVE_JOBS } from '../ui/app/live-jobs.js';

/* #886 in the real page, on the preview host with a question run and an audio batch held in flight (scripts/qa/task-console.mjs). While they run, the poll of
   the snapshot answers { unchanged } and the panel reads the running jobs' rows with job.live.list in the same loop (never two requests at once); what that
   read says is what the 任务 console draws. Once the jobs end, a whole snapshot brings the end, the live rows do not linger, and the live read is no longer asked.
   The question run's percent in the live answers is changed at the network edge to a number only the live read can bring. */

const POLLED = new Set(['snapshot', LIVE_JOBS]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('the console draws the live read between unchanged snapshots, the loop never overlaps, and the live read stops when the jobs end', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-live-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist });
  try {
    const { generation } = await startJobs(running);
    const runId = generation.jobId;
    const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
    // Every snapshot and live request in order, with what came back, and how many of them were in flight at once (counted from `watch()`: the first open of
    // the page refreshes on its own besides the poll).
    const log = [], open = new Set();
    let most = 0;
    const watch = () => { most = open.size; };
    const done = (request) => open.delete(request);
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/call')) return;
      let action = '';
      try { action = JSON.parse(request.postData() || '{}').action; } catch { /* not JSON */ }
      if (!POLLED.has(action)) return;
      open.add(request); most = Math.max(most, open.size);
      const entry = { action, at: Date.now(), answer: null };
      log.push(entry);
      request.response().then((response) => response?.json()).then((json) => {
        const value = json?.value || {};
        entry.answer = action === 'snapshot' ? (value.unchanged ? 'unchanged' : value.partial ? 'partial' : 'full') : 'live';
      }).catch(() => {});
    });
    // A percent only the live read can bring: the run's row in each live answer says MARK.
    let MARK = 61;
    await page.route('**/api/call', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
      if (body.action !== LIVE_JOBS) return route.continue();
      const response = await route.fetch(), json = await response.json();
      for (const row of json.value?.jobs || []) if (row.id === runId) row.contract.progress = { ...row.contract.progress, percent: MARK };
      return route.fulfill({ response, json });
    });
    const cell = page.locator(`.tc-row[data-task-id="${runId}"] .tc-num`);
    await cell.waitFor({ timeout: 60000 });
    const before = (await cell.innerText()).trim();
    if (before === `${MARK}%`) MARK = 62;
    await until(async () => (await cell.innerText()).trim() === `${MARK}%`, `the console to draw the live percent ${MARK}%`, { timeoutMs: 60000 });
    const held = log.length;
    watch();
    await sleep(8000);
    const quiet = log.slice(held);
    t.diagnostic(`while held: ${quiet.map((entry) => entry.answer || entry.action).join(' ')}`);
    assert.ok(quiet.some((entry) => entry.answer === 'unchanged'), 'the snapshot answers unchanged while the jobs only move');
    assert.ok(quiet.some((entry) => entry.action === LIVE_JOBS), 'and the live read is asked');
    for (const [index, entry] of quiet.entries()) if (entry.action === LIVE_JOBS) assert.equal(quiet[index - 1]?.action ?? 'snapshot', 'snapshot', 'a live read follows a snapshot poll');
    assert.ok(most <= 1, `the snapshot and the live read share one loop: never two in flight (${most})`);
    assert.equal((await cell.innerText()).trim(), `${MARK}%`, 'what the console draws is the live read');

    running.release();
    await until(async () => !(await running.api('snapshot')).jobs.some((job) => ['queued', 'running', 'cancelling'].includes(job.status)), 'the jobs to end');
    await until(async () => ['done', 'partial', 'fail', 'stopped'].includes(await cell.getAttribute('data-state')), 'the console to show the run ended', { timeoutMs: 30000 });
    assert.notEqual((await cell.innerText()).trim(), `${MARK}%`, 'the live row does not linger over the ended job');
    const ended = log.length;
    watch();
    await sleep(8000);
    assert.equal(log.slice(ended).filter((entry) => entry.action === LIVE_JOBS).length, 0, 'no job runs: the live read is not asked');
    assert.ok(most <= 1, `never two in flight (${most})`);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
