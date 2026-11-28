/* global localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { snapshotJob } from '../lib/job-contract.js';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';
import { openSourcesTools } from './helpers/sources-tools.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export * from './ui/tasks/task-model.js';
      export * from './ui/tasks/task-summary.js';
      export * from './ui/tasks/call-model.js';
      export * from './ui/tasks/task-actions.js';
      export * from './ui/use-material-classify.js';
      export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
      export { default as MaterialCategoryBar } from './ui/MaterialCategoryBar.jsx';
      export { default as Generate } from './ui/Generate.jsx';
      export { default as Sources } from './ui/Sources.jsx';
      export { AppContext } from './ui/app/app-context.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, uiMod, uiMod.exports);
const {
  taskKindOf,
  taskSummary,
  callLabel,
  runnerLabel,
  resultOpener,
  TaskConsole,
  Generate,
  Sources,
  AppContext,
  StudyServicesContext,
  setUiLanguage,
  consumeOpenSourcesOrganize,
} = uiMod.exports;

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;

function wrapApp(node, { data, openAgent = noop, showTask = noop, navigate = noop, act = noop, call = noop, busy = false }) {
  const appValue = {
    data,
    host: { openAgent },
    core: { act, call, busy, refresh: noop, notify: noop, setError: noop },
    nav: { navigate, show: { task: showTask, page: navigate } },
    lib: { taskFocus: null },
    set: {},
    settingsEntry: {},
    learn: {},
  };
  return withStudy(
    StudyServicesContext,
    h(AppContext.Provider, { value: appValue }, node),
    { act, call, busy },
  );
}

/* ---------- 1. TaskConsole Models, Labels, Result Openers & SSR (zh + en) ---------- */

test('TaskConsole models, step labels, subagent/direct method details, AgentLink, and resultOpener work in zh & en with zero Han leak', () => {
  const rawClassifyRunning = snapshotJob({
    id: 'job-mc-run',
    type: 'material-classify',
    course: 'Java Network',
    phase: 'taxonomy',
    done: 0,
    total: 249,
    status: 'running',
    startedAt: '2026-11-18T03:00:00.000Z',
    tokenUsage: { uncachedInputTokens: 1200, outputTokens: 320, calls: 1 },
    steps: [
      {
        id: 'step-tax',
        stage: 'taxonomy',
        status: 'running',
        runtime: 'subagent',
        childId: 'child-tax-1',
        parentId: 'parent-1',
        startedAt: '2026-11-18T03:00:01.000Z',
        tokenUsage: { uncachedInputTokens: 1200, outputTokens: 320 },
      },
    ],
  });

  const rawClassifyDone = snapshotJob({
    id: 'job-mc-done',
    type: 'material-classify',
    course: 'Java Network',
    phase: 'done',
    done: 249,
    total: 249,
    status: 'complete',
    startedAt: '2026-11-18T02:50:00.000Z',
    finishedAt: '2026-11-18T02:52:00.000Z',
    tokenUsage: { uncachedInputTokens: 6400, outputTokens: 1800, calls: 6 },
    steps: [
      {
        id: 'step-tax-done',
        stage: 'taxonomy',
        status: 'complete',
        runtime: 'subagent',
        childId: 'child-tax-done',
        parentId: 'parent-done',
        startedAt: '2026-11-18T02:50:01.000Z',
        finishedAt: '2026-11-18T02:50:12.000Z',
        tokenUsage: { uncachedInputTokens: 1200, outputTokens: 300 },
      },
      {
        id: 'step-batch-1',
        stage: 'classify-batch',
        part: 1,
        parts: 5,
        status: 'complete',
        runtime: 'direct',
        startedAt: '2026-11-18T02:50:13.000Z',
        finishedAt: '2026-11-18T02:50:35.000Z',
        tokenUsage: { uncachedInputTokens: 1100, outputTokens: 290 },
      },
    ],
  });

  const rawOrganizeDone = snapshotJob({
    id: 'job-mo-done',
    type: 'material-organize',
    phase: 'done',
    done: 150,
    total: 150,
    status: 'complete',
    startedAt: '2026-11-18T02:40:00.000Z',
    finishedAt: '2026-11-18T02:42:00.000Z',
    tokenUsage: { uncachedInputTokens: 4500, outputTokens: 900, calls: 3 },
    steps: [
      {
        id: 'step-org-1',
        stage: 'organize-batch',
        part: 1,
        parts: 3,
        status: 'complete',
        runtime: 'subagent',
        childId: 'child-org-1',
        parentId: 'parent-org',
        startedAt: '2026-11-18T02:40:01.000Z',
        finishedAt: '2026-11-18T02:40:40.000Z',
        tokenUsage: { uncachedInputTokens: 1500, outputTokens: 300 },
      },
    ],
  });

  setUiLanguage('zh');
  assert.equal(taskKindOf(rawClassifyRunning), 'material-classify');
  assert.equal(taskKindOf(rawOrganizeDone), 'material-organize');

  const sumRun = taskSummary(rawClassifyRunning);
  assert.equal(sumRun.kindLabel, '资料智能分类');
  assert.equal(sumRun.title, '资料智能分类 · Java Network（249 份）');
  assert.equal(sumRun.line, '归纳主题目录 · 共 249 份资料');

  assert.equal(callLabel({ stage: 'taxonomy', kind: 'other' }), '归纳主题目录');
  assert.equal(callLabel({ stage: 'classify-batch', kind: 'other', part: 2, parts: 5 }), '内容分类第 2/5 批');
  assert.equal(callLabel({ stage: 'organize-batch', kind: 'other', part: 1, parts: 3 }), '课程归属第 1/3 批');
  assert.equal(runnerLabel({ runner: 'subagent' }), 'DSH 子代理');
  assert.equal(runnerLabel({ runner: 'direct' }), '直接模型调用');

  // resultOpener navigates to sources and flags source-organize for material-organize
  const navigated = [];
  const fakeApp = { data: { root: 'r1', settings: {} }, nav: { navigate: page => navigated.push(page) } };
  const classifyOpener = resultOpener(rawClassifyDone, fakeApp);
  assert.equal(classifyOpener.label, '查看分类建议');
  classifyOpener.run();
  assert.equal(navigated.at(-1), 'sources');

  const organizeOpener = resultOpener(rawOrganizeDone, fakeApp);
  assert.equal(organizeOpener.label, '查看归属建议');
  organizeOpener.run();
  assert.equal(navigated.at(-1), 'sources');
  assert.equal(consumeOpenSourcesOrganize(), true, 'sets open signal for <details class="source-organize">');

  // Render TaskConsole SSR for completed material-classify job (shows step trace, 查看后台助手, 在 DSH 中打开完整会话, 查看分类建议)
  const dataDone = { root: 'r1', jobs: [rawClassifyDone], archivedJobs: [], sources: [], drafts: [], decks: [] };
  const openAgent = () => {};
  const consoleZh = renderToStaticMarkup(
    wrapApp(
      h(TaskConsole, {
        data: dataDone,
        openers: { resultOf: job => resultOpener(job, fakeApp), materialOf: () => null },
      }),
      { data: dataDone, openAgent },
    ),
  );
  assert.match(consoleZh, /资料智能分类 · Java Network（249 份）/);
  assert.match(consoleZh, /查看分类建议/);
  assert.match(consoleZh, /执行步骤 2/);
  assert.match(consoleZh, /归纳主题目录/);
  assert.match(consoleZh, /内容分类第 1\/5 批/);
  assert.match(consoleZh, /DSH 子代理/);
  assert.match(consoleZh, /直接模型调用/);
  assert.match(consoleZh, /查看后台助手/);

  // English SSR: zero Han characters!
  try {
    setUiLanguage('en');
    const consoleEn = renderToStaticMarkup(
      wrapApp(
        h(TaskConsole, {
          data: dataDone,
          openers: { resultOf: job => resultOpener(job, fakeApp), materialOf: () => null },
        }),
        { data: dataDone, openAgent },
      ),
    );
    assert.match(consoleEn, /AI material classification · Java Network \(249 materials\)/);
    assert.match(consoleEn, /View category suggestions/);
    assert.match(consoleEn, /Execution steps 2/);
    assert.match(consoleEn, /Build topic taxonomy/);
    assert.match(consoleEn, /Content classification batch 1\/5/);
    assert.match(consoleEn, /DSH subagent/);
    assert.match(consoleEn, /Direct model call/);
    assert.match(consoleEn, /View background assistant/);
    assert.doesNotMatch(consoleEn.replace(/<[^>]+>/g, ' '), han, 'English TaskConsole has zero Han characters');
  } finally {
    setUiLanguage('zh');
  }
});

/* ---------- 2. SSR Progress & Durable Pending Hydration Across Sources & Generate (>100 items unlocked!) ---------- */

test('Sources and Generate hydrate running jobs (taxonomy vs batch) and durable pending proposals in zh & en, and unlock >100 items on 请 AI 建议', () => {
  // Build 125 unfiled sources to prove > 100 items is no longer capped on 请 AI 建议!
  const sources125 = Array.from({ length: 125 }, (_, index) => ({
    id: `s-${index + 1}`,
    title: ` Handout ${index + 1}.md`,
    text: `Content for item ${index + 1}`,
    chars: 500,
    createdAt: '2026-10-01T08:00:00.000Z',
    courses: ['Networks'],
    usedBy: [],
    document: { materialId: `doc-${index + 1}`, format: 'md', filename: `h-${index + 1}.md` },
  }));

  const taxonomyJob = snapshotJob({
    id: 'job-tax',
    type: 'material-classify',
    course: 'Networks',
    phase: 'taxonomy',
    done: 0,
    total: 125,
    status: 'running',
    startedAt: '2026-11-18T03:10:00.000Z',
  });

  const organizeJob = snapshotJob({
    id: 'job-org',
    type: 'material-organize',
    phase: 'batch',
    done: 50,
    total: 125,
    status: 'running',
    startedAt: '2026-11-18T03:11:00.000Z',
  });

  const baseData = {
    root: 'lib-125',
    decks: [],
    drafts: [],
    sources: sources125,
    courses: [{ id: 'c1', name: 'Networks' }],
    focus: { course: 'Networks', courses: [{ name: 'Networks' }] },
    materialFolders: { folders: [], items: {} },
    modelReady: true,
    model: { ready: true, reason: 'ok' },
  };

  setUiLanguage('zh');
  // 1) Taxonomy phase shows "正在归纳主题目录（共 125 份资料）…" instead of frozen 0 / 125, plus 查看任务 & 停止; organize job auto-opens .source-organize!
  const runningData = { ...baseData, jobs: [taxonomyJob, organizeJob], settings: {} };
  const sourcesRunningZh = renderToStaticMarkup(
    wrapApp(h(Sources, { data: runningData, setModal: noop, onGenerate: noop }), { data: runningData }),
  );
  assert.match(sourcesRunningZh, /正在归纳主题目录（共 125 份资料）…/);
  assert.match(sourcesRunningZh, /data-open-classify-task/);
  assert.match(sourcesRunningZh, /data-stop-classify/);
  assert.match(sourcesRunningZh, /<details[^>]*class="source-organize"[^>]*open=""/);
  assert.match(sourcesRunningZh, /正在整理课程归属（50 \/ 125）…/);
  assert.match(sourcesRunningZh, /data-open-organize-task/);
  assert.match(sourcesRunningZh, /data-stop-organize/);

  // 2) Durable pending hydration in BOTH Generate (01 / 选择资料) and Sources (资料)
  const pendingData = {
    ...baseData,
    jobs: [],
    settings: {
      materialClassifyPending: {
        jobId: 'job-tax',
        createdAt: '2026-11-18T03:12:00.000Z',
        course: 'Networks',
        folders: ['Transport Protocols'],
        suggestions: [
          { key: 'doc:doc-1', title: 'Handout 1.md', currentFolder: null, suggestedFolder: 'Transport Protocols' },
          { key: 'doc:doc-2', title: 'Handout 2.md', currentFolder: null, suggestedFolder: 'Transport Protocols' },
        ],
        unmatchedKeys: [],
      },
      materialOrganizePending: {
        jobId: 'job-org',
        createdAt: '2026-11-18T03:13:00.000Z',
        proposals: [
          { id: 's-1', title: 'Handout 1.md', courses: ['Networks'], reason: 'Matches transport syllabus' },
        ],
      },
    },
  };

  const genPendingZh = renderToStaticMarkup(
    wrapApp(
      h(Generate, {
        data: pendingData,
        running: false,
        openDraft: noop,
        setPage: noop,
        genSource: 'files',
        setGenSource: noop,
        gen: { kind: 'mixed', count: 5, difficulty: 'mixed', language: '中文', focus: '', role: '' },
        setGen: noop,
        selectedSources: ['s-1'],
        setSelectedSources: noop,
        setModal: noop,
        openModelSettings: noop,
      }),
      { data: pendingData },
    ),
  );
  assert.match(genPendingZh, /data-classify-phase="review"/);
  assert.match(genPendingZh, /Transport Protocols/);

  const sourcesPendingZh = renderToStaticMarkup(
    wrapApp(h(Sources, { data: pendingData, setModal: noop, onGenerate: noop }), { data: pendingData }),
  );
  assert.match(sourcesPendingZh, /data-classify-phase="review"/);
  assert.match(sourcesPendingZh, /data-organize-phase="review"/);
  assert.match(sourcesPendingZh, /data-discard-organize/);

  // English mode: zero Han characters on running and pending states!
  try {
    setUiLanguage('en');
    const sourcesRunningEn = renderToStaticMarkup(
      wrapApp(h(Sources, { data: runningData, setModal: noop, onGenerate: noop }), { data: runningData }),
    );
    assert.match(sourcesRunningEn, /Building topic taxonomy \(125 materials\)…/);
    assert.match(sourcesRunningEn, /Organizing course assignments \(50 \/ 125\)…/);
    assert.doesNotMatch(sourcesRunningEn.replace(/<[^>]+>/g, ' '), han, 'English running Sources has zero Han characters');

    const sourcesPendingEn = renderToStaticMarkup(
      wrapApp(h(Sources, { data: pendingData, setModal: noop, onGenerate: noop }), { data: pendingData }),
    );
    assert.doesNotMatch(sourcesPendingEn.replace(/<[^>]+>/g, ' '), han, 'English pending Sources has zero Han characters');
  } finally {
    setUiLanguage('zh');
  }
});

/* ---------- 3. Browser E2E: Background Jobs Survival Across Pages, TaskConsole Jump & >100-item Course Organize ---------- */

test('Browser E2E: AI 智能分类 & 整理课程归属 (>100 items) survive page switches, render in 任务 with subagent links, and jump back to review/apply/dismiss', { timeout: 180000 }, async t => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    if (!/Executable doesn't exist|no Chromium/i.test(error.message)) throw error;
    t.skip('Chromium unavailable');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'study-classify-jobs-ui-'));
  const service = new StudyService(join(root, 'library'));
  await service.call('snapshot');

  // Seed 110 sources in Java 八股 (> 100 items to prove the old 100-item cap is gone!)
  await service.store.update(state => {
    for (let i = 1; i <= 110; i++) {
      state.sources.push({
        id: `m-${i}`,
        title: i <= 55 ? `计算机网络专题 ${i}.md` : `并发编程专题 ${i}.md`,
        text: `正文内容 ${i}。`.repeat(10),
        createdAt: '2026-10-01T08:00:00.000Z',
        courses: ['Java 八股'],
        document: { materialId: `doc-m-${i}`, format: 'md', filename: `m-${i}.md` },
      });
    }
    state.courses = [{ id: 'c-java', name: 'Java 八股' }, { id: 'c-net', name: '计算机网络专修' }];
    state.focus = { ...(state.focus || {}), course: 'Java 八股', courses: state.courses };
    state.settings = { ...(state.settings || {}) };
  });

  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({
    libraryRoot: service.store.root,
    home: join(root, 'home'),
    port: 0,
    model: createFakeModel({ latencyMs: 10 }),
    distDir,
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await browser?.close();
    await server.close();
    await service.dispose?.();
    await rm(root, { recursive: true, force: true });
  });

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  let activeSimJob = null;
  let classifyStartArgs = null;
  let organizeStartArgs = null;
  let organizeDismissed = false;
  const cancelledJobIds = [];

  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (req.method() === 'POST' && url.pathname.includes('/api/call')) {
      const body = JSON.parse(req.postData() || '{}');

      if (body.action === 'snapshot') {
        const snap = await service.call('snapshot', activeSimJob ? {} : body.args || {});
        if (snap && !snap.unchanged) {
          snap.modelReady = true;
          snap.model = { ready: true, reason: 'ok', label: 'Preview Fake Model' };
        }
        if (snap && activeSimJob) {
          snap.jobs = [
            ...(Array.isArray(snap.jobs) ? snap.jobs.filter(j => j.id !== activeSimJob.id) : []),
            snapshotJob(activeSimJob),
          ];
          snap.stamp = `${snap.stamp || ''}:${activeSimJob.id}:${activeSimJob.status}:${activeSimJob.phase}:${activeSimJob.done}`;
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: snap }),
        });
      }

      if (body.action === 'job.live.list') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            value: { jobs: activeSimJob ? [snapshotJob(activeSimJob)] : [] },
          }),
        });
      }

      if (body.action === 'job.output') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            value: {
              text: '{"folders":["计算机网络","Java 并发编程"]}',
              nextCursor: 42,
              supported: true,
              ended: activeSimJob?.status === 'complete',
              source: 'session',
            },
          }),
        });
      }

      if (body.action === 'job.control') {
        if (body.args?.action === 'cancel' && activeSimJob?.id === body.args.jobId) {
          cancelledJobIds.push(body.args.jobId);
          activeSimJob = { ...activeSimJob, status: 'cancelled', finishedAt: new Date().toISOString() };
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: { ok: true } }),
        });
      }

      if (body.action === 'source.folder.classify') {
        classifyStartArgs = body.args;
        activeSimJob = {
          id: 'job-classify-110',
          type: 'material-classify',
          course: body.args.course || '',
          phase: 'taxonomy',
          done: 0,
          total: body.args.keys.length,
          status: 'running',
          startedAt: '2026-11-18T04:00:00.000Z',
          tokenUsage: { uncachedInputTokens: 900, outputTokens: 210, calls: 1 },
          steps: [
            {
              id: 'call-tax-1',
              stage: 'taxonomy',
              status: 'running',
              runtime: 'subagent',
              childId: 'subagent-tax-1',
              parentId: 'coord-1',
              startedAt: '2026-11-18T04:00:01.000Z',
              tokenUsage: { uncachedInputTokens: 900, outputTokens: 210 },
            },
          ],
        };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: { job: snapshotJob(activeSimJob), reused: false } }),
        });
      }

      if (body.action === 'source.folder.dismiss') {
        await service.store.update(state => {
          const next = { ...(state.settings || {}) };
          delete next.materialClassifyPending;
          state.settings = next;
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: { dismissed: true } }),
        });
      }

      if (body.action === 'source.folder.apply') {
        await service.store.update(state => {
          const folders = [...new Set(body.args.assignments.map(a => a.folder).filter(Boolean))];
          const items = Object.fromEntries(body.args.assignments.filter(a => a.folder).map(a => [a.key, a.folder]));
          const next = { ...(state.settings || {}), materialFolders: { folders, items } };
          delete next.materialClassifyPending;
          state.settings = next;
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: { updated: body.args.assignments.length } }),
        });
      }

      if (body.action === 'source.organize.start') {
        organizeStartArgs = body.args;
        activeSimJob = {
          id: 'job-organize-110',
          type: 'material-organize',
          phase: 'done',
          done: body.args.sourceIds.length,
          total: body.args.sourceIds.length,
          status: 'complete',
          startedAt: '2026-11-18T04:05:00.000Z',
          finishedAt: '2026-11-18T04:05:10.000Z',
          tokenUsage: { uncachedInputTokens: 2100, outputTokens: 480, calls: 3 },
          steps: [
            {
              id: 'call-org-1',
              stage: 'organize-batch',
              part: 1,
              parts: 3,
              status: 'complete',
              runtime: 'subagent',
              childId: 'subagent-org-1',
              parentId: 'coord-1',
              startedAt: '2026-11-18T04:05:01.000Z',
              finishedAt: '2026-11-18T04:05:09.000Z',
              tokenUsage: { uncachedInputTokens: 2100, outputTokens: 480 },
            },
          ],
        };
        await service.store.update(state => {
          state.settings = {
            ...(state.settings || {}),
            materialOrganizePending: {
              jobId: 'job-organize-110',
              createdAt: '2026-11-18T04:05:10.000Z',
              proposals: [
                { id: 'm-1', title: '计算机网络专题 1.md', courses: ['计算机网络专修'], reason: '网络协议专题资料' },
              ],
            },
          };
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: { job: snapshotJob(activeSimJob), reused: false } }),
        });
      }

      if (body.action === 'source.organize.dismiss') {
        organizeDismissed = true;
        await service.store.update(state => {
          const next = { ...(state.settings || {}) };
          delete next.materialOrganizePending;
          state.settings = next;
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: { dismissed: true } }),
        });
      }
    }
    return route.continue();
  });

  await page.addInitScript(() => {
    localStorage.setItem('study-ui-language', 'zh');
    localStorage.setItem('study-autopilot', 'off');
  });

  await page.goto(server.url);
  await page.locator('aside, nav').first().waitFor();
  await (await revealNavRow(page, 'sources')).click();
  await openSourcesTools(page);
  await page.locator('[data-material-category-bar]').waitFor();

  // 1. Click AI 智能分类 on 110 items -> shows taxonomy progress + 查看任务 + 停止
  await page.locator('[data-ai-classify]').click();
  await page.locator('[data-classify-phase="running"]').waitFor();
  assert.equal(classifyStartArgs.keys.length, 110);
  assert.match(await page.locator('[data-classify-phase="running"]').innerText(), /正在归纳主题目录（共 110 份资料）…/);

  // 2. Click 查看任务 -> jumps to 任务 (TaskConsole) WITHOUT cancelling the job!
  await page.locator('[data-open-classify-task]').click();
  await page.locator('[data-tour="tasks-detail"]').waitFor();
  assert.equal(cancelledJobIds.length, 0, 'switching pages never cancels the background job');
  assert.match(await page.locator('[data-tour="tasks-detail"]').innerText(), /资料智能分类 · Java 八股（110 份）/);
  assert.match(await page.locator('[data-tour="tasks-detail"]').innerText(), /归纳主题目录/);
  assert.match(await page.locator('[data-tour="tasks-detail"]').innerText(), /DSH 子代理/);

  // 3. Complete the classify job on the backend & store materialClassifyPending, then reload/refresh Tasks
  activeSimJob = {
    ...activeSimJob,
    phase: 'done',
    done: 110,
    total: 110,
    status: 'complete',
    finishedAt: '2026-11-18T04:01:00.000Z',
    steps: [
      {
        ...activeSimJob.steps[0],
        status: 'complete',
        finishedAt: '2026-11-18T04:00:15.000Z',
      },
      {
        id: 'call-batch-1',
        stage: 'classify-batch',
        part: 1,
        parts: 2,
        status: 'complete',
        runtime: 'direct',
        startedAt: '2026-11-18T04:00:16.000Z',
        finishedAt: '2026-11-18T04:00:59.000Z',
        tokenUsage: { uncachedInputTokens: 1400, outputTokens: 350 },
      },
    ],
  };
  await service.store.update(state => {
    state.settings = {
      ...(state.settings || {}),
      materialClassifyPending: {
        jobId: 'job-classify-110',
        createdAt: '2026-11-18T04:01:00.000Z',
        course: 'Java 八股',
        folders: ['计算机网络', 'Java 并发'],
        suggestions: [
          { key: 'doc:doc-m-1', title: '计算机网络专题 1.md', currentFolder: null, suggestedFolder: '计算机网络' },
          { key: 'doc:doc-m-56', title: '并发编程专题 56.md', currentFolder: null, suggestedFolder: 'Java 并发' },
        ],
        unmatchedKeys: [],
      },
    };
  });

  // Switch to 出一组新题 (01 / 选择资料): durable pending proposals hydrate there too, and renaming survives switching back to 任务 -> 查看分类建议 -> 资料!
  await (await revealNavRow(page, 'generate')).click();
  await page.locator('[data-tour="generate-sources"] [data-classify-phase="review"]').waitFor();
  const netInputOnGen = page.locator('[data-tour="generate-sources"] [data-classify-group="计算机网络"] input[type="text"]');
  await netInputOnGen.fill('计算机网络核心');

  await (await revealNavRow(page, 'tasks')).click();
  await page.locator('button', { hasText: '查看分类建议' }).click();
  await page.locator('.sources-page [data-classify-phase="review"]').waitFor();
  assert.equal(
    await page.locator('.sources-page [data-classify-group="计算机网络"] input[type="text"]').inputValue(),
    '计算机网络核心',
    'renamed category edit keyed by jobId survives page switches',
  );

  // Apply categories on 资料 -> clears pending review panel and updates folders
  await page.locator('.sources-page [data-apply-classify]').click();
  await page.locator('.sources-page [data-classify-phase="review"]').waitFor({ state: 'detached' });

  // 4. Open 整理课程归属, select all 110 items (> 100!), verify 请 AI 建议 is enabled, start organize job, switch away & jump back via 查看归属建议, then 放弃建议
  await page.locator('details.source-organize > summary').click();
  await page.locator('details.source-organize button', { hasText: '选择当前范围' }).click();
  assert.match(await page.locator('details.source-organize').innerText(), /已选择 110 份资料/);
  const aiOrganizeBtn = page.locator('details.source-organize [data-organize-ai]');
  assert.equal(await aiOrganizeBtn.isDisabled(), false, '请 AI 建议 is enabled for 110 items (>100 cap removed!)');

  await aiOrganizeBtn.click();
  await page.locator('details.source-organize [data-organize-phase="review"]').waitFor();
  assert.equal(organizeStartArgs.sourceIds.length, 110);

  // Jump to 任务, click 查看归属建议 -> lands on 资料 with details.source-organize automatically open and durable proposal intact!
  await (await revealNavRow(page, 'tasks')).click();
  await page.locator('button', { hasText: '查看归属建议' }).click();
  await page.locator('details.source-organize[open] [data-organize-phase="review"]').waitFor();
  assert.match(await page.locator('details.source-organize').innerText(), /计算机网络专修|网络协议专题资料/);

  // Discard course suggestions -> calls source.organize.dismiss and removes review panel
  await page.locator('[data-discard-organize]').click();
  await page.locator('[data-organize-phase="review"]').waitFor({ state: 'detached' });
  assert.equal(organizeDismissed, true);

  assert.deepEqual(errors, []);
});
