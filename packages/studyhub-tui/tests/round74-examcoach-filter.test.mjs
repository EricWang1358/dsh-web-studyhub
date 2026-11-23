// Round 74 Track 3: ExamCoachView `/` Live Filter (Calibration / Variants / Evidence) + HelpOverlay & KEYBINDINGS.md sync
// `node --test --test-concurrency=1 tests/round74-examcoach-filter.test.mjs`
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

// Bundle ExamCoachView pure filter helpers & HelpOverlay from TypeScript source
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r74-coach-unit-'));
const bundleFile = path.join(bundleDir, 'coach-filter.mjs');
await build({
  stdin: {
    contents: [
      `export { filterCoachFamilies, filterCoachWrongItems, filterCoachEvidencePoints } from './src/views/examcoach/ExamCoachView.tsx';`,
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
assert.equal(typeof CoachMod.filterCoachFamilies, 'function', 'ExamCoachView must export filterCoachFamilies');
assert.equal(typeof CoachMod.filterCoachWrongItems, 'function', 'ExamCoachView must export filterCoachWrongItems');
assert.equal(typeof CoachMod.filterCoachEvidencePoints, 'function', 'ExamCoachView must export filterCoachEvidencePoints');
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
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r74-coach-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

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

/** Patch realHost.call for deterministic coach calibration/variants/evidence lists while preserving all TuiHost methods & properties. */
function patchCoachFilterHost(realHost, seed) {
  let currentFamilies = seed.families.map((f) => ({ ...f, confirmations: { ...(f.confirmations || {}) } }));
  const confirmCalls = [];
  const variantCalls = [];
  const practiceCalls = [];
  const origCall = realHost.call.bind(realHost);

  realHost.call = async (action, payload) => {
    if (action === 'coach.calibration.get') {
      return {
        ok: true,
        value: {
          course: payload?.course || seed.course,
          spec: {
            specVersion: 4,
            course: payload?.course || seed.course,
            stage: 'calibrating',
            taskFamilies: currentFamilies,
          },
          evidence: seed.capabilityEvidence,
        },
      };
    }
    if (action === 'coach.calibration.confirm') {
      confirmCalls.push(payload);
      currentFamilies = currentFamilies.map((f) => {
        if (f.id !== payload?.familyId) return f;
        const nextConf = { ...(f.confirmations || {}) };
        if (typeof payload.appearanceApproved === 'boolean') nextConf.appearanceApproved = payload.appearanceApproved;
        if (typeof payload.intentApproved === 'boolean') nextConf.intentApproved = payload.intentApproved;
        if (typeof payload.answerVerified === 'boolean') nextConf.answerVerified = payload.answerVerified;
        const calibrated = Boolean(nextConf.appearanceApproved && nextConf.intentApproved && nextConf.answerVerified);
        const nextSample = payload.revealSampleSolution && f.sample ? { ...f.sample, redacted: false } : f.sample;
        return { ...f, confirmations: nextConf, calibrated, sample: nextSample };
      });
      return {
        ok: true,
        value: {
          spec: {
            specVersion: 4,
            course: payload?.course || seed.course,
            stage: 'calibrating',
            taskFamilies: currentFamilies,
          },
          evidence: seed.capabilityEvidence,
        },
      };
    }
    if (action === 'wrongbook') {
      return { ok: true, value: { items: seed.wrongItems } };
    }
    if (action === 'course.evidence.summary') {
      return { ok: true, value: seed.courseEvidence };
    }
    if (action === 'coach.variants') {
      variantCalls.push(payload);
      return { ok: true, value: { queued: payload?.cards?.length ?? 0 } };
    }
    if (action === 'review.start') {
      practiceCalls.push(payload);
      return { ok: false, error: { message: 'Stubbed point practice target captured' } };
    }
    return origCall(action, payload);
  };

  return { host: realHost, confirmCalls, variantCalls, practiceCalls };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 74 Track 3: ExamCoachView `/` Live Filter + HelpOverlay & KEYBINDINGS.md Sync', () => {
  test('1) Unit: filterCoachFamilies, filterCoachWrongItems, filterCoachEvidencePoints (EN, CJK, empty, no-match) + HelpOverlay/KEYBINDINGS sync', async () => {
    // 1a. filterCoachFamilies
    const families = [
      {
        id: 'fam-paging-01',
        title: '页表与 TLB 地址转换',
        primaryFormat: 'open',
        quota: 4,
        priority: 'high',
        knowledgePoints: ['TLB 命中率', 'Multi-level Paging'],
      },
      {
        id: 'fam-deadlock-02',
        title: 'Banker Algorithm & Deadlock Avoidance',
        primaryFormat: 'case',
        quota: 2,
        priority: 'medium',
        knowledgePoints: ['安全序列', 'Resource Allocation Graph'],
      },
      {
        id: 'fam-mutex-03',
        title: '信号量与 PV 同步',
        primaryFormat: 'quiz',
        quota: 5,
        priority: 'medium',
        knowledgePoints: ['Producer-Consumer'],
      },
    ];

    assert.strictEqual(CoachMod.filterCoachFamilies(families, ''), families, 'empty query must return original families ref');
    assert.strictEqual(CoachMod.filterCoachFamilies(families, '   \t '), families, 'whitespace query must return original families ref');
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, '页表').map((f) => f.id),
      ['fam-paging-01'],
      'CJK title match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'DEADLOCK-02').map((f) => f.id),
      ['fam-deadlock-02'],
      'case-insensitive id match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'CASE').map((f) => f.id),
      ['fam-deadlock-02'],
      'case-insensitive primaryFormat match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'producer-consumer').map((f) => f.id),
      ['fam-mutex-03'],
      'knowledgePoints EN substring match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, '命中率').map((f) => f.id),
      ['fam-paging-01'],
      'knowledgePoints CJK substring match failed',
    );
    assert.deepEqual(CoachMod.filterCoachFamilies(families, 'nonexistent-xyz'), [], 'no-match must return empty array');

    // 1b. filterCoachWrongItems
    const wrongItems = [
      {
        deckId: 'd1',
        cardId: 'card-tlb-99',
        prompt: 'Compute effective access time when TLB hit ratio is 90%',
        topic: '虚拟内存',
        course: '操作系统',
      },
      {
        deckId: 'd2',
        cardId: 'card-memento-12',
        prompt: '如何在不破坏封装的前提下保存快照？',
        topic: 'Memento Pattern',
        course: 'Design Patterns',
      },
    ];

    assert.strictEqual(CoachMod.filterCoachWrongItems(wrongItems, ''), wrongItems, 'empty query must return original wrongItems ref');
    assert.strictEqual(CoachMod.filterCoachWrongItems(wrongItems, '   '), wrongItems, 'whitespace query must return original wrongItems ref');
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, '封装').map((w) => w.cardId),
      ['card-memento-12'],
      'CJK prompt match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'effective access').map((w) => w.cardId),
      ['card-tlb-99'],
      'EN prompt match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'memento pattern').map((w) => w.cardId),
      ['card-memento-12'],
      'topic match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'CARD-TLB-99').map((w) => w.cardId),
      ['card-tlb-99'],
      'cardId match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'design patterns').map((w) => w.cardId),
      ['card-memento-12'],
      'course EN match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, '操作系统').map((w) => w.cardId),
      ['card-tlb-99'],
      'course CJK match failed',
    );
    assert.deepEqual(CoachMod.filterCoachWrongItems(wrongItems, 'zzzz-missing'), [], 'wrongItems no-match must return []');

    // 1c. filterCoachEvidencePoints
    const evidencePoints = [
      {
        hid: 'P1',
        title: 'Bridge 桥接模式与抽象解耦',
        overall: 'shaky',
        gapHint: 'Need timed implementation comparison',
      },
      {
        hid: 'P2',
        title: 'Memento 备忘录状态回滚',
        overall: 'solid',
        gapHint: '注意 Caretaker 与 Originator 职责边界',
      },
      {
        hid: 'P3',
        title: 'Page Replacement Algorithms',
        overall: 'in_progress',
        gapHint: "Belady's anomaly in FIFO",
      },
    ];

    assert.strictEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, ''), evidencePoints, 'empty query must return original evidencePoints ref');
    assert.strictEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, '  '), evidencePoints, 'whitespace query must return original evidencePoints ref');
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, '桥接').map((p) => p.hid),
      ['P1'],
      'evidence CJK title match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'replacement').map((p) => p.hid),
      ['P3'],
      'evidence EN title match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'SHAKY').map((p) => p.hid),
      ['P1'],
      'evidence overall match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'caretaker').map((p) => p.hid),
      ['P2'],
      'evidence CJK/EN gapHint match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'belady').map((p) => p.hid),
      ['P3'],
      'evidence EN gapHint match failed',
    );
    assert.deepEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, 'no-such-point'), [], 'evidence no-match must return []');

    // 1d. HelpOverlay & docs/KEYBINDINGS.md sync
    for (const lang of ['zh', 'en']) {
      const sections = CoachMod.featureShortcuts(lang);
      assert.equal(sections.length, 15, `featureShortcuts(${lang}) must preserve exactly 15 sections`);
      for (const sec of sections) {
        const keys = sec.items.map((i) => i.key);
        const labels = sec.items.map((i) => i.label);
        assert.equal(new Set(keys).size, keys.length, `duplicate key in ${sec.title} (${lang})`);
        assert.equal(new Set(labels).size, labels.length, `duplicate label in ${sec.title} (${lang})`);
      }
      const dashSec = sections.find((s) => s.title.includes('Dashboard'));
      const coachSec = sections.find((s) => s.title.includes('Exam Coach'));
      assert.ok(
        dashSec?.items.some((i) => i.key === '/' && (i.label === '筛选薄弱点与课程' || i.label === 'Filter weak topics & courses')),
        `Dashboard HelpOverlay missing / filter entry (${lang})`,
      );
      assert.ok(
        coachSec?.items.some((i) => i.key === '/' && (i.label === '筛选任务族/错题/考点' || i.label === 'Filter families/variants/points')),
        `Exam Coach HelpOverlay missing / filter entry (${lang})`,
      );
    }

    const keybindingsMd = await readFile(join(pkgRoot, 'docs', 'KEYBINDINGS.md'), 'utf8');
    assert.ok(keybindingsMd.includes('--search <query>'), 'KEYBINDINGS.md must document --search <query>');
    assert.ok(keybindingsMd.includes('--search <query> --json'), 'KEYBINDINGS.md must document --search <query> --json');
    assert.ok(keybindingsMd.includes('--limit <n>'), 'KEYBINDINGS.md must document --limit <n>');
    assert.ok(keybindingsMd.includes('live filter weak topics & courses'), 'KEYBINDINGS.md must document Dashboard / filter');
    assert.ok(keybindingsMd.includes('live filter Calibration families, Variants weak items, or Evidence points'), 'KEYBINDINGS.md must document ExamCoach / filter');
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): ExamCoach `/` live filter across Calibration / Variants / Evidence, Enter commit, Esc clear, shortcut guard & filtered actions', async () => {
    const base = await makeTempDir('pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const realHost = await createTuiHost({
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

    const { host, confirmCalls, variantCalls, practiceCalls } = patchCoachFilterHost(realHost, {
      course: '示例 · Memento 与 Bridge',
      families: [
        {
          id: 'fam-alpha-paging',
          title: '页表地址转换Alpha',
          primaryFormat: 'open',
          quota: 4,
          priority: 'high',
          timeBudgetSec: 180,
          calibrated: false,
          knowledgePoints: ['TLB'],
          confirmations: { appearanceApproved: false, intentApproved: false, answerVerified: false },
        },
        {
          id: 'fam-beta-bridge',
          title: '桥接模式解耦Beta',
          primaryFormat: 'case',
          quota: 2,
          priority: 'medium',
          timeBudgetSec: 240,
          calibrated: false,
          knowledgePoints: ['Abstraction'],
          confirmations: { appearanceApproved: false, intentApproved: false, answerVerified: false },
          sample: { stem: 'Design a Bridge abstraction', redacted: true, answer: 'Separate Implementor' },
        },
      ],
      wrongItems: [
        {
          deckId: 'deck-1',
          cardId: 'card-wrong-alpha',
          topic: 'Memory',
          prompt: 'Alpha wrong card about TLB miss penalty',
          wrongCount: 2,
          lastGrade: 1,
        },
        {
          deckId: 'deck-2',
          cardId: 'card-wrong-zeta',
          topic: 'Design',
          prompt: 'Zeta wrong card about Caretaker snapshot',
          wrongCount: 3,
          lastGrade: 0,
        },
      ],
      courseEvidence: {
        status: 'ok',
        course: '示例 · Memento 与 Bridge',
        points: [
          {
            hid: 'PT-1',
            title: 'AlphaPoint 概念梳理',
            overall: 'solid',
            gapHint: 'Keep practicing',
            cardRefs: [{ deckId: 'deck-1', cardId: 'card-pt-alpha' }],
          },
          {
            hid: 'PT-2',
            title: 'OmegaPoint 迁移推导',
            overall: 'shaky',
            gapHint: 'Need timed transfer',
            cardRefs: [{ deckId: 'deck-2', cardId: 'card-pt-omega' }],
          },
        ],
        summary: { total: 2, unstarted: 0, shaky: 1, in_progress: 0, solid: 1 },
      },
      capabilityEvidence: {
        materialCoverage: { totalSources: 2, totalSections: 4, coveredSections: 3, ratio: 0.75, totalPublishedCards: 10, recallOnlyCardCount: 2, surfaceApplicationCardCount: 3 },
        trainingCoverage: { specVersion: 4, planned: 6, generated: 4, verifiedUsable: 4, practiced: 2 },
        capabilityEvidence: {
          reviewFamiliarity: { reviewedCards: 5, highStabilityCards: 2 },
          sameItemRepeatCount: 0,
          assistedOrExposedCount: 0,
          selfReportedCount: 0,
          unseenIndependentPassCount: 2,
          delayedIndependent: { passedFamilyCount: 1, totalActiveFamilyCount: 2, status: 'progressing' },
          timedIndependent: { passedCount: 2, overBudgetCount: 0, status: 'good' },
          readyForExam: false,
          verdict: 'Need 1 more family pass',
        },
      },
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
      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      // Navigate to ExamCoach ('9')
      tty.send('9');
      const tab1Screen = await tty.waitFor(
        (s) =>
          s.includes('页表地址转换Alpha') &&
          s.includes('桥接模式解耦Beta') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
        { timeoutMs: 10_000, label: 'zh ExamCoach Tab 1 with / hint' },
      );
      tty.assertHealthyScreen(tab1Screen, 120, 36, 'zh Tab 1 initial');

      // Tab 1: Press '/' -> opens inline filter bar, does NOT open CommandPalette
      tty.send('/');
      await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().commandPaletteOpen &&
          useDistTuiStore.getState().inputCaptured &&
          s.includes('[2/2]'),
        { timeoutMs: 5_000, label: 'Tab 1 filter bar opened' },
      );

      // Type 'beta' (contains 'a' which is Analyze shortcut, 'e' which is Edit, etc.) -> must filter live without triggering shortcuts
      tty.send('beta');
      const tab1Filtered = await tty.waitFor(
        (s) =>
          s.includes('[1/2]') &&
          s.includes('桥接模式解耦Beta') &&
          !s.includes('页表地址转换Alpha'),
        { timeoutMs: 5_000, label: 'Tab 1 filtered to Beta' },
      );
      tty.assertHealthyScreen(tab1Filtered, 120, 36, 'zh Tab 1 filtered');
      assert.equal(useDistTuiStore.getState().page, 'examcoach', 'typing filter must stay on examcoach');

      // Enter exits filter input while keeping filterQuery applied
      tty.send('\r');
      await tty.waitFor(
        (s) => !useDistTuiStore.getState().inputCaptured && s.includes('[1/2]') && s.includes('桥接模式解耦Beta'),
        { timeoutMs: 5_000, label: 'Tab 1 filter committed on Enter' },
      );

      // Press 'x' -> must confirm appearanceApproved on the FILTERED family (fam-beta-bridge), not fam-alpha-paging!
      tty.send('x');
      await tty.waitFor(
        () => confirmCalls.some((c) => c.familyId === 'fam-beta-bridge' && c.appearanceApproved === true),
        { timeoutMs: 5_000, label: 'x acted on filtered family fam-beta-bridge' },
      );

      // Press Esc when !filterOpen && filterQuery -> clears active filter and restores both families
      tty.send('\x1b');
      const tab1Restored = await tty.waitFor(
        (s) => !s.includes('[1/2]') && s.includes('页表地址转换Alpha') && s.includes('桥接模式解耦Beta'),
        { timeoutMs: 5_000, label: 'Tab 1 filter cleared via Esc' },
      );
      tty.assertHealthyScreen(tab1Restored, 120, 36, 'zh Tab 1 restored');

      // Switch to Tab 2 (Variants)
      tty.send('2');
      await tty.waitFor(
        (s) =>
          s.includes('Alpha wrong card') &&
          s.includes('Zeta wrong card') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/'),
        { timeoutMs: 5_000, label: 'Tab 2 Variants loaded' },
      );

      // Open filter on Tab 2 and type 'zeta' (contains 'a' - must not trigger anything, narrows to Zeta)
      tty.send('/');
      await tty.waitFor((s) => useDistTuiStore.getState().inputCaptured && s.includes('[2/2]'), { timeoutMs: 5_000, label: 'Tab 2 filter opened' });
      tty.send('zeta');
      const tab2Filtered = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('Zeta wrong card') && !s.includes('Alpha wrong card'),
        { timeoutMs: 5_000, label: 'Tab 2 filtered to Zeta' },
      );
      tty.assertHealthyScreen(tab2Filtered, 120, 36, 'zh Tab 2 filtered');

      // Enter commits, then 'g' queues variant on the filtered Zeta card
      tty.send('\r');
      await tty.waitFor(() => !useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 2 filter committed' });
      tty.send('g');
      await tty.waitFor(
        () => variantCalls.some((v) => v.cards?.[0]?.cardId === 'card-wrong-zeta'),
        { timeoutMs: 5_000, label: 'g queued filtered variant card-wrong-zeta' },
      );

      // Open filter again and press Esc inside filter input -> clears filter & exits filterOpen
      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 2 filter reopened' });
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !useDistTuiStore.getState().inputCaptured && !s.includes('[1/2]') && s.includes('Alpha wrong card'),
        { timeoutMs: 5_000, label: 'Tab 2 Esc inside filter clears & restores' },
      );

      // Switch to Tab 3 (Evidence)
      tty.send('3');
      await tty.waitFor(
        (s) =>
          s.includes('AlphaPoint 概念梳理') &&
          s.includes('OmegaPoint 迁移推导') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/'),
        { timeoutMs: 5_000, label: 'Tab 3 Evidence loaded' },
      );

      // Filter by 'shaky' (matches PT-2 overall)
      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 3 filter opened' });
      tty.send('shaky');
      const tab3Filtered = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('OmegaPoint 迁移推导') && !s.includes('AlphaPoint 概念梳理'),
        { timeoutMs: 5_000, label: 'Tab 3 filtered to shaky OmegaPoint' },
      );
      tty.assertHealthyScreen(tab3Filtered, 120, 36, 'zh Tab 3 filtered');

      // Enter commits, 'p' starts point practice on filtered OmegaPoint!
      tty.send('\r');
      await tty.waitFor(() => !useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 3 filter committed' });
      tty.send('p');
      await tty.waitFor(
        () => practiceCalls.some((p) => p.scope?.[0]?.cardId === 'card-pt-omega'),
        { timeoutMs: 5_000, label: 'p started practice on filtered OmegaPoint' },
      );

      assert.equal(modelCalls, 0, 'ExamCoach `/` filter E2E must invoke 0 model calls');
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

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): ExamCoach `/` filter across tabs + typing shortcut guard (1-4/p/q) + assertAsciiPure', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const realHost = await createTuiHost({
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

    const { host } = patchCoachFilterHost(realHost, {
      course: 'Memento & Bridge',
      families: [
        {
          id: 'fam-1',
          title: 'FirstFamily MCQ',
          primaryFormat: 'quiz',
          quota: 3,
          priority: 'high',
          calibrated: true,
          knowledgePoints: ['Alpha'],
          confirmations: { appearanceApproved: true, intentApproved: true, answerVerified: true },
        },
        {
          id: 'fam-2',
          title: 'SecondFamily 1234q Case',
          primaryFormat: 'case',
          quota: 2,
          priority: 'medium',
          calibrated: false,
          knowledgePoints: ['Gamma'],
          confirmations: { appearanceApproved: false, intentApproved: false, answerVerified: false },
        },
      ],
      wrongItems: [
        { deckId: 'd1', cardId: 'c1', prompt: 'ItemOne Bridge', topic: 'Bridge', wrongCount: 1, lastGrade: 1 },
        { deckId: 'd1', cardId: 'c2', prompt: 'ItemTwo Memento', topic: 'Memento', wrongCount: 2, lastGrade: 0 },
      ],
      courseEvidence: {
        status: 'ok',
        course: 'Memento & Bridge',
        points: [
          { hid: 'E1', title: 'EvFirst', overall: 'solid', gapHint: 'Good' },
          { hid: 'E2', title: 'EvSecond', overall: 'shaky', gapHint: 'Review 4q' },
        ],
        summary: { total: 2, unstarted: 0, shaky: 1, in_progress: 0, solid: 1 },
      },
      capabilityEvidence: null,
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
      const initScreen = await tty.waitFor(
        (s) => s.includes('Exam Coach') && s.includes('FirstFamily MCQ') && s.includes('SecondFamily'),
        { timeoutMs: 10_000, label: 'en ExamCoach 80x24' },
      );
      tty.assertHealthyScreen(initScreen, 80, 24, 'en ASCII ExamCoach 80x24 initial');
      tty.assertAsciiPure(initScreen, 'en ASCII ExamCoach 80x24 initial');

      // Open filter and type '1234q' -> must NOT switch tabs (1-4), must NOT quit (q), must filter to SecondFamily
      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'en filter opened' });
      tty.send('1234q');
      const filteredScreen = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('SecondFamily 1234q') && !s.includes('FirstFamily MCQ'),
        { timeoutMs: 5_000, label: 'en filtered typing 1234q without switching tabs or quitting' },
      );
      tty.assertHealthyScreen(filteredScreen, 80, 24, 'en ASCII ExamCoach 80x24 filtered');
      tty.assertAsciiPure(filteredScreen, 'en ASCII ExamCoach 80x24 filtered');
      assert.equal(useDistTuiStore.getState().page, 'examcoach');

      // Commit with Enter, then Esc clears filter
      tty.send('\r');
      await tty.waitFor(() => !useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'en Enter commit' });
      tty.send('\x1b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[1/2]') && s.includes('FirstFamily MCQ') && s.includes('SecondFamily'),
        { timeoutMs: 5_000, label: 'en Esc clear' },
      );
      tty.assertHealthyScreen(clearedScreen, 80, 24, 'en ASCII ExamCoach 80x24 cleared');
      tty.assertAsciiPure(clearedScreen, 'en ASCII ExamCoach 80x24 cleared');

      // Switch to Variants (2) and Evidence (3) in --ascii en and verify filter works & remains pure ASCII
      tty.send('2');
      await tty.waitFor((s) => s.includes('ItemOne Bridge') && s.includes('ItemTwo Memento'), { timeoutMs: 5_000, label: 'en Variants tab' });
      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'en Variants filter open' });
      tty.send('memento');
      const varFiltered = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('ItemTwo Memento') && !s.includes('ItemOne Bridge'),
        { timeoutMs: 5_000, label: 'en Variants filtered' },
      );
      tty.assertHealthyScreen(varFiltered, 80, 24, 'en ASCII Variants filtered');
      tty.assertAsciiPure(varFiltered, 'en ASCII Variants filtered');
      tty.send('\x1b');
      await tty.waitFor((s) => !useDistTuiStore.getState().inputCaptured && s.includes('ItemOne Bridge'), { timeoutMs: 5_000, label: 'en Variants Esc clear' });

      tty.send('3');
      await tty.waitFor((s) => s.includes('EvFirst') && s.includes('EvSecond'), { timeoutMs: 5_000, label: 'en Evidence tab' });
      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'en Evidence filter open' });
      tty.send('4q');
      const evFiltered = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('EvSecond') && !s.includes('EvFirst'),
        { timeoutMs: 5_000, label: 'en Evidence filtered' },
      );
      tty.assertHealthyScreen(evFiltered, 80, 24, 'en ASCII Evidence filtered');
      tty.assertAsciiPure(evFiltered, 'en ASCII Evidence filtered');

      assert.equal(modelCalls, 0, 'en ASCII ExamCoach `/` filter must invoke 0 model calls');
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
