/* global document */
/* node scripts/qa/mineru-adaptive-shots.mjs [--out <dir>] [--quick]
   The live card of an ADAPTIVE local conversion in the REAL app (browser preview), with an isolated library and nothing real:
   - the local mineru is a fake CLI (tests/helpers/fake-mineru-cli.mjs) that really takes its time; the preview's own service is given its address through a QA-only wrapper of
     StudyService.call (the shipped host has no such seam), with short liveness numbers so a state shows within seconds (livenessMs 400, silentMs 1500);
   - a 120-page book is really converted (mineru.upload.* / mineru.import) in five situations, each held on its fourth window so the card can be looked at:
     queued in the service, converting, no response (the service never reports the window), service stopped, and the service status unreadable;
   - per situation x language x theme x width (1440, 1194, 420): the card is checked for its state label, screenshotted, and run through the layout audit of
     scripts/qa/mineru-layout.mjs (no overlap, no gap over 48 px, nothing spilling out of its card, no horizontal scroll), with the "why does it take so long" disclosure opened;
     English pages must hold no Chinese outside file names;
   - then a finished conversion's history row with the real per-window timings and the pace, and the plan preview in the Add-material dialog.
   Every key/token/base-url variable is removed from the environment, PATH holds no mineru, HOME is a temporary folder: the owner's library, ~/.mineru, the real MinerU token and
   the real DSH are never touched. Chromium: PLAYWRIGHT_CHROMIUM or the one under ms-playwright. Run `node scripts/build.mjs` first (the page is dist/app.js). */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { StudyService } from '../../lib/service.js';
import { createPreviewServer, previewCall } from '../preview-server.mjs';
import { launchChromium } from './browser.mjs';
import { layoutAudit } from './mineru-layout.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(flag('out', join(root, 'output/qa/mineru-adaptive')));
const quick = args.includes('--quick');
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
const scratch = await mkdtemp(join(tmpdir(), 'mineru-adaptive-qa-'));
process.env.PATH = dirname(process.execPath);
process.env.USERPROFILE = scratch; process.env.HOME = scratch;
delete process.env.MINERU_BIN;
await mkdir(out, { recursive: true });
// Nothing leaves this computer: any request to a host other than the local ones stops the run.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`QA blocked a request to ${url}`);
  return realFetch(input, init);
};

/* ---------- the fake CLI and the seam ---------- */
const work = join(scratch, 'fake-cli');
await mkdir(join(work, 'models', 'MinerU-4_models_onnx'), { recursive: true });
const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
const base = { version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true };
const writeState = async patch => writeFile(statePath, JSON.stringify({ ...base, ...patch }));
await writeState({}); await writeFile(logPath, '');
const cli = { file: process.execPath, prefix: [fileURLToPath(new URL('../../tests/helpers/fake-mineru-cli.mjs', import.meta.url))], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } };
const seam = { limits: { livenessMs: 400, livenessFirstMs: 150, silentMs: 1500, idleProbes: 2 }, local: { cli, home: work, modelsCli: { ...cli } } };
/* QA only: the shipped host has no seam for the CLI or the liveness numbers, so the preview's service is given them here. */
StudyService.prototype.call = function call(action, callArgs = {}) {
  if (!this.runtime.hasAction(action)) return Promise.reject(new Error(`Unknown study action: ${action}`));
  return this.runtime.call(action, callArgs, { ...this.modelOptions, mineru: seam });
};
async function book(pages, title) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) doc.addPage([300, 400]).drawText(`${title}, page ${n}`, { x: 30, y: 340, size: 14, font });
  return Buffer.from(await doc.save());
}

const server = await createPreviewServer({ libraryRoot: join(scratch, 'library'), home: join(scratch, 'home'), port: 4462 });
const call = (action, callArgs) => previewCall(server, action, callArgs);
const problems = [], shots = [];
const jobs = async () => (await call('snapshot')).jobs.filter(job => job.type === 'pdf-convert');
const until = async (condition, what, timeout = 90_000) => { const end = Date.now() + timeout; for (;;) { const value = await condition(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await sleep(100); } };
async function upload(bytes, name) {
  const { uploadId, chunkBytes } = await call('mineru.upload.start', { name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
  await call('mineru.upload.finish', { uploadId });
  return uploadId;
}
const parsesStarted = async () => ((await import('node:fs/promises')).readFile(logPath, 'utf8')).then(text => text.split('\n').filter(line => line.includes('"parse"')).length);

const SITUATIONS = [
  { name: 'queued', state: { trackParses: true, queueMs: 3_600_000 }, zh: /排队中/, en: /Queued/ },
  { name: 'parsing', state: { trackParses: true }, zh: /转换中/, en: /Converting/ },
  { name: 'silent', state: { idleParses: true }, zh: /无响应（已 \d+ 分钟没有新状态）/, en: /No response \(nothing new for \d+ min\)/ },
  { name: 'stopped', state: {}, stopAtWindow: 4, zh: /服务已停止/, en: /Service stopped/ },
  { name: 'unknown', state: { trackParses: true, statusJsonFails: true, listFails: true }, zh: /未知（读不到服务的状态）/, en: /Unknown \(the service status cannot be read\)/ },
];
// A machine that is quick for the first windows (so a pace is measured) and then holds on the fourth window for as long as the picture takes.
const fast = { perPageMs: 90, slowFromPage: 51, slowMs: 3_600_000 };

try {
  const browser = await launchChromium();
  const combos = quick ? [['zh', 'dark', 1440], ['en', 'light', 420]] : ['zh', 'en'].flatMap(lang => ['dark', 'light'].flatMap(theme => [1440, 1194, 420].map(width => [lang, theme, width])));
  const audit = async (tab, where, options) => { const result = await tab.evaluate(layoutAudit, options); for (const text of result.problems) problems.push(`${where}: ${text}`); };
  const noSpill = async (tab, where) => { const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (overflow > 1) problems.push(`${where}: horizontal overflow ${overflow}px`); };
  const hanOutsideData = async (tab, where, selector) => {
    const text = await tab.evaluate(sel => [...document.querySelectorAll(sel)].map(element => element.innerText).join('\n'), selector);
    const leftover = text.split('\n').filter(line => /[㐀-鿿]/.test(line)).filter(line => !/\.pdf/i.test(line));
    if (leftover.length) problems.push(`${where}: Chinese in the English page: ${leftover.slice(0, 3).join(' | ')}`);
  };
  const open = async (lang, theme, width, height = 1000) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
    await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
    const tab = await context.newPage();
    tab.on('pageerror', error => problems.push(`${lang}-${theme}-${width}: ${error.message}`));
    const settle = async (ms = 400) => { await tab.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
    await tab.goto(server.url); await tab.locator('aside, nav').first().waitFor({ timeout: 30_000 }); await settle(800);
    await tab.locator('[data-tour="nav-sources"]').first().click(); await settle(600);
    return { context, tab, settle };
  };

  try {
    /* ---------- the live card, in five situations ---------- */
    for (const situation of SITUATIONS) {
      await writeState({ ...fast, ...situation.state }); await writeFile(logPath, '');
      const started = await call('mineru.import', { uploadId: await upload(await book(120, 'Scanned Textbook'), 'Scanned Textbook.pdf'), route: 'local' });
      // Held on the fourth window: three windows done (so there is a pace, an estimate and a next size), the fourth running and waiting.
      await until(async () => { const job = (await jobs()).find(item => item.id === started.jobId); return job?.local?.window?.index === 4 && job.local.pace ? job : null; }, `${situation.name}: the fourth window`);
      if (situation.stopAtWindow) { await until(async () => (await parsesStarted()) >= situation.stopAtWindow, 'the fourth parse process'); await writeState({ ...fast, running: false }); }
      const expected = situation.name === 'stopped' ? 'stopped' : situation.name;
      const live = await until(async () => { const job = (await jobs()).find(item => item.id === started.jobId); return job?.liveness?.state === expected ? job : null; }, `${situation.name}: the card to say ${expected}`);
      console.log(`${situation.name}: ${live.liveness.state}, window ${live.local.window.startPage}-${live.local.window.endPage}, pace ${live.local.pace.secondsPerPage} s/page, next ${live.local.next} pages, eta ${JSON.stringify(live.local.eta)}`);

      for (const [lang, theme, width] of combos) {
        const label = `${situation.name}-${lang}-${theme}-${width}`;
        const { context, tab, settle } = await open(lang, theme, width);
        try {
          const card = tab.locator('.pdf-convert-jobs .job.running').first();
          await card.waitFor({ timeout: 20_000 });
          // The page polls the snapshot: wait until the card carries the state the situation is held in (the state can change by itself, e.g. quiet -> silent).
          await tab.locator(`.pdf-live[data-state="${expected}"]`).first().waitFor({ timeout: 20_000 });
          await settle(300);
          const text = (await card.innerText()).replace(/\s+/g, ' ');
          if (!(lang === 'en' ? situation.en : situation.zh).test(text)) problems.push(`${label}: the card does not say ${(lang === 'en' ? situation.en : situation.zh)}: ${text.slice(0, 300)}`);
          for (const pattern of lang === 'en' ? [/Piece 4/, /This piece: pages \d+–\d+/, /Next piece: about \d+ pages/, /(About .*|Less than a minute) left/, /This computer takes about/] : [/第 4 段/, /这一段：第 \d+–\d+ 页/, /下一段约 \d+ 页/, /预计还需(约|不到)/, /这台电脑每页约/])
            if (!pattern.test(text)) problems.push(`${label}: the card lacks ${pattern}: ${text.slice(0, 300)}`);
          const shot = async name => { const path = join(out, `${name}-${label}.png`); await card.screenshot({ path }); shots.push(path); };
          await shot('card');
          await audit(tab, `${label}`, { scopes: ['.pdf-convert-jobs > *', '.pdf-live', '.pdf-env'] }); await noSpill(tab, label);
          // The explanation of why a scan can take minutes, opened.
          await tab.locator('.pdf-live__why > summary').first().click(); await settle(200);
          await shot('card-why-open');
          await audit(tab, `${label}/why-open`, { scopes: ['.pdf-convert-jobs > *', '.pdf-live'] }); await noSpill(tab, `${label}/why-open`);
          if (lang === 'en') await hanOutsideData(tab, label, '.pdf-convert-jobs');
          if (situation.name === 'silent' && lang === 'zh' && theme === 'dark' && width === 1440) { const path = join(out, `page-${label}.png`); await tab.screenshot({ path }); shots.push(path); }
        } finally { await context.close(); }
      }
      await call('job.cancel', { jobId: started.jobId });
      await until(async () => (await jobs()).find(item => item.id === started.jobId)?.status === 'cancelled', `${situation.name}: the stop`);
      await call('job.dismiss', { all: true });
      await writeState({});
    }

    /* ---------- a finished conversion: the real timings in its history row ---------- */
    await writeState({ total: 60, perPageMs: 80, overheadMs: 150 }); await writeFile(logPath, '');
    const finished = await call('mineru.import', { uploadId: await upload(await book(60, 'Operating Systems'), 'Operating Systems.pdf'), route: 'local' });
    await until(async () => (await jobs()).find(item => item.id === finished.jobId)?.status === 'complete', 'the finished conversion', 120_000);
    const row = (await call('mineru.history.list')).records.find(record => record.id === finished.jobId);
    if (!(row?.windows?.length >= 3 && row.windows.every(window => window.seconds > 0))) problems.push(`history: the record lacks per-window seconds: ${JSON.stringify(row?.windows)}`);
    if (!(row?.plan?.secondsPerPage > 0)) problems.push(`history: the record lacks the pace: ${JSON.stringify(row?.plan)}`);
    console.log(`history: ${row.windows.map(window => `${window.start}-${window.end} ${window.seconds}s`).join(', ')}; pace ${row.plan.secondsPerPage} s/page`);
    for (const [lang, theme, width] of quick ? [['zh', 'dark', 1440]] : [['zh', 'dark', 1440], ['en', 'light', 420], ['zh', 'light', 420], ['en', 'dark', 1194]]) {
      const label = `history-${lang}-${theme}-${width}`;
      const { context, tab, settle } = await open(lang, theme, width);
      try {
        await tab.locator('.pdf-history summary').first().click(); await settle(400);
        const target = tab.locator('.pdf-history__row', { hasText: 'Operating Systems.pdf' }).first();
        await target.waitFor({ timeout: 15_000 });
        await target.locator('details.pdf-env-details > summary').click(); await settle(200);
        await target.locator('details.pdf-env__windows > summary').click(); await settle(200);
        const text = (await target.innerText()).replace(/\s+/g, ' ');
        for (const pattern of lang === 'en' ? [/about [\d.]+ sec a page/i, /Time per piece/] : [/这台电脑每页约 [\d.]+ 秒/, /各段用时/]) if (!pattern.test(text)) problems.push(`${label}: the row lacks ${pattern}: ${text.slice(0, 300)}`);
        const path = join(out, `${label}.png`); await target.screenshot({ path }); shots.push(path);
        await audit(tab, label, { scopes: ['.pdf-history', '.pdf-history__row', '.pdf-env'] }); await noSpill(tab, label);
        if (lang === 'en') await hanOutsideData(tab, label, '.pdf-history');
      } finally { await context.close(); }
    }

    /* ---------- the plan before it starts ---------- */
    for (const [lang, theme, width] of quick ? [['zh', 'dark', 1440]] : [['zh', 'dark', 1440], ['en', 'light', 420]]) {
      const label = `plan-${lang}-${theme}-${width}`;
      const { context, tab, settle } = await open(lang, theme, width, 900);
      try {
        await tab.locator('[data-tour="sources-add"]').first().click(); await settle(500);
        await tab.locator('dialog[open]').getByRole('button', { name: /用 MinerU 解析|Convert with MinerU/ }).first().click(); await settle(300);
        const pdfPath = join(scratch, 'Plan Preview.pdf');
        await writeFile(pdfPath, await book(300, 'Plan Preview'));
        await tab.locator('dialog[open] input[type="file"][accept=".pdf,application/pdf"]').setInputFiles(pdfPath);
        await tab.locator('dialog[open] .mineru-plan').waitFor({ timeout: 60_000 }); await settle(600);
        const text = (await tab.locator('dialog[open] .mineru-plan').innerText()).replace(/\s+/g, ' ');
        for (const pattern of lang === 'en' ? [/starts with 10 pages/i, /sized to the speed of this computer/i] : [/先做 10 页/, /分段会按这台电脑的速度调整/]) if (!pattern.test(text)) problems.push(`${label}: the plan lacks ${pattern}: ${text}`);
        if (/\d+ 段处理|分 \d+ 段|in \d+ pieces/.test(text)) problems.push(`${label}: the plan still counts windows: ${text}`);
        await tab.locator('dialog[open] .mineru-route-panel').scrollIntoViewIfNeeded();
        const path = join(out, `${label}.png`); await tab.screenshot({ path }); shots.push(path);
        await audit(tab, label, { scopes: ['dialog[open] .mineru-route-panel', '.mineru-plan'] }); await noSpill(tab, label);
        if (lang === 'en') await hanOutsideData(tab, label, 'dialog[open] .mineru-route-panel');
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
} finally {
  await server.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.log(`PROBLEMS:\n- ${problems.join('\n- ')}`); process.exitCode = 1; } else console.log('no page errors, no horizontal overflow, no layout problem, every state said what it should in zh and en');
void previewCall;
