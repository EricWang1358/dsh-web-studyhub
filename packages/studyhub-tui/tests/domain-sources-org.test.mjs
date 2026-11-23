// Consolidated Sources Organization Domain Suite (OrganizeSourcesModal & FolderModal):
// Merged from: round39-folder-ai, round54-org-sources-guard, round62-org-dismiss
// node --test tests/domain-sources-org.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { Store } from '../../../lib/store.js';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-dom-src-org-');

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
    ...extra,
  });
}

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

async function addTextSource(host, title, text) {
  const res = await host.call('source.add', { title, text });
  assert.equal(res.ok, true, `source.add(${title}) failed: ${res.error?.message || ''}`);
  const id = res.value?.source?.id || res.value?.id;
  assert.ok(id, `source.add(${title}) must return source id`);
  return `source:${id}`;
}

function buildFolderSuggestReply(prompt, folderByTitle) {
  const firstBreak = prompt.indexOf('\n');
  const payload = JSON.parse(firstBreak >= 0 ? prompt.slice(0, firstBreak) : prompt);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const assignments = items.map((item) => ({
    id: item.id,
    folder: folderByTitle[item.title] || 'General Topics',
  }));
  const folders = [...new Set(assignments.map((a) => a.folder))];
  return JSON.stringify({ folders, assignments });
}

function createOrganizeCompleteStub(counterRef) {
  return async (system, prompt) => {
    const s = String(system || '');
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    counterRef.calls += 1;
    if (s.includes('Organize study sources into courses')) {
      const req = JSON.parse(p);
      const sources = Array.isArray(req.sources) ? req.sources : [];
      return JSON.stringify({
        proposals: sources.map((src) => ({
          id: src.id,
          courses: String(src.title || '').includes('Linear') ? ['Linear Algebra'] : ['Operating Systems'],
          reason: 'Matched topic keywords',
        })),
      });
    }
    return JSON.stringify({ proposals: [] });
  };
}

function createZeroCallStub(counterRef) {
  return async () => {
    counterRef.calls += 1;
    throw new Error('Unexpected LLM call during pending dismiss flow');
  };
}

async function seedTwoMaterials(host) {
  const s1 = await host.call('source.add', {
    title: 'Linear Algebra Lecture Notes',
    text: '# Eigenvalues and Eigenvectors\nA matrix A satisfies Av = lambda v for nonzero vector v.',
  });
  assert.equal(s1.ok, true, `source.add 1 failed: ${s1.error?.message}`);

  const s2 = await host.call('source.add', {
    title: 'Operating Systems Virtual Memory',
    text: '# Page Tables and TLB\nVirtual addresses translate to physical frames via multi-level page tables.',
  });
  assert.equal(s2.ok, true, `source.add 2 failed: ${s2.error?.message}`);

  const snap = await host.refreshSnapshot();
  assert.equal((snap.snapshot?.sources ?? []).length, 2, 'Expected 2 seeded sources in snapshot');
  return snap.snapshot.sources;
}

async function seedMaterialsAndPending(host, libraryRoot) {
  const sources = await seedTwoMaterials(host);
  const organizeJobId = 'job-org-pending-r62';
  const classifyJobId = 'job-cls-pending-r62';
  const createdAt = '2026-11-22T12:00:00.000Z';

  await new Store(libraryRoot).update((s) => {
    s.settings ||= {};
    s.settings.materialOrganizePending = {
      jobId: organizeJobId,
      createdAt,
      proposals: [
        {
          id: sources[0].id,
          title: sources[0].title,
          courses: ['Linear Algebra'],
          expectedCourses: [],
          reason: 'Covers matrix eigenvalues and linear transforms',
        },
        {
          id: sources[1].id,
          title: sources[1].title,
          courses: ['Operating Systems'],
          expectedCourses: [],
          reason: 'Covers page tables and TLB',
        },
      ],
    };
    const classifyEntry = {
      jobId: classifyJobId,
      createdAt,
      course: '',
      folders: ['Algebra', 'Systems'],
      suggestions: [
        {
          key: `source:${sources[0].id}`,
          title: sources[0].title,
          currentFolder: null,
          suggestedFolder: 'Algebra',
        },
        {
          key: `source:${sources[1].id}`,
          title: sources[1].title,
          currentFolder: null,
          suggestedFolder: 'Systems',
        },
      ],
      unmatchedKeys: [],
    };
    s.settings.materialClassifyPending = classifyEntry;
    s.settings.materialClassifyPendingByCourse = { '*': classifyEntry };
  });

  const snapAfter = await host.refreshSnapshot();
  return {
    organizeJobId,
    classifyJobId,
    snapshot: snapAfter.snapshot,
  };
}

describe('Domain Sources Organization: FolderModal AI, OrganizeSources P2 Guard & Pending Dismiss', () => {
  test('1) Chunk hygiene: OrganizeSourcesModal & FolderModal emit lazy marked-free chunks', () => {
    for (const prefix of ['OrganizeSourcesModal-', 'FolderModal-']) {
      const chunk = distFiles.find((f) => f.startsWith(prefix) && f.endsWith('.mjs'));
      assert.ok(chunk, `dist/ must emit lazy ${prefix}*.mjs chunk, found: ${distFiles.join(', ')}`);
      const code = fs.readFileSync(join(distDir, chunk), 'utf8');
      assert.equal(/\bmarked\b/.test(code), false, `${chunk} must be marked-free`);
      assert.equal(/\bcli-highlight\b/.test(code), false, `${chunk} must not bundle cli-highlight`);
      assert.equal(/\bzod\b/.test(code), false, `${chunk} must not bundle zod`);
      assert.equal(/src\/components\/MarkdownView\.tsx/.test(code), false, `${chunk} must not bundle MarkdownView`);
    }
  });

  test('2) FolderModal integration: source.folder.suggest (read-only) -> source.folder.apply persists on disk', async () => {
    const base = await temps.make('folder-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const folderMap = {
      'OS Kernel Notes': 'Operating Systems',
      'SQL B-Tree Index': 'Databases',
      'TCP Congestion Control': 'Networking',
    };
    let modelCalls = 0;

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (_system, prompt) => {
        modelCalls += 1;
        return buildFolderSuggestReply(prompt, folderMap);
      },
    });

    try {
      const keyOs = await addTextSource(host, 'OS Kernel Notes', 'Virtual memory and page tables.');
      const keyDb = await addTextSource(host, 'SQL B-Tree Index', 'Database indexing and B+ trees.');
      const keyNet = await addTextSource(host, 'TCP Congestion Control', 'AIMD and slow start.');

      const suggestRes = await host.call('source.folder.suggest', {
        mode: 'auto',
        language: 'en',
      });
      assert.equal(suggestRes.ok, true, `source.folder.suggest failed: ${suggestRes.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'source.folder.suggest must invoke model exactly once for <=60 items');

      const suggestions = suggestRes.value?.suggestions;
      assert.ok(Array.isArray(suggestions) && suggestions.length === 3, 'Expected 3 folder suggestions');
      const suggestedFolders = suggestRes.value?.folders;
      assert.ok(Array.isArray(suggestedFolders), 'suggest result must include folders array');
      assert.equal(suggestedFolders.length, 3, 'Expected 3 suggested folders');
      assert.ok(suggestedFolders.includes('Operating Systems'));
      assert.ok(suggestedFolders.includes('Databases'));
      assert.ok(suggestedFolders.includes('Networking'));
      const suggestedByKey = new Map(suggestions.map((s) => [s.key, s]));
      assert.equal(suggestedByKey.get(keyOs)?.suggestedFolder, 'Operating Systems');
      assert.equal(suggestedByKey.get(keyDb)?.suggestedFolder, 'Databases');
      assert.equal(suggestedByKey.get(keyNet)?.suggestedFolder, 'Networking');
      assert.equal(suggestedByKey.get(keyOs)?.currentFolder, null);
      assert.equal(suggestedByKey.get(keyDb)?.currentFolder, null);
      assert.equal(suggestedByKey.get(keyNet)?.currentFolder, null);

      const snapBefore = await host.call('snapshot', {});
      assert.equal(snapBefore.ok, true);
      assert.deepEqual(snapBefore.value?.settings?.materialFolders?.folders ?? [], []);
      assert.deepEqual(snapBefore.value?.settings?.materialFolders?.items ?? {}, {});

      const applyRes = await host.call('source.folder.apply', {
        assignments: suggestions.map((s) => ({ key: s.key, folder: s.suggestedFolder })),
      });
      assert.equal(applyRes.ok, true, `source.folder.apply failed: ${applyRes.error?.message || ''}`);
      assert.equal(applyRes.value?.updated, 3);

      const snapAfter = await host.call('snapshot', {});
      assert.equal(snapAfter.ok, true);
      const mf = snapAfter.value?.settings?.materialFolders;
      assert.ok(mf, 'snapshot.settings.materialFolders must be populated');
      assert.equal(mf.folders.length, 3);
      assert.equal(Object.keys(mf.items).length, 3);
      assert.equal(mf.items[keyOs], 'Operating Systems');
      assert.equal(mf.items[keyDb], 'Databases');
      assert.equal(mf.items[keyNet], 'Networking');
      assert.ok(mf.folders.includes('Operating Systems'));
      assert.ok(mf.folders.includes('Databases'));
      assert.ok(mf.folders.includes('Networking'));

      await host.dispose();
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });
      const reloaded = await host.call('snapshot', {});
      assert.equal(reloaded.ok, true);
      assert.equal(reloaded.value?.settings?.materialFolders?.folders?.length, 3);
      assert.ok(reloaded.value?.settings?.materialFolders?.folders?.includes('Operating Systems'));
      assert.ok(reloaded.value?.settings?.materialFolders?.folders?.includes('Databases'));
      assert.ok(reloaded.value?.settings?.materialFolders?.folders?.includes('Networking'));
      assert.equal(reloaded.value?.settings?.materialFolders?.items?.[keyOs], 'Operating Systems');
      assert.equal(reloaded.value?.settings?.materialFolders?.items?.[keyDb], 'Databases');
      assert.equal(reloaded.value?.settings?.materialFolders?.items?.[keyNet], 'Networking');
    } finally {
      await host.dispose();
    }
  });

  test('3) FolderModal PTY E2E: [g] P2 ConfirmDialog guard, Esc/n cancel (0 calls), busyRef gate, preview discard & Enter/y apply', async () => {
    const baseZh = await temps.make('folder-pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetTuiStore('zh', false, { loading: true });

    const zhFolderMap = {
      'OS Kernel Notes': '操作系统',
      'SQL B-Tree Index': '数据库原理',
      'TCP Congestion Control': '计算机网络',
    };
    let zhModelCalls = 0;
    let releaseSuggest = null;
    let suggestGate = null;

    const hostZh = await createTuiHost({
      libraryRoot: join(baseZh, 'library'),
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, prompt) => {
        zhModelCalls += 1;
        if (suggestGate) await suggestGate;
        return buildFolderSuggestReply(prompt, zhFolderMap);
      },
    });

    const keyOs = await addTextSource(hostZh, 'OS Kernel Notes', 'Virtual memory and scheduling.');
    const keyDb = await addTextSource(hostZh, 'SQL B-Tree Index', 'Indexes and transactions.');
    const keyNet = await addTextSource(hostZh, 'TCP Congestion Control', 'Routing and TCP.');

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;

      await ttyZh.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      ttyZh.send('2');
      await ttyZh.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('OS Kernel Notes'),
        { label: 'zh SourcesView ready' },
      );

      ttyZh.send('F');
      const folderListScreen = await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && s.includes('AI分类'),
        { label: 'zh FolderModal open with [g] AI分类 hint' },
      );
      ttyZh.assertHealthyScreen(folderListScreen, 120, 36, 'zh FolderModal list');
      assert.equal(zhModelCalls, 0, 'Opening FolderModal must make 0 model calls');

      ttyZh.send('g');
      const confirmScreen1 = await ttyZh.waitFor(
        (s) => s.includes('AI 智能文件夹分类') && s.includes('确认应用前不会修改任何文件夹'),
        { label: 'zh P2 ConfirmDialog open after g' },
      );
      ttyZh.assertHealthyScreen(confirmScreen1, 120, 36, 'zh ConfirmDialog');
      assert.equal(zhModelCalls, 0, 'P2 guard: 0 model calls before ConfirmDialog confirmation');

      ttyZh.send('\u001b');
      await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && !s.includes('AI 智能文件夹分类'),
        { label: 'zh ConfirmDialog cancelled with Esc' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling ConfirmDialog with Esc must keep model calls at 0');

      ttyZh.send('g');
      await ttyZh.waitFor((s) => s.includes('AI 智能文件夹分类'), { label: 'zh ConfirmDialog re-open' });
      assert.equal(zhModelCalls, 0, 'Re-opening ConfirmDialog must keep model calls at 0');
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && !s.includes('AI 智能文件夹分类'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling ConfirmDialog with n must keep model calls at 0');

      suggestGate = new Promise((resolveFn) => {
        releaseSuggest = resolveFn;
      });
      ttyZh.send('g');
      await ttyZh.waitFor((s) => s.includes('AI 智能文件夹分类'), { label: 'zh ConfirmDialog before gated y' });
      ttyZh.send('y');
      await ttyZh.waitFor(
        (s) => s.includes('正在调用 AI 生成文件夹建议') && zhModelCalls === 1,
        { label: 'zh FolderModal spinner while suggesting' },
      );
      ttyZh.send('\u001b');
      ttyZh.send('g');
      await ttyZh.flush(25);
      assert.equal(zhModelCalls, 1, 'busyRef must prevent duplicate model calls while running');

      releaseSuggest();
      suggestGate = null;

      const previewScreen = await ttyZh.waitFor(
        (s) => s.includes('AI 文件夹分类预览') && s.includes('→') && s.includes('操作系统') && s.includes('数据库原理'),
        { label: 'zh AI Folder Preview rendered' },
      );
      ttyZh.assertHealthyScreen(previewScreen, 120, 36, 'zh AI Folder Preview');

      ttyZh.send('\u001b');
      await ttyZh.waitFor(
        (s) => s.includes('资料文件夹管理') && !s.includes('AI 文件夹分类预览'),
        { label: 'zh Esc discards preview back to folder list' },
      );
      assert.deepEqual(
        useTuiStore.getState().snapshot?.settings?.materialFolders?.folders ?? [],
        [],
        'Discarding preview with Esc must not persist any folders',
      );

      ttyZh.send('g');
      await ttyZh.waitFor((s) => s.includes('AI 智能文件夹分类'), { label: 'zh ConfirmDialog before apply' });
      ttyZh.send('y');
      await ttyZh.waitFor(
        (s) => s.includes('AI 文件夹分类预览') && s.includes('计算机网络'),
        { label: 'zh AI Folder Preview before Enter' },
      );
      assert.equal(zhModelCalls, 2);

      ttyZh.send('j');
      await ttyZh.flush();
      ttyZh.send('k');
      await ttyZh.flush();

      useTuiStore.setState({ toasts: [] });
      ttyZh.send('\r');
      await ttyZh.waitFor(
        (s) =>
          s.includes('资料文件夹管理') &&
          !s.includes('AI 文件夹分类预览') &&
          s.includes('操作系统') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已应用 3 份资料')),
        { label: 'zh Enter applies AI folder suggestions' },
      );

      const snapZh = useTuiStore.getState().snapshot;
      assert.equal(snapZh?.settings?.materialFolders?.folders?.length, 3);
      assert.ok(snapZh?.settings?.materialFolders?.folders?.includes('操作系统'));
      assert.ok(snapZh?.settings?.materialFolders?.folders?.includes('数据库原理'));
      assert.ok(snapZh?.settings?.materialFolders?.folders?.includes('计算机网络'));
      assert.equal(snapZh?.settings?.materialFolders?.items?.[keyOs], '操作系统');
      assert.equal(snapZh?.settings?.materialFolders?.items?.[keyDb], '数据库原理');
      assert.equal(snapZh?.settings?.materialFolders?.items?.[keyNet], '计算机网络');
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.tone === 'success'));

      ttyZh.send('\u001b');
      await ttyZh.waitFor((s) => !s.includes('资料文件夹管理') && s.includes('学习资料库'), {
        label: 'zh FolderModal closed with Esc',
      });
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.equal(zhModelCalls, 2);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();
    }

    // English --ascii preview [y]-apply and '->' arrow verification
    const baseEn = await temps.make('folder-pty-en');
    const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
    process.env.DSH_HOME = envEn.DSH_HOME;

    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });
    resetTuiStore('en', true, { loading: true });

    const enFolderMap = {
      'OS Kernel Notes': 'Operating Systems',
      'SQL B-Tree Index': 'Databases',
      'TCP Congestion Control': 'Networking',
    };
    let enModelCalls = 0;

    const hostEn = await createTuiHost({
      libraryRoot: join(baseEn, 'library'),
      env: envEn,
      home: baseEn,
      documentsDir: baseEn,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (_system, prompt) => {
        enModelCalls += 1;
        return buildFolderSuggestReply(prompt, enFolderMap);
      },
    });

    const enKeyOs = await addTextSource(hostEn, 'OS Kernel Notes', 'Virtual memory and scheduling.');
    const enKeyDb = await addTextSource(hostEn, 'SQL B-Tree Index', 'Indexes and transactions.');
    const enKeyNet = await addTextSource(hostEn, 'TCP Congestion Control', 'Routing and TCP.');

    const ttyEn = createVirtualTty(120, 36);
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
        stdin: ttyEn.stdin,
        stdout: ttyEn.stdout,
        stderr: ttyEn.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyEn.firstFramePromise;

      await ttyEn.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'en --ascii LibraryView ready',
      });

      ttyEn.send('2');
      await ttyEn.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('OS Kernel Notes'),
        { label: 'en --ascii SourcesView ready' },
      );
      assert.equal(useTuiStore.getState().page, 'sources');

      ttyEn.send('F');
      const enFolderScreen = await ttyEn.waitFor(
        (s) => s.includes('Material Folders') && s.includes('AI Classify'),
        { label: 'en --ascii FolderModal open' },
      );
      ttyEn.assertHealthyScreen(enFolderScreen, 120, 36, 'en --ascii FolderModal 120x36');
      ttyEn.assertAsciiPure(enFolderScreen, 'en --ascii FolderModal 120x36');
      assert.equal(enModelCalls, 0);

      ttyEn.send('g');
      const enConfirmScreen = await ttyEn.waitFor(
        (s) => s.includes('AI Auto-Classify Folders') && s.includes('Preview only - no') && s.includes('Analyze (y)'),
        { label: 'en --ascii ConfirmDialog open' },
      );
      ttyEn.assertHealthyScreen(enConfirmScreen, 120, 36, 'en --ascii ConfirmDialog');
      ttyEn.assertAsciiPure(enConfirmScreen, 'en --ascii ConfirmDialog');
      assert.equal(enModelCalls, 0);

      ttyEn.send('y');
      const enPreviewWide = await ttyEn.waitFor(
        (s) => s.includes('AI Folder Preview') && s.includes('->') && s.includes('Operating Systems') && s.includes('Databases'),
        { label: 'en --ascii AI Folder Preview 120x36' },
      );
      ttyEn.assertHealthyScreen(enPreviewWide, 120, 36, 'en --ascii Preview 120x36');
      ttyEn.assertAsciiPure(enPreviewWide, 'en --ascii Preview 120x36');
      assert.equal(enModelCalls, 1);

      useTuiStore.setState({ toasts: [] });
      ttyEn.send('y');
      const enAfterApply = await ttyEn.waitFor(
        (s) =>
          s.includes('Material Folders') &&
          !s.includes('AI Folder Preview') &&
          s.includes('Operating Systems') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Applied AI folder classification to 3 material(s)')),
        { label: 'en --ascii y applies AI folder suggestions' },
      );
      ttyEn.assertHealthyScreen(enAfterApply, 120, 36, 'en --ascii after apply');
      ttyEn.assertAsciiPure(enAfterApply, 'en --ascii after apply');

      const snapEn = useTuiStore.getState().snapshot;
      assert.equal(snapEn?.settings?.materialFolders?.folders?.length, 3);
      assert.ok(snapEn?.settings?.materialFolders?.folders?.includes('Operating Systems'));
      assert.ok(snapEn?.settings?.materialFolders?.folders?.includes('Databases'));
      assert.ok(snapEn?.settings?.materialFolders?.folders?.includes('Networking'));
      assert.equal(snapEn?.settings?.materialFolders?.items?.[enKeyOs], 'Operating Systems');
      assert.equal(snapEn?.settings?.materialFolders?.items?.[enKeyDb], 'Databases');
      assert.equal(snapEn?.settings?.materialFolders?.items?.[enKeyNet], 'Networking');
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.tone === 'success'));

      ttyEn.send('\u001b');
      await ttyEn.waitFor((s) => !s.includes('Material Folders') && s.includes('Sources'), {
        label: 'en FolderModal closed with Esc',
      });
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.equal(enModelCalls, 1);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyEn.dispose();
      await hostEn.dispose();
    }
  });

  test('4) OrganizeSourcesModal P2 guard PTY E2E: [G] ConfirmDialog (0 calls) -> [n]/[Esc] cancel -> [G]+[y] suggests -> [r] re-confirms', async () => {
    const base = await temps.make('org-e2e-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    const counter = { calls: 0 };

    resetTuiStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: createOrganizeCompleteStub(counter),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    await seedTwoMaterials(host);
    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor(
        () => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot),
        {
          timeoutMs: 8_000,
          label: 'Initial LibraryView zh',
        },
      );

      tty.send('2');
      const sourcesScreen = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && s.includes('Linear Algebra Lecture Notes') && s.includes('Operating Systems Vi') && !s.includes('正在加载页面'),
        { timeoutMs: 8_000, label: 'SourcesView with 2 seeded materials zh' },
      );
      tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView zh');
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.equal(counter.calls, 0, 'SourcesView mount must make 0 model calls');

      tty.send('G');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('AI 分析资料所属课程') && s.includes('将分析 2 份资料并调用 AI') && s.includes('建议课程归属'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal P2 ConfirmDialog zh' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'OrganizeSourcesModal P2 ConfirmDialog zh');
      await tty.flush(20);
      assert.equal(counter.calls, 0, 'Opening OrganizeSourcesModal via [G] MUST make 0 automatic AI calls');
      assert.equal(useTuiStore.getState().snapshot?.settings?.materialOrganizePending, undefined, 'No pending proposals written on [G] open');

      tty.send('n');
      const afterCancelN = await tty.waitFor(
        (s) => !s.includes('AI 分析资料所属课程') && !s.includes('AI 智能整理课程归属') && s.includes('学习资料库') && s.includes('Linear Algebra Lectu'),
        { timeoutMs: 8_000, label: 'SourcesView after [n] cancel' },
      );
      tty.assertHealthyScreen(afterCancelN, 120, 36, 'SourcesView after [n] cancel');
      assert.equal(counter.calls, 0, 'Pressing [n] on ConfirmDialog must make 0 AI calls');

      tty.send('G');
      await tty.waitFor((s) => s.includes('AI 分析资料所属课程'), {
        timeoutMs: 8_000,
        label: 'OrganizeSourcesModal P2 ConfirmDialog reopened',
      });
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('AI 分析资料所属课程') && s.includes('学习资料库') && s.includes('Linear Algebra Lectu'),
        { timeoutMs: 8_000, label: 'SourcesView after Esc cancel' },
      );
      assert.equal(counter.calls, 0, 'Pressing Esc on ConfirmDialog must make 0 AI calls');

      tty.send('G');
      await tty.waitFor((s) => s.includes('AI 分析资料所属课程'), {
        timeoutMs: 8_000,
        label: 'P2 ConfirmDialog before [y]',
      });
      tty.send('y');

      const proposalsScreen = await tty.waitFor(
        (s) =>
          s.includes('AI 智能整理课程归属') &&
          !s.includes('正在分析') &&
          s.includes('建议 2') &&
          s.includes('Linear Algebra') &&
          s.includes('Operating Systems'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal proposals rendered zh' },
      );
      tty.assertHealthyScreen(proposalsScreen, 120, 36, 'OrganizeSourcesModal proposals zh');
      assert.ok(proposalsScreen.includes('Linear Algebra'));
      assert.ok(proposalsScreen.includes('Operating Systems'));
      assert.equal(counter.calls, 1, 'Confirming [G] -> [y] must call model exactly once');
      const snapAfterSuggest = useTuiStore.getState().snapshot;
      assert.equal(snapAfterSuggest?.sources?.length, 2);
      assert.ok((snapAfterSuggest?.sources ?? []).every((src) => (src.courses ?? []).length === 0), 'Suggest must not modify source courses before apply');

      tty.send('r');
      const reanalyzeConfirmScreen = await tty.waitFor(
        (s) => s.includes('AI 分析资料所属课程') && s.includes('重新分析'),
        { timeoutMs: 8_000, label: 'Re-analyze P2 ConfirmDialog zh' },
      );
      tty.assertHealthyScreen(reanalyzeConfirmScreen, 120, 36, 'Re-analyze ConfirmDialog zh');
      await tty.flush(20);
      assert.equal(counter.calls, 1, 'Pressing [r] must open ConfirmDialog with 0 extra AI calls');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('AI 分析资料所属课程') && s.includes('AI 智能整理课程归属') && s.includes('建议 2'),
        { timeoutMs: 8_000, label: 'Back to proposals after [r] -> [n]' },
      );
      assert.equal(counter.calls, 1, 'Cancelling re-analyze with [n] must make 0 extra AI calls');

      tty.send('r');
      await tty.waitFor((s) => s.includes('AI 分析资料所属课程'), {
        timeoutMs: 8_000,
        label: 'Re-analyze ConfirmDialog before [y]',
      });
      tty.send('y');
      // Ensure ConfirmDialog is closed, second model call completed, and proposals re-rendered
      await tty.waitFor(
        (s) =>
          !s.includes('AI 分析资料所属课程') &&
          s.includes('AI 智能整理课程归属') &&
          !s.includes('正在分析') &&
          s.includes('建议 2') &&
          counter.calls === 2,
        { timeoutMs: 8_000, label: 'Proposals re-rendered after [r] -> [y]' },
      );
      assert.equal(counter.calls, 2, 'Confirming [r] -> [y] must invoke model a second time');

      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('AI 智能整理课程归属') && s.includes('学习资料库') && s.includes('Linear Algebra Lectu'),
        { timeoutMs: 8_000, label: 'SourcesView after closing OrganizeSourcesModal' },
      );
      assert.equal(useTuiStore.getState().page, 'sources', 'Closing OrganizeSourcesModal must remain on SourcesView');
      assert.equal(counter.calls, 2, 'Closing OrganizeSourcesModal must not trigger extra model calls');
      assert.ok((useTuiStore.getState().snapshot?.sources ?? []).every((src) => (src.courses ?? []).length === 0), 'Discarding OrganizeSourcesModal must leave source courses unchanged');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore teardown error
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('5) OrganizeSourcesModal empty library (0 materials): skips ConfirmDialog, renders EmptyState with 0 AI calls', async () => {
    const base = await temps.make('org-e2e-empty');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    const counter = { calls: 0 };

    resetTuiStore('en', true);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: createOrganizeCompleteStub(counter),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor(
        () => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot),
        { timeoutMs: 8_000, label: 'Initial LibraryView ready' },
      );
      assert.equal(useTuiStore.getState().page, 'library');
      tty.send('2');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'sources' && (s.includes('0 sources') || s.includes('No materials') || s.includes('Materials')),
        { timeoutMs: 8_000, label: 'Empty SourcesView' },
      );

      tty.send('G');
      const emptyScreen = await tty.waitFor(
        (s) =>
          s.includes('AI Organize Courses') &&
          s.includes('No organization suggestions') &&
          s.includes('No visible materials to organize'),
        { timeoutMs: 8_000, label: 'EmptyState rendered immediately without ConfirmDialog' },
      );
      tty.assertHealthyScreen(emptyScreen, 120, 36, 'OrganizeSourcesModal EmptyState --ascii en');
      tty.assertAsciiPure(emptyScreen, 'OrganizeSourcesModal EmptyState --ascii en');
      assert.ok(!emptyScreen.includes('Analyze 0'), 'Empty library must skip ConfirmDialog');
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.equal((useTuiStore.getState().snapshot?.sources ?? []).length, 0);
      assert.equal(counter.calls, 0, 'Empty library must make 0 AI calls');

      tty.send('r');
      await tty.flush(20);
      assert.ok(!tty.readScreen().includes('AI Organize Materials by Course'), 'Pressing [r] with 0 sources must not open ConfirmDialog');
      assert.equal(counter.calls, 0, 'Pressing [r] on empty library must make 0 AI calls');

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('AI Organize Courses'), { timeoutMs: 8_000 });
      assert.equal(counter.calls, 0, 'Closing empty OrganizeSourcesModal must keep 0 AI calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore teardown error
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('6) Pending dismiss integration (0 model calls): source.organize.dismiss & source.folder.dismiss empty vs seeded', async () => {
    const base = await temps.make('dismiss-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    const counter = { calls: 0 };

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: createZeroCallStub(counter),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    try {
      const emptyOrg = await host.call('source.organize.dismiss', {});
      assert.equal(emptyOrg.ok, true);
      assert.equal(emptyOrg.value?.dismissed, false);

      const emptyCls = await host.call('source.folder.dismiss', {});
      assert.equal(emptyCls.ok, true);
      assert.equal(emptyCls.value?.dismissed, false);

      const seeded = await seedMaterialsAndPending(host, libraryRoot);
      assert.ok(seeded.snapshot?.settings?.materialOrganizePending, 'snapshot must expose materialOrganizePending');
      assert.equal(seeded.snapshot?.settings?.materialOrganizePending?.jobId, seeded.organizeJobId);
      assert.equal(seeded.snapshot?.settings?.materialOrganizePending?.proposals?.length, 2);
      assert.ok(seeded.snapshot?.settings?.materialClassifyPending, 'snapshot must expose materialClassifyPending');
      assert.equal(seeded.snapshot?.settings?.materialClassifyPending?.jobId, seeded.classifyJobId);
      assert.equal(seeded.snapshot?.settings?.materialClassifyPending?.suggestions?.length, 2);
      assert.ok(seeded.snapshot?.settings?.materialClassifyPendingByCourse, 'snapshot must expose materialClassifyPendingByCourse');

      const orgRes = await host.call('source.organize.dismiss', { jobId: seeded.organizeJobId });
      assert.equal(orgRes.ok, true, `source.organize.dismiss failed: ${orgRes.error?.message}`);
      assert.equal(orgRes.value?.dismissed, true);

      const clsRes = await host.call('source.folder.dismiss', {});
      assert.equal(clsRes.ok, true, `source.folder.dismiss failed: ${clsRes.error?.message}`);
      assert.equal(clsRes.value?.dismissed, true);

      const afterSnap = await host.refreshSnapshot();
      assert.equal(afterSnap.snapshot?.settings?.materialOrganizePending, undefined);
      assert.equal(afterSnap.snapshot?.settings?.materialClassifyPending, undefined);
      assert.equal(afterSnap.snapshot?.settings?.materialClassifyPendingByCourse, undefined);
      assert.equal((afterSnap.snapshot?.sources ?? []).length, 2);
      assert.equal(afterSnap.snapshot?.settings?.materialFolders, undefined);

      const secondOrg = await host.call('source.organize.dismiss', {});
      assert.equal(secondOrg.ok, true);
      assert.equal(secondOrg.value?.dismissed, false);

      const secondCls = await host.call('source.folder.dismiss', {});
      assert.equal(secondCls.ok, true);
      assert.equal(secondCls.value?.dismissed, false);

      assert.equal(counter.calls, 0, 'All dismiss operations must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('7) Pending dismiss PTY E2E: G -> pending banner -> X dismiss -> Esc -> F -> pending banner -> X dismiss -> Esc (0 model calls)', async () => {
    const base = await temps.make('dismiss-e2e-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    const counter = { calls: 0 };

    resetTuiStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: createZeroCallStub(counter),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    await seedMaterialsAndPending(host, libraryRoot);

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), {
        timeoutMs: 8_000,
        label: 'Initial LibraryView zh',
      });

      tty.send('2');
      const sourcesScreen = await tty.waitFor(
        (s) => s.includes('Linear Algebra Lecture Notes') && !s.includes('正在加载页面'),
        { timeoutMs: 8_000, label: 'SourcesView zh' },
      );
      tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView zh');
      assert.equal(counter.calls, 0, 'SourcesView mount must make 0 model calls');

      tty.send('G');
      const orgPendingScreen = await tty.waitFor(
        (s) => s.includes('待审归类建议 2') && s.includes('[X] 清除'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal pending banner zh' },
      );
      tty.assertHealthyScreen(orgPendingScreen, 120, 36, 'OrganizeSourcesModal pending zh');
      assert.equal(counter.calls, 0, 'Opening OrganizeSourcesModal pending banner must make 0 model calls');

      tty.send('X');
      const orgDismissedScreen = await tty.waitFor(
        (s) => s.includes('已清除待处理的课程归类建议') && !s.includes('待审归类建议'),
        { timeoutMs: 8_000, label: 'OrganizeSourcesModal dismissed toast zh' },
      );
      tty.assertHealthyScreen(orgDismissedScreen, 120, 36, 'OrganizeSourcesModal dismissed zh');
      assert.equal(counter.calls, 0, 'Dismissing pending organize proposals must make 0 model calls');

      tty.send('\x1b');
      const afterOrgClose = await tty.waitFor(
        (s) => !s.includes('AI 分析资料所属课程') && !s.includes('AI 智能整理课程归属') && s.includes('学习资料库'),
        { timeoutMs: 8_000, label: 'SourcesView after OrganizeSourcesModal Esc zh' },
      );
      tty.assertHealthyScreen(afterOrgClose, 120, 36, 'SourcesView after Org Esc zh');

      tty.send('F');
      const folderPendingScreen = await tty.waitFor(
        (s) => s.includes('待审分夹 2') && s.includes('[X] 清除待审分夹建议'),
        { timeoutMs: 8_000, label: 'FolderModal pending banner zh' },
      );
      tty.assertHealthyScreen(folderPendingScreen, 120, 36, 'FolderModal pending zh');
      assert.equal(counter.calls, 0, 'Opening FolderModal pending banner must make 0 model calls');

      tty.send('X');
      const folderDismissedScreen = await tty.waitFor(
        (s) => s.includes('已清除待审文件夹分类建议') && !s.includes('待审分夹 2'),
        { timeoutMs: 8_000, label: 'FolderModal dismissed toast zh' },
      );
      tty.assertHealthyScreen(folderDismissedScreen, 120, 36, 'FolderModal dismissed zh');
      assert.equal(counter.calls, 0, 'Dismissing pending folder proposals must make 0 model calls');

      tty.send('\x1b');
      const afterFolderClose = await tty.waitFor(
        (s) => !s.includes('资料文件夹管理') && s.includes('学习资料库'),
        { timeoutMs: 8_000, label: 'SourcesView after FolderModal Esc zh' },
      );
      tty.assertHealthyScreen(afterFolderClose, 120, 36, 'SourcesView after Folder Esc zh');

      const finalSnap = await host.refreshSnapshot();
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.equal((finalSnap.snapshot?.sources ?? []).length, 2);
      assert.equal(finalSnap.snapshot?.settings?.materialFolders, undefined);
      assert.equal(finalSnap.snapshot?.settings?.materialOrganizePending, undefined);
      assert.equal(finalSnap.snapshot?.settings?.materialClassifyPending, undefined);
      assert.equal(finalSnap.snapshot?.settings?.materialClassifyPendingByCourse, undefined);
      assert.equal(counter.calls, 0, 'Entire pending dismiss PTY flow must make 0 model calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore teardown errors
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
