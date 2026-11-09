import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { LOCAL_MESSAGES, LocalMineruError, explainParseFailure } from '../lib/mineru-local.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { makePdf } from './helpers/pdf.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { patientCli, sleep, until } from './helpers/wait.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const MODELS = 'MinerU-4_models_onnx';
const HAN = /[㐀-鿿]/;

const uiMod = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as CompactJobCard, cardLine } from './ui/tasks/CompactJobCard.jsx';
  export { pdfEtaOf, formatPdfCardEta, runFacts } from './ui/tasks/task-facts.js';
  export { queueLine, queueTip } from './ui/tasks/task-parallel.js';
  export { taskLine } from './ui/tasks/task-summary.js';
  export { default as QueueNote } from './ui/tasks/ParallelParts.jsx';
  export { importSummary, importDoneMessage, itemDetail } from './ui/ImportHub.jsx';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const draw = (element, { data = {}, app = {}, language = 'zh' } = {}) => {
  uiMod.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(uiMod, element, { data, app })); } finally { uiMod.setUiLanguage('zh'); }
};
const stripHtml = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function createPdfHarness(t, { mode = 'legacy', pages = 100, limits = {}, parseWindow, localStatus } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-multi-pdf-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-multi-pdf-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-multi-pdf-work-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  await mkdir(join(work, 'models', MODELS), { recursive: true });
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: pages, modelsReady: true }));
  await writeFile(logPath, '');
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const clock = { ms: Date.now() };
  const service = new StudyService(root, {
    ...switchOptions(mode, { paths: ['pdfConvert'] }),
    mineru: {
      now: () => clock.ms,
      limits: { engineBusyRetries: 3, engineBusyWaitMs: 5, ...limits },
      local: {
        cli,
        home: work,
        modelsCli: { ...cli },
        now: () => clock.ms,
        ...(parseWindow ? { parseWindow } : {}),
        ...(localStatus ? { localStatus } : {}),
      },
    },
  });
  const uploadPdf = async (name, pageCount) => {
    const bytes = await makePdf({ pages: pageCount });
    const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    }
    await service.call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  t.after(async () => {
    await sleep(20);
    service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { service, clock, uploadPdf };
}

/* ---------- 1. Structured JSON parse failures -> plain actionable messages ---------- */

test('explainParseFailure translates engine_unavailable JSON into retryable engine-busy without leaking raw JSON', () => {
  const rawJson = '{ "error": { "type": "engine_error", "code": "engine_unavailable", "message": "Local parse-server is not ready. Please wait or check server status." } }';
  const err = explainParseFailure({ code: 1, stdout: rawJson, stderr: '' });
  assert.ok(err instanceof LocalMineruError);
  assert.equal(err.code, 'engine-busy');
  assert.equal(err.retryable, true);
  assert.equal(err.message, LOCAL_MESSAGES.engineBusy);
  assert.doesNotMatch(err.message, /\{\s*"error"|engine_unavailable/);
  assert.ok(err.detail?.lines?.some(line => line.includes('engine_unavailable')), 'diagnostic log lines are preserved');

  const enMsg = localizeAppMessage(err.message, 'en');
  assert.doesNotMatch(enMsg, HAN);
  assert.match(enMsg, /busy with another task or not ready yet/i);

  const stopped = explainParseFailure({ code: 1, stdout: '{"error":{"code":"NOT_RUNNING","message":"Server is not running"}}', stderr: '' });
  assert.equal(stopped.code, 'server-stopped');

  const otherJson = explainParseFailure({ code: 2, stdout: '{"error":{"code":"corrupt_xref","message":"Page 12 stream truncated"}}', stderr: '' });
  assert.equal(otherJson.code, 'failed');
  assert.match(otherJson.message, /Page 12 stream truncated/);
  assert.doesNotMatch(otherJson.message, /\{\s*"error"/);
});

/* ---------- 2. Engine warm-up / busy auto-wait without halving windows or skewing pace ---------- */

test('a conversion waits automatically when the local engine reports engine-busy during warm-up, without halving windows or inflating pace', async t => {
  let seenWaitingNote = false, attempts = 0;
  let clockRef = null;
  const parseWindow = async ({ startPage, endPage }) => {
    attempts += 1;
    if (attempts <= 2) {
      throw new LocalMineruError('engine-busy', LOCAL_MESSAGES.engineBusy, { retryable: true });
    }
    clockRef.ms += (endPage - startPage + 1) * 1000;
    return {
      content: Array.from({ length: endPage - startPage + 1 }, (_, i) => ({ type: 'text', text: `Page ${startPage + i} body`, page_idx: i })),
      markers: endPage - startPage + 1,
      warnings: [],
    };
  };
  const h = await createPdfHarness(t, { pages: 25, limits: { engineBusyRetries: 4, engineBusyWaitMs: 25 }, parseWindow });
  clockRef = h.clock;

  const uploadId = await h.uploadPdf('WarmupBook.pdf', 25);
  const started = await h.service.call('mineru.import', { uploadId, route: 'local' });
  await until(async () => {
    const snap = await h.service.call('snapshot');
    const job = snap.jobs.find(item => item.id === started.jobId);
    if (job?.note === LOCAL_MESSAGES.waitingEngine || job?.contract?.detail?.note === LOCAL_MESSAGES.waitingEngine) seenWaitingNote = true;
    return job?.status === 'complete';
  }, { timeoutMs: 8_000, stepMs: 5 });

  const snap = await h.service.call('snapshot');
  const finished = snap.jobs.find(item => item.id === started.jobId);
  assert.equal(finished.status, 'complete');
  assert.equal(seenWaitingNote || attempts >= 3, true);
  assert.equal(finished.local?.halved, undefined, 'engine-busy never halves adaptive page windows');
  assert.ok(finished.local?.pace?.secondsPerPage <= 1.2, `wait time did not inflate pace: ${finished.local?.pace?.secondsPerPage}`);
});

test('when engine-busy persists past all retries, the job fails cleanly as retryable with plain Chinese and English copy', async t => {
  const rawJson = '{ "error": { "type": "engine_error", "code": "engine_unavailable", "message": "Local parse-server is not ready." } }';
  const parseWindow = async () => {
    throw explainParseFailure({ code: 1, stdout: rawJson, stderr: '' });
  };
  const h = await createPdfHarness(t, { pages: 20, limits: { engineBusyRetries: 1, engineBusyWaitMs: 5 }, parseWindow });
  const uploadId = await h.uploadPdf('BusyFail.pdf', 20);
  const started = await h.service.call('mineru.import', { uploadId, route: 'local' });
  await until(async () => {
    const job = (await h.service.call('snapshot')).jobs.find(item => item.id === started.jobId);
    return job?.status === 'failed';
  }, { timeoutMs: 8_000, stepMs: 10 });

  const job = (await h.service.call('snapshot')).jobs.find(item => item.id === started.jobId);
  assert.equal(job.errorCode, 'engine-busy');
  assert.equal(job.retryable, true);
  const zhCard = stripHtml(draw(React.createElement(uiMod.CompactJobCard, { job })));
  assert.doesNotMatch(zhCard, /\{\s*"error"|engine_unavailable/);
  assert.match(zhCard, /本机 MinerU 解析引擎正被其他任务占用或尚未就绪/);

  const enCard = stripHtml(draw(React.createElement(uiMod.CompactJobCard, { job }), { language: 'en' })).replace(/BusyFail\.pdf/g, '');
  assert.doesNotMatch(enCard, HAN);
  assert.match(enCard, /busy with another task or not ready yet/i);
});

/* ---------- 3. Concurrent multi-PDF queueing (v1 & v2 runtime contracts + unknown status fallback) ---------- */

for (const mode of ['legacy', 'runtime']) {
  test(`multi-PDF import (${mode}): queues 2nd and 3rd PDFs cleanly even when localStatus times out as unknown during active parsing`, async t => {
    let holdFirst = true, releaseFirst = null;
    let clockRef = null;
    const parseWindow = async ({ startPage, endPage, signal }) => {
      if (holdFirst) {
        holdFirst = false;
        await new Promise((resolve, reject) => {
          releaseFirst = resolve;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      clockRef.ms += (endPage - startPage + 1) * 1000;
      return {
        content: Array.from({ length: endPage - startPage + 1 }, (_, i) => ({ type: 'text', text: `Page ${startPage + i}`, page_idx: i })),
        markers: endPage - startPage + 1,
        warnings: [],
      };
    };
    let statusCalls = 0;
    const localStatus = async () => {
      statusCalls += 1;
      // First PDF sees 'ready'; while PDF 1 saturates CPU, subsequent status checks return 'unknown'
      if (statusCalls === 1) return { state: 'ready', next: null, tier: 'basic', version: '4.0.10' };
      return { state: 'unknown', next: null, tier: null, version: '4.0.10' };
    };
    const h = await createPdfHarness(t, { mode, pages: 40, parseWindow, localStatus });
    clockRef = h.clock;

    const up1 = await h.uploadPdf('Chapter-01.pdf', 30);
    const up2 = await h.uploadPdf('Chapter-02.pdf', 20);
    const up3 = await h.uploadPdf('Chapter-03.pdf', 15);

    const j1 = await h.service.call('mineru.import', { uploadId: up1, route: 'local' });
    await until(() => typeof releaseFirst === 'function', { timeoutMs: 5_000, stepMs: 10 });

    const j2 = await h.service.call('mineru.import', { uploadId: up2, route: 'local' });
    const j3 = await h.service.call('mineru.import', { uploadId: up3, route: 'local' });

    assert.equal(j1.queuedBehind, 0);
    assert.equal(j2.queuedBehind, 1);
    assert.match(j2.next, /排在第 2 位|正在解析「Chapter-01\.pdf」|前面还有 1 份 PDF/);
    assert.equal(j3.queuedBehind, 2);

    const snap = await h.service.call('snapshot');
    const card2 = snap.jobs.find(item => item.id === j2.jobId);
    const card3 = snap.jobs.find(item => item.id === j3.jobId);
    assert.equal(card2.contract.status, 'queued');
    assert.equal(card2.contract.detail.queue?.reason, 'single-engine');
    assert.equal(card2.contract.detail.queue?.head?.title, 'Chapter-01.pdf');
    assert.ok(card2.contract.detail.queue?.aheadSeconds > 0, 'aheadSeconds estimated for queued PDF');
    assert.equal(card3.contract.detail.queue?.count, 2);

    // CompactJobCard + TaskConsole QueueNote in Chinese & English
    const zh2 = stripHtml(draw(React.createElement(uiMod.CompactJobCard, { job: card2 })));
    assert.match(zh2, /排队等待本机引擎（正在解析「Chapter-01\.pdf」，完成后自动开始）/);
    assert.match(zh2, /预计约 .*后完成/);
    assert.doesNotMatch(zh2, /模型额度|要求并行/);

    const zhNote = stripHtml(draw(React.createElement(uiMod.QueueNote, { task: card2 })));
    assert.match(zhNote, /排队等待本机引擎/);
    assert.doesNotMatch(zhNote, /要求并行/);

    const en2 = stripHtml(draw(React.createElement(uiMod.CompactJobCard, { job: card2 }), { language: 'en' })).replace(/Chapter-0[123]\.pdf/g, '');
    const enNote = stripHtml(draw(React.createElement(uiMod.QueueNote, { task: card3 }), { language: 'en' })).replace(/Chapter-0[123]\.pdf/g, '');
    assert.doesNotMatch(en2, HAN);
    assert.doesNotMatch(enNote, HAN);
    assert.match(en2, /Queued for local engine/i);
    assert.match(en2, /Est\. ~/);

    releaseFirst();
    await until(async () => {
      const jobs = (await h.service.call('snapshot')).jobs;
      return [j1.jobId, j2.jobId, j3.jobId].every(id => jobs.find(item => item.id === id)?.status === 'complete');
    }, { timeoutMs: 10_000, stepMs: 20 });
  });
}

/* ---------- 4. Dynamic expected completion time (ticking countdown, overrun extension, probing, English) ---------- */

test('pdfEtaOf and CompactJobCard dynamically tick down inside a window, extend smoothly on slow windows, and localize cleanly', () => {
  const baseNow = Date.UTC(2026, 10, 9, 14, 0, 0);
  const startedIso = new Date(baseNow - 10_000).toISOString();

  // 1) Window 1 speed probing
  const probingJob = {
    id: 'p-probe', type: 'pdf-convert', route: 'local', tier: 'basic', filename: 'Scan.pdf',
    status: 'running', phase: 'local', done: 0, total: 200, chunk: { index: 1, count: 0 },
    local: { adaptive: true, window: { index: 1, startPage: 1, endPage: 10, pages: 10, startedAt: startedIso, expectedSeconds: 50 } },
  };
  const probeEta = uiMod.pdfEtaOf(probingJob, baseNow);
  assert.equal(probeEta.kind, 'probing');
  assert.equal(probeEta.windowLeftSeconds, 40);
  assert.match(uiMod.cardLine(probingJob, baseNow), /首段测速中（约 40 秒后估算总时间）/);

  // Loading past expectedSeconds on Window 1
  const loadingEta = uiMod.pdfEtaOf(probingJob, baseNow + 60_000);
  assert.equal(loadingEta.kind, 'probing-loading');
  assert.match(uiMod.cardLine(probingJob, baseNow + 60_000), /首段加载模型与测速中/);

  // 2) Steady measured ETA ticks down dynamically inside the active window and extends if the window overruns
  const steadyJob = {
    id: 'p-steady', type: 'pdf-convert', route: 'local', tier: 'basic', filename: 'Book.pdf',
    status: 'running', phase: 'local', done: 40, total: 140, chunk: { index: 3, count: 0 },
    local: {
      adaptive: true,
      window: { index: 3, startPage: 41, endPage: 60, pages: 20, startedAt: new Date(baseNow).toISOString(), expectedSeconds: 40 },
      pace: { secondsPerPage: 2, windows: 2 },
      eta: { basis: 'measured', seconds: 200, lowSeconds: 200, highSeconds: 200, stable: true },
    },
  };
  const etaAt0 = uiMod.pdfEtaOf(steadyJob, baseNow);
  const etaAt15 = uiMod.pdfEtaOf(steadyJob, baseNow + 15_000);
  const etaAt30 = uiMod.pdfEtaOf(steadyJob, baseNow + 30_000);
  assert.equal(etaAt0.seconds, 200);
  assert.equal(etaAt15.seconds, 185);
  assert.equal(etaAt30.seconds, 170);
  assert.match(uiMod.cardLine(steadyJob, baseNow + 15_000), /预计约 3 分 5 秒后完成（约 \d{2}:\d{2}）/);

  // Overrun past expectedSeconds (40s): at 60s elapsed vs 80s elapsed, remaining estimate extends smoothly instead of freezing
  const etaOver60 = uiMod.pdfEtaOf(steadyJob, baseNow + 60_000);
  const etaOver80 = uiMod.pdfEtaOf(steadyJob, baseNow + 80_000);
  assert.ok(etaOver80.seconds > etaOver60.seconds, `expected overrun extension: ${etaOver80.seconds} > ${etaOver60.seconds}`);

  // 3) Merge / save phase -> finishing
  const mergingJob = { ...steadyJob, phase: 'merge' };
  assert.equal(uiMod.cardLine(mergingJob, baseNow).includes('即将完成'), true);

  // 4) Engine warming note pauses ticking ETA and translates to English with zero Han characters
  const warmingJob = { ...steadyJob, note: LOCAL_MESSAGES.waitingEngine };
  assert.equal(uiMod.pdfEtaOf(warmingJob, baseNow), null);
  assert.match(uiMod.cardLine(warmingJob, baseNow), /本机解析引擎正忙或正在就绪/);
  const warmingEn = stripHtml(draw(React.createElement(uiMod.CompactJobCard, { job: warmingJob }), { language: 'en' })).replace(/Book\.pdf/g, '');
  assert.doesNotMatch(warmingEn, HAN);
  assert.match(warmingEn, /busy or warming up/i);
});

/* ---------- 5. ImportHub multi-PDF batch summary, itemDetail, and PdfConversion active-engine hint ---------- */

test('ImportHub summarizes multiple queued PDF conversions and PdfConversion warns when the local engine is busy', () => {
  const plainSummary = uiMod.importSummary([{ status: 'done', result: { kind: 'document', title: 'Notes.md', format: 'md', pages: 1, sourceIds: ['s1'] } }]);
  assert.equal('conversions' in plainSummary, false, 'plain imports omit conversions key');

  const firstItem = {
    status: 'done',
    result: { kind: 'conversion', name: 'A.pdf', pages: 120, route: 'local', converter: 'mineru', jobId: 'j1', queuedBehind: 0 },
  };
  const secondItem = {
    status: 'done',
    result: { kind: 'conversion', name: 'B.pdf', pages: 85, route: 'local', converter: 'mineru', jobId: 'j2', queuedBehind: 1 },
  };
  assert.equal(uiMod.itemDetail(firstItem), 'MinerU · 120 页 · 正在后台解析');
  assert.equal(uiMod.itemDetail(secondItem), 'MinerU · 85 页 · 已加入解析队列（前序完成后自动开始）');

  uiMod.setUiLanguage('en');
  try {
    assert.doesNotMatch(uiMod.itemDetail(firstItem), HAN);
    assert.doesNotMatch(uiMod.itemDetail(secondItem), HAN);
    assert.match(uiMod.itemDetail(secondItem), /Queued for conversion/i);
  } finally {
    uiMod.setUiLanguage('zh');
  }

  const batchSummary = uiMod.importSummary([firstItem, secondItem]);
  assert.equal(batchSummary.conversions?.length, 2);
  assert.match(uiMod.importDoneMessage(batchSummary), /2 份 PDF 正在后台用 MinerU 解析，进度在资料页/);

  // PdfConversion shows queue Hint when an active pdf-convert job is already running
  const activeJobs = [{ id: 'j1', type: 'pdf-convert', status: 'running', filename: 'A.pdf', done: 10, total: 120 }];
  const plan = { name: 'B.pdf', pages: 85, bytes: 9 * 1024 * 1024, windows: [{ index: 1, startPage: 1, endPage: 10, pages: 10 }], adaptive: { firstPages: 10, rampPages: [10, 20, 20], targetSeconds: 75, minPages: 5, maxPages: 50 } };
  const readyLocal = { state: 'ready', next: null, tier: 'basic', version: '4.0.10', estimates: { basic: 1.6, standard: 2.5 }, windowPages: 50 };

  const zhPanel = stripHtml(draw(React.createElement(uiMod.PdfConversion, {
    available: true, compact: true, file: { name: 'B.pdf', size: 9 * 1024 * 1024 },
    initialLocal: readyLocal, initialPlan: plan, jobs: activeJobs,
  })));
  assert.match(zhPanel, /当前本机引擎正在解析「A\.pdf」；点开始后会加入队列，前序完成后自动开始/);

  const enPanel = stripHtml(draw(React.createElement(uiMod.PdfConversion, {
    available: true, compact: true, file: { name: 'B.pdf', size: 9 * 1024 * 1024 },
    initialLocal: readyLocal, initialPlan: plan, jobs: activeJobs,
  }), { language: 'en' })).replace(/[AB]\.pdf/g, '');
  assert.doesNotMatch(enPanel, HAN);
  assert.match(enPanel, /currently parsing.*adds it to the queue/i);
});
