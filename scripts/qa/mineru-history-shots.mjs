/* global document */
/* node scripts/qa/mineru-history-shots.mjs [--out <dir>] [--quick]
   The conversion history (解析历史) and the 运行环境 block in the REAL app, in the browser preview, with an isolated library and nothing real:
   - the local mineru is a fake CLI (tests/helpers/fake-mineru-cli.mjs); the preview's own service is given it through a QA-only wrapper of
     StudyService.call (the shipped host has no such seam);
   - conversions are really run through mineru.upload.* / mineru.import: two complete, a failed one, a cancelled one, one whose service died, one a crash
     interrupted (seeded on disk before the app starts), one still running while the screenshots are taken, and an old row of the removed cloud route;
   - then, per language x theme x width (1440, 1194, 420), the Sources page and the Add-material dialog (from its "解析历史" link), each with the layout audit
     of scripts/qa/mineru-layout.mjs (no overlap, no gap over 48 px, nothing spilling out of its card, no horizontal scroll);
   - and the journeys: jump from a row to the imported document, resume a failed conversion, delete one record, clear the history (with its confirm), keyboard
     only, checking after each that no imported document was deleted.
   Every key/token/base-url variable is removed from the environment, PATH holds no mineru, HOME is a temporary folder: the owner's library, ~/.mineru and
   the real DSH are never touched. Chromium: PLAYWRIGHT_CHROMIUM or the one under ms-playwright. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileURLToPath as toPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { StudyService } from '../../lib/service.js';
import { prepareJob } from '../../lib/mineru-job.js';
import { closeRecord, openRecord } from '../../lib/mineru-history.js';
import { createPreviewServer, previewCall } from '../preview-server.mjs';
import { launchChromium } from './browser.mjs';
import { layoutAudit } from './mineru-layout.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(flag('out', join(root, 'output/qa/mineru-history')));
const quick = args.includes('--quick');
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
const scratch = await mkdtemp(join(tmpdir(), 'mineru-history-qa-'));
process.env.PATH = dirname(process.execPath);
process.env.USERPROFILE = scratch; process.env.HOME = scratch;
delete process.env.MINERU_BIN;
await mkdir(out, { recursive: true });
// Nothing leaves this computer: any request to a host other than the local fakes stops the run.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`QA blocked a request to ${url}`);
  return realFetch(input, init);
};

/* ---------- the fakes ---------- */
const work = join(scratch, 'fake-cli');
await mkdir(join(work, 'models', 'MinerU2.5-Pro-2605-1.2B-GGUF'), { recursive: true });
const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl'), release = join(work, 'release');
const writeState = async patch => writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'standard', running: true, total: 120, totalFromPdf: true, modelsReady: true, ...patch }));
await writeState({}); await writeFile(logPath, '');
const cli = { file: process.execPath, prefix: [toPath(new URL('../../tests/helpers/fake-mineru-cli.mjs', import.meta.url))], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } };
const parses = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).filter(line => line.includes('"parse"')).length;
const seam = { limits: { windowPages: 50, livenessMs: 0 }, sleep: (ms, signal) => new Promise((resolveSleep, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolveSleep, Math.min(ms, 120));
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
}), local: { cli, home: work } };
/* QA only: the shipped host has no seam for the CLI, so the preview's service is given it here. */
StudyService.prototype.call = function call(action, callArgs = {}) {
  if (!this.runtime.hasAction(action)) return Promise.reject(new Error(`Unknown study action: ${action}`));
  return this.runtime.call(action, callArgs, { ...this.modelOptions, mineru: seam });
};

/* ---------- the books ---------- */
async function book(pages, title) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) doc.addPage([300, 400]).drawText(`${title}, page ${n}`, { x: 30, y: 340, size: 14, font });
  return Buffer.from(await doc.save());
}

const server = await createPreviewServer({ libraryRoot: join(scratch, 'library'), home: join(scratch, 'home'), port: 4461 });
const call = (action, callArgs) => previewCall(server, action, callArgs);
const problems = [], shots = [];
const jobs = async () => (await call('snapshot')).jobs.filter(job => job.type === 'pdf-convert');
const until = async (condition, what, timeout = 60_000) => { const end = Date.now() + timeout; for (;;) { const value = await condition(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await sleep(100); } };
async function upload(bytes, name) {
  const { uploadId, chunkBytes } = await call('mineru.upload.start', { name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
  await call('mineru.upload.finish', { uploadId });
  return uploadId;
}
const convert = async (bytes, name, extra = {}) => (await call('mineru.import', { uploadId: await upload(bytes, name), ...extra })).jobId;
const settled = async (id, status) => until(async () => { const job = (await jobs()).find(item => item.id === id); return job?.status === status ? job : null; }, `${name_(id)} to be ${status}`);
const name_ = id => id.slice(0, 8);

try {
  /* A conversion a crash interrupted: seeded on disk before the app asks about the library (it is recovered when the first snapshot is read). */
  const libraryRoot = server.libraryRoot;
  const crashedSource = join(scratch, 'Distributed Systems.pdf');
  await writeFile(crashedSource, await book(450, 'Distributed Systems'));
  const prepared = await prepareJob({ root: libraryRoot, source: crashedSource, filename: 'Distributed Systems.pdf', courses: [], language: 'zh', route: 'local', tier: 'standard', limits: seam.limits });
  await openRecord(libraryRoot, { id: prepared.manifest.id, filename: 'Distributed Systems.pdf', bytes: prepared.manifest.sourceBytes, pages: 450, pieces: prepared.manifest.chunks.length, route: 'local', tier: 'standard',
    env: { kind: 'local', mineruVersion: '4.0.10', tier: 'standard', model: 'MinerU2.5-Pro-2605-1.2B-GGUF', windows: { kind: 'fixed', pages: 50 } }, plan: prepared.manifest.plan }, { now: () => Date.now() - 7 * 3_600_000 });
  // An old row of the cloud route (removed in 3.6): it still lists, with its badge, and never resumes.
  await openRecord(libraryRoot, { id: 'qa-cloud-old', filename: 'Security.pdf', bytes: 12 * 1024 * 1024, pages: 300, pieces: 2, route: 'cloud',
    env: { kind: 'cloud', modelVersion: 'vlm', language: 'ch', maxPages: 200, maxBytes: 180 * 1024 * 1024, bookBytes: 12 * 1024 * 1024 } }, { now: () => Date.now() - 30 * 3_600_000 });
  await closeRecord(libraryRoot, 'qa-cloud-old', { status: 'failed', pagesDone: 200, failure: { stage: 'parse', piece: 2, reason: 'MinerU 没能转换这一段文件（可能是文件受保护或内容异常）。' } }, { now: () => Date.now() - 29 * 3_600_000 });

  // 1. complete
  const cloudDone = await convert(await book(3, 'Databases'), 'Databases Lecture Notes.pdf');
  await settled(cloudDone, 'complete');
  // 2. complete (3 windows of 50 pages, as the seam says)
  const localDone = await convert(await book(120, 'Algorithms'), 'Algorithms.pdf', { route: 'local' });
  await settled(localDone, 'complete');
  // 3. failed at window 2
  await writeState({ failStarts: [51] });
  const failedCloud = await convert(await book(150, 'Networks'), 'Networks.pdf');
  await settled(failedCloud, 'failed');
  // 4. cancelled while a window converts
  await writeState({ finishSignal: release });
  const cancelled = await convert(await book(150, 'Machine Learning'), 'Machine Learning.pdf');
  await until(async () => (await jobs()).find(job => job.id === cancelled)?.phase === 'local', 'the cancelled one to be converting');
  await call('job.cancel', { jobId: cancelled });
  await settled(cancelled, 'cancelled');
  await writeFile(release, '');
  await writeState({});
  // 5. local, the service dies in window 2
  await writeState({ dieOnFirst: 51 });
  const stopped = await convert(await book(120, 'Compilers'), 'Compilers.pdf', { route: 'local' });
  await settled(stopped, 'failed');
  // 6. local, running while the screenshots are taken (slow windows)
  await writeState({ delayMs: 600_000, running: true });
  await call('mineru.local.start', { restart: true }).catch(() => {});
  await writeState({ delayMs: 600_000, running: true });
  const running = await convert(await book(120, 'Operating Systems'), 'Operating Systems.pdf', { route: 'local' });
  await until(async () => (await jobs()).find(job => job.id === running)?.phase === 'local', 'the local run to start');

  const sourcesBefore = (await call('snapshot')).sources.length;
  console.log(`seeded: ${(await call('mineru.history.list')).records.length} history rows, ${sourcesBefore} imported pages`);

  const browser = await launchChromium();
  const combos = quick ? [['zh', 'dark', 1440], ['en', 'light', 420]] : ['zh', 'en'].flatMap(lang => ['dark', 'light'].flatMap(theme => [1440, 1194, 420].map(width => [lang, theme, width])));
  const audit = async (tab, where, options) => { const result = await tab.evaluate(layoutAudit, options); for (const text of result.problems) problems.push(`${where}: ${text}`); };
  const scopes = ['.pdf-history', '.pdf-history__row', '.pdf-env', '.pdf-convert-jobs > *'];
  const noSpill = async (tab, where) => { const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (overflow > 1) problems.push(`${where}: horizontal overflow ${overflow}px`); };
  const hanOutsideData = async (tab, where) => {
    // English render: Chinese may only be user data (file names, titles) and the backend's own sentences already translated.
    const text = await tab.evaluate(() => [...document.querySelectorAll('.pdf-history, .pdf-convert-jobs, .mineru-route-panel')].map(element => element.innerText).join('\n'));
    const leftover = text.split('\n').filter(line => /[㐀-鿿]/.test(line)).filter(line => !/\.pdf/i.test(line));
    if (leftover.length) problems.push(`${where}: Chinese in the English page: ${leftover.slice(0, 3).join(' | ')}`);
  };
  try {
    for (const [lang, theme, width] of combos) {
      const label = `${lang}-${theme}-${width}`;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
      const tab = await context.newPage();
      tab.on('pageerror', error => problems.push(`${label}: ${error.message}`));
      const settle = async (ms = 400) => { await tab.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
      const shot = async name => { const path = join(out, `${name}-${label}.png`); await tab.screenshot({ path, fullPage: name.startsWith('sources') }); shots.push(path); };
      await tab.goto(server.url); await tab.locator('aside, nav').first().waitFor({ timeout: 30_000 }); await settle(800);

      // The Sources page: the running card with its environment, and the history under it.
      await tab.locator('[data-tour="nav-sources"]').first().click(); await settle(600);
      await tab.locator('.pdf-convert-jobs .job.running').first().waitFor({ timeout: 20_000 });
      await tab.locator('.pdf-history summary').first().waitFor({ timeout: 20_000 });
      await shot('sources-1-card-and-history-closed');
      await audit(tab, `sources-closed/${label}`, { scopes: ['.pdf-convert-jobs > *', '.pdf-env'] }); await noSpill(tab, `sources-closed/${label}`);
      await tab.locator('.pdf-history summary').first().click(); await settle(400);
      await tab.locator('.pdf-history__row').first().waitFor({ timeout: 10_000 });
      { const path = join(out, `sources-2-history-open-${label}.png`); await tab.locator('.pdf-history').first().screenshot({ path }); shots.push(path); }
      await audit(tab, `sources-open/${label}`, { scopes }); await noSpill(tab, `sources-open/${label}`);
      if (lang === 'en') await hanOutsideData(tab, `sources/${label}`);
      const text = await tab.locator('.pdf-history').innerText();
      const expectations = lang === 'en' ? [/Finished|Completed/, /Did not finish/, /Cancelled/, /Interrupted/, /Running|In progress/, /Cloud|cloud/, /Local/, /choose this PDF again/] : [/已完成/, /没有完成/, /已取消/, /被中断/, /进行中/, /云端/, /本地/, /云端解析已停用/];
      for (const pattern of expectations) if (!pattern.test(text)) problems.push(`sources-open/${label}: the history lacks ${pattern}`);
      // The running local card names what runs it.
      const card = await tab.locator('.pdf-convert-jobs .job.running .pdf-env').first().innerText();
      for (const pattern of lang === 'en' ? [/4\.0\.10/, /standard/, /MinerU2\.5-Pro-2605-1\.2B-GGUF/, /service is running/i] : [/4\.0\.10/, /standard/, /MinerU2\.5-Pro-2605-1\.2B-GGUF/, /本地服务运行中/])
        if (!pattern.test(card)) problems.push(`card/${label}: the environment lacks ${pattern}: ${card.replace(/\s+/g, ' ')}`);

      // The Add-material dialog and its link.
      await tab.locator('[data-tour="sources-add"]').first().click(); await settle(500);
      const link = tab.locator('dialog[open] .import-hub__mineru').getByRole('button', { name: lang === 'en' ? /Conversion history/ : /解析历史/ });
      await link.first().waitFor({ timeout: 10_000 });
      await tab.locator('dialog[open] .import-hub__mineru').first().scrollIntoViewIfNeeded();
      await shot('dialog-1-footer-link');
      await link.first().click(); await settle(500);
      await tab.locator('dialog[open] .pdf-history__row').first().waitFor({ timeout: 15_000 });
      await tab.locator('dialog[open] .pdf-history').first().scrollIntoViewIfNeeded(); await settle(200);
      await shot('dialog-2-history');
      await audit(tab, `dialog/${label}`, { scopes: ['dialog[open] .mineru-route-panel', 'dialog[open] .pdf-history', 'dialog[open] .pdf-history__row'] }); await noSpill(tab, `dialog/${label}`);
      if (lang === 'en') await hanOutsideData(tab, `dialog/${label}`);
      await context.close();
    }

    /* ---------- the journeys (one language, one theme, one width each time) ---------- */
    for (const [lang, theme, width, steps] of quick ? [['zh', 'dark', 1440, { stop: true, resume: true, destructive: true }]] : [['zh', 'dark', 1440, { stop: true, resume: true }], ['en', 'light', 420, { destructive: true }]]) {
      const label = `journey-${lang}-${theme}-${width}`, T = (zh, en) => (lang === 'en' ? en : zh);
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
      const tab = await context.newPage();
      tab.on('pageerror', error => problems.push(`${label}: ${error.message}`));
      const settle = async (ms = 400) => { await tab.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
      const shot = async name => { const path = join(out, `${label}-${name}.png`); await tab.screenshot({ path }); shots.push(path); };
      const must = (condition, message) => { if (!condition) problems.push(`${label}: ${message}`); };
      // The history on the Sources page is a disclosure: open it only when it is closed.
      const ensureOpen = async () => { const details = tab.locator('details.pdf-history__disclosure').first(); if (!(await details.evaluate(element => element.open))) { await details.locator(':scope > summary').click(); await settle(400); } };
      await tab.goto(server.url); await tab.locator('aside, nav').first().waitFor({ timeout: 30_000 }); await settle(800);
      await tab.locator('[data-tour="nav-sources"]').first().click(); await settle(600);

      // The running conversion is stopped from its card; its row becomes cancelled.
      if (steps.stop) {
        await tab.locator('.pdf-convert-jobs .job.running').getByRole('button', { name: /停止/ }).first().click();
        await until(async () => (await jobs()).find(job => job.id === running)?.status === 'cancelled', 'the stop');
        await settle(800);
        await ensureOpen();
        const rows = await tab.locator('.pdf-history__row').allInnerTexts();
        must(rows.some(row => /Operating Systems\.pdf/.test(row) && /已取消/.test(row)), 'the stopped conversion shows as cancelled in the history');
        await shot('1-stopped-running-row');
        await writeState({ running: true });
      } else {
        await ensureOpen();
      }

      // Jump from a row to the imported document.
      await tab.locator('[data-tour="sources-add"]').first().click(); await settle(500);
      await tab.locator('dialog[open] .import-hub__mineru').getByRole('button', { name: T(/解析历史/, /Conversion history/) }).first().click(); await settle(500);
      const open = tab.locator('dialog[open] .pdf-history__row', { hasText: 'Databases Lecture Notes.pdf' }).getByRole('button', { name: T(/打开/, /Open/) }).first();
      await open.click(); await settle(900);
      const reader = await tab.locator('dialog[open]').first().innerText().catch(() => '');
      must(/Databases, page/.test(reader) || /Databases/.test(reader), `the imported document opens (${reader.replace(/\s+/g, ' ').slice(0, 80)})`);
      await shot('2-opened-imported-document');
      await tab.keyboard.press('Escape'); await settle(400);

      // Resume the failed conversion from its history row: only the failed window and the rest are converted, never the finished first one.
      await writeState({ running: true });
      const parsesBefore = await parses();
      await ensureOpen();
      if (steps.resume) {
        const failedRow = tab.locator('.pdf-history__row', { hasText: 'Networks.pdf' });
        await failedRow.getByRole('button', { name: /接着/ }).first().click();
        await settled(failedCloud, 'complete');
        await settle(1200);
        must(await parses() - parsesBefore === 2, `only the failed window and the one after it were converted (${await parses() - parsesBefore})`);
        const row = (await tab.locator('.pdf-history__row', { hasText: 'Networks.pdf' }).first().innerText()).replace(/\s+/g, ' ');
        must(/已完成/.test(row) && /已尝试 2 次/.test(row), `the resumed row is complete with two attempts: ${row.slice(0, 120)}`);
        await shot('3-resumed-row-complete');
      }

      if (steps.destructive) {
      // Delete one record: the row goes, the imported pages stay.
      const pagesBefore = (await call('snapshot')).sources.length;
      const deleteName = lang === 'en' ? /Delete the record of “Machine Learning\.pdf”/ : /删除「Machine Learning\.pdf」的记录/;
      await tab.getByRole('button', { name: deleteName }).first().click(); await settle(700);
      must((await tab.locator('.pdf-history__row', { hasText: 'Machine Learning.pdf' }).count()) === 0, 'the deleted record is gone');
      must((await call('snapshot')).sources.length === pagesBefore, 'deleting a record deleted no imported page');

      // Clear the history with its confirm, by keyboard: Tab to the button, Enter, Tab to the confirm.
      const clearButton = tab.getByRole('button', { name: T(/清空历史/, /Clear history/) }).first();
      await clearButton.scrollIntoViewIfNeeded();
      await clearButton.focus(); await tab.keyboard.press('Enter'); await settle(300);
      must(await tab.getByRole('alertdialog').count() === 1, 'clearing asks first');
      await shot('4-clear-confirm');
      await audit(tab, `${label}/confirm`, { scopes: ['.pdf-history', '.pdf-history__confirm'] });
      const confirm = tab.getByRole('button', { name: T(/确认清空/, /Yes, clear them/) }).first();
      await confirm.focus(); await tab.keyboard.press('Enter'); await settle(900);
      const after = await call('mineru.history.list');
      must(after.records.every(record => record.live), `the history is cleared (${after.records.length} left)`);
      must((await call('snapshot')).sources.length === pagesBefore, 'clearing the history deleted no imported page');
      await shot('5-history-after-clear');
      await audit(tab, `${label}/cleared`, { scopes: ['.pdf-history'] }); await noSpill(tab, `${label}/cleared`);
      }
      await context.close();
    }
  } finally { await browser.close(); }
} finally {
  await writeFile(release, '').catch(() => {});
  await server.close().catch(() => {});

  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.log(`PROBLEMS:\n- ${problems.join('\n- ')}`); process.exitCode = 1; } else console.log('no page errors, no horizontal overflow, no layout problem, history jump/resume/delete/clear all behaved');
