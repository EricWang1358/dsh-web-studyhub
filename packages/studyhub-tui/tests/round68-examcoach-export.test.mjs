// Round 68 Track 3: ExamCoachView [X] Atomic Calibration & Learner Profile Markdown Export (0 LLM tokens)
// + HelpOverlay & docs/KEYBINDINGS.md sync:
// `node --test --test-concurrency=1 tests/round68-examcoach-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

// Bundle ExamCoachView & HelpOverlay from TypeScript source to unit-test directly
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r68-coach-unit-'));
const bundleFile = path.join(bundleDir, 'coach.mjs');
await build({
  stdin: {
    contents: [
      `export { formatExamCoachMarkdown } from './src/views/examcoach/ExamCoachView.tsx';`,
      `export { featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(bundleDir, 'node_modules'), 'junction');
const CoachMod = await import(pathToFileURL(bundleFile).href);
assert.equal(typeof CoachMod.formatExamCoachMarkdown, 'function', 'ExamCoachView must export formatExamCoachMarkdown');
assert.equal(typeof CoachMod.featureShortcuts, 'function', 'HelpOverlay must export featureShortcuts');

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
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
      language,
      asciiMode,
    },
  });
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r68-coach-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

function createVirtualTty(cols = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 24;

  const stderr = new PassThrough();
  stderr.isTTY = true;
  stderr.columns = cols;
  stderr.rows = rows;

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  let pendingWrites = Promise.resolve();
  let firstFrameResolve = null;
  let firstFrameSettled = false;
  const firstFramePromise = new Promise((resolveFn) => {
    firstFrameResolve = resolveFn;
  });

  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            resolveWrite();
          });
        }),
    );
  });

  async function flush() {
    await sleep(30);
    await pendingWrites;
  }

  function readLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function readScreen() {
    return readLines().join('\n');
  }

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(30);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, label) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${label}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(!screen.includes('页面渲染异常') && !screen.includes('View Error'), `${label}: error boundary triggered`);
    assert.ok(!screen.includes('TypeError:') && !screen.includes('ReferenceError:'), `${label}: runtime JS error`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
    assert.ok(!screen.includes('\x1b'), `${label}: unparsed escape sequence leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
  }

  function assertAsciiPure(screen, label) {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.ok(!matches, `${label}: leaked non-ASCII UI chrome: ${JSON.stringify([...new Set(matches || [])])}\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
    send,
    waitFor,
    assertHealthyScreen,
    assertAsciiPure,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 68 Track 3: ExamCoachView [X] Atomic Markdown Export & HelpOverlay Sync', () => {
  test('1) Unit: formatExamCoachMarkdown renders zh & en briefings (families table, evidence summary, prefs & bullets) + HelpOverlay/KEYBINDINGS sync', async () => {
    const sampleSpec = {
      specVersion: 3,
      course: '操作系统',
      stage: 'calibrated',
      crunchMode: { enabled: true, remainingMinutes: 90 },
      taskFamilies: [
        {
          id: 'fam-paging',
          title: '页表与 TLB 计算 | Multi-level Paging',
          primaryFormat: 'open',
          quota: 4,
          priority: 'high',
          marksPerItem: 10,
          timeBudgetSec: 180,
          calibrated: true,
          knowledgePoints: ['TLB 命中率', '多级页表'],
          confirmations: { appearanceApproved: true, intentApproved: true, answerVerified: true },
        },
        {
          id: 'fam-sched',
          title: '调度算法对比',
          primaryFormat: 'quiz',
          quota: 3,
          priority: 'medium',
          marksPerItem: 5,
          timeBudgetSec: 90,
          calibrated: false,
          formatTradeoff: 'Prioritize turnaround calculation',
          confirmations: { appearanceApproved: true, intentApproved: false, answerVerified: false },
        },
        {
          id: 'fam-legacy',
          title: '历史概念默写',
          primaryFormat: 'quiz',
          quota: 0,
          priority: 'deferred',
          calibrated: false,
          defects: [{ message: 'Excluded for final sprint' }],
        },
      ],
    };

    const sampleEvidence = {
      materialCoverage: {
        totalSources: 4,
        totalSections: 12,
        coveredSections: 9,
        ratio: 0.75,
        totalPublishedCards: 42,
        recallOnlyCardCount: 8,
        surfaceApplicationCardCount: 14,
      },
      trainingCoverage: {
        specVersion: 3,
        planned: 16,
        generated: 12,
        verifiedUsable: 10,
        practiced: 7,
      },
      capabilityEvidence: {
        reviewFamiliarity: { reviewedCards: 30, highStabilityCards: 18 },
        sameItemRepeatCount: 2,
        assistedOrExposedCount: 1,
        selfReportedCount: 0,
        unseenIndependentPassCount: 6,
        delayedIndependent: { passedFamilyCount: 2, totalActiveFamilyCount: 3, status: 'progressing' },
        timedIndependent: { passedCount: 5, overBudgetCount: 1, status: 'good' },
        misconceptionHypotheses: [
          { misconceptionId: 'm1', reason: 'Confusing physical frame with virtual page', occurrences: 3, confirmedMisconception: true },
        ],
        readyForExam: false,
        verdict: 'Need 1 more delayed family pass',
      },
    };

    const sampleStatus = {
      enabled: true,
      consent: true,
      ready: 2,
      preparing: true,
      preparingCards: ['c-1', 'c-2', 'c-3'],
    };

    const sampleProfile = {
      goal: 'exam',
      summary: 'Strong on concepts, watch off-by-one frame indices',
      preferences: ['Use concrete byte-offset examples', 'Flag edge cases first'],
      bullets: [
        { id: 'b1', text: 'Always separate VPN bits from offset bits before lookup', source: 'user', course: '操作系统' },
        { id: 'b2', text: 'Check TLB miss penalty twice in effective access time', source: 'debrief' },
      ],
    };

    const zhMd = CoachMod.formatExamCoachMarkdown({
      course: '操作系统',
      spec: sampleSpec,
      evidence: sampleEvidence,
      status: sampleStatus,
      profile: sampleProfile,
      lang: 'zh',
      generatedAt: '2026-11-22 21:30',
    });

    assert.ok(zhMd.includes('# 考试教练校准与学习画像'), 'zh title missing');
    assert.ok(zhMd.includes('2026-11-22 21:30'), 'zh date missing');
    assert.ok(zhMd.includes('操作系统'), 'zh course missing');
    assert.ok(zhMd.includes('就绪 2') && zhMd.includes('待备 3') && zhMd.includes('active'), 'zh prep queue status missing');
    assert.ok(zhMd.includes('应付考试'), 'zh learner goal missing');
    assert.ok(zhMd.includes('页表与 TLB 计算 \\| Multi-level Paging'), 'escaped pipe in family title missing');
    assert.ok(zhMd.includes('已确认') && zhMd.includes('待确认') && zhMd.includes('已排除'), 'zh family statuses missing');
    assert.ok(zhMd.includes('9/12 (75%)'), 'zh material coverage missing');
    assert.ok(zhMd.includes('Need 1 more delayed family pass'), 'zh evidence verdict missing');
    assert.ok(zhMd.includes('Confusing physical frame with virtual page'), 'zh misconception hypothesis missing');
    assert.ok(zhMd.includes('Use concrete byte-offset examples'), 'zh preference missing');
    assert.ok(zhMd.includes('Always separate VPN bits from offset bits before lookup'), 'zh memory bullet missing');

    const enMd = CoachMod.formatExamCoachMarkdown({
      course: null,
      spec: sampleSpec,
      evidence: sampleEvidence,
      status: { enabled: true, ready: 1, preparing: false, preparingCards: [] },
      profile: sampleProfile,
      lang: 'en',
      generatedAt: new Date(2026, 10, 22, 8, 5),
    });

    assert.ok(enMd.includes('# Exam Coach Calibration & Learner Profile'), 'en title missing');
    assert.ok(enMd.includes('2026-11-22 08:05'), 'en formatted Date missing');
    assert.ok(enMd.includes('ready: 1, queued: 0, active: no (idle)'), 'en prep queue status missing');
    assert.ok(enMd.includes('Pass Exam'), 'en learner goal missing');
    assert.ok(enMd.includes('| Family (Key) |'), 'en table header missing');
    assert.ok(enMd.includes('Confirmed') && enMd.includes('Pending') && enMd.includes('Excluded'), 'en family statuses missing');
    assert.ok(enMd.includes('## Capability Evidence & Mastery Summary'), 'en evidence section missing');
    assert.ok(enMd.includes('Flag edge cases first'), 'en preference missing');
    assert.ok(enMd.includes('Check TLB miss penalty twice in effective access time'), 'en bullet missing');

    // HelpOverlay & docs/KEYBINDINGS.md sync check
    for (const lang of ['zh', 'en']) {
      const sections = CoachMod.featureShortcuts(lang);
      assert.equal(sections.length, 15);
      const coachSec = sections.find((s) => s.title.includes('Exam Coach'));
      const prepSec = sections.find((s) => s.title.includes('Exam Prep'));
      assert.ok(coachSec?.items.some((i) => i.key === 'X'), `missing [X] in Exam Coach HelpOverlay (${lang})`);
      assert.ok(prepSec?.items.some((i) => i.key === '/ / x'), `missing [/ / x] in Exam Prep HelpOverlay (${lang})`);
    }
    const keybindingsMd = await readFile(join(pkgRoot, 'docs', 'KEYBINDINGS.md'), 'utf8');
    assert.ok(keybindingsMd.includes('studyhub-coach-YYYY-MM-DD.md'), 'KEYBINDINGS.md must document studyhub-coach export');
    assert.ok(keybindingsMd.includes('export exam prep plan Markdown'), 'KEYBINDINGS.md must document exam prep export');
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): load sample -> seed pref & bullet -> ExamCoach (9) -> [X] exports studyhub-coach-*.md (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetDistStore('zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
          onExit: () => inkInst?.unmount(),
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

      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('载入示例课程体验'), { label: 'zh Launchpad' });

      // Load sample course via 's'
      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      // Seed a learner preference and memory bullet via host actions (0 model calls)
      const seededPref = 'Prefer step-by-step invariant checks before final summary';
      const seededBullet = 'Distinguish Originator state creation from Caretaker storage';
      const prefRes = await host.call('coach.preferences', { add: seededPref });
      assert.equal(prefRes.ok, true, prefRes.error?.message);

      const prof0 = await host.call('coach.profile', {});
      assert.equal(prof0.ok, true, prof0.error?.message);
      const rev0 = prof0.value?.memoryRevision ?? 0;
      const bulletRes = await host.call('coach.profile', {
        addBullet: { text: seededBullet },
        expectedRevision: rev0,
      });
      assert.equal(bulletRes.ok, true, bulletRes.error?.message);
      assert.equal(modelCalls, 0, 'Seeding preference & bullet must invoke 0 model calls');

      // Navigate to ExamCoach ('9')
      tty.send('9');
      const coachScreen = await tty.waitFor(
        (s) =>
          s.includes('考试教练') &&
          s.includes('校准与考法') &&
          !s.includes('正在加载考试教练') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'X' && h.label === '导出画像'),
        { timeoutMs: 10_000, label: 'zh ExamCoachView rendered with X hint' },
      );
      tty.assertHealthyScreen(coachScreen, 120, 36, 'zh ExamCoachView 120x36');

      // Press 'X' -> atomic export to studyhub-coach-YYYY-MM-DD.md
      const expectedPath = join(libraryRoot, 'backups', `studyhub-coach-${todayLocalYmd()}.md`);
      tty.send('X');
      const afterExport = await tty.waitFor(
        (s) =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出教练画像') && toast.text.includes(expectedPath)) &&
          s.includes('已导出教练画像'),
        { timeoutMs: 10_000, label: 'zh ExamCoach [X] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh ExamCoachView after [X] export');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# 考试教练校准与学习画像'), 'exported MD must have zh title');
      assert.ok(exportedMd.includes('备题队列状态'), 'exported MD must include prep queue status');
      assert.ok(exportedMd.includes(seededPref), 'exported MD must include seeded preference');
      assert.ok(exportedMd.includes(seededBullet), 'exported MD must include seeded memory bullet');
      assert.equal(modelCalls, 0, 'ExamCoach [X] export must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): ExamCoach (9) -> [X] export -> assertHealthyScreen + assertAsciiPure', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
    let inkInst = null;
    try {
      resetDistStore('en', true);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: true,
          onExit: () => inkInst?.unmount(),
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

      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Load the sample course'), { label: 'en Launchpad' });

      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Memento'),
        { timeoutMs: 12_000, label: 'en sample loaded' },
      );

      tty.send('9');
      const coachScreen = await tty.waitFor(
        (s) => s.includes('Exam Coach') && s.includes('Calibration') && !s.includes('Loading Exam Coach'),
        { timeoutMs: 10_000, label: 'en ExamCoachView 80x24' },
      );
      tty.assertHealthyScreen(coachScreen, 80, 24, 'en ASCII ExamCoachView 80x24');
      tty.assertAsciiPure(coachScreen, 'en ASCII ExamCoachView 80x24');

      const expectedPath = join(libraryRoot, 'backups', `studyhub-coach-${todayLocalYmd()}.md`);
      tty.send('X');
      const afterExport = await tty.waitFor(
        () =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported coach profile ->') &&
                toast.text.includes(expectedPath),
            ),
        { timeoutMs: 10_000, label: 'en ExamCoach [X] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 80, 24, 'en ASCII ExamCoachView after [X] export 80x24');
      tty.assertAsciiPure(afterExport, 'en ASCII ExamCoachView after [X] export 80x24');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# Exam Coach Calibration & Learner Profile'), 'exported MD must have en title');
      assert.ok(exportedMd.includes('Prep Queue Status'), 'exported MD must include prep queue status');
      assert.equal(modelCalls, 0, 'en ExamCoach [X] export must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
