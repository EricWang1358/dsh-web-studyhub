// Round 43 Coach Background Prep Consent (coach.consent) & Learner Profile Reset (coach.forget)
// integration + @xterm/headless PTY E2E tests:
// node --test tests/round43-coach-consent.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
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
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round43-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

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

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
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
    resize,
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

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 43: Coach Background Prep Consent & Learner Profile Reset', () => {
  test('1) createTuiHost integration: coach.profile -> coach.consent (true/false) -> coach.preferences + coach.goal -> coach.forget', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const trackingComplete = async () => {
      aiCalls += 1;
      return '';
    };

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: trackingComplete,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      // Initial profile (0 AI calls)
      const prof0 = await host.call('coach.profile', {});
      assert.equal(prof0.ok, true, prof0.error?.message);
      assert.notEqual(prof0.value?.consent, true);
      assert.equal(prof0.value?.goal, '');
      assert.deepEqual(prof0.value?.preferences, []);
      const rev0 = prof0.value?.memoryRevision ?? 0;
      assert.equal(aiCalls, 0, 'coach.profile must make 0 AI calls');

      // Enable consent: coach.consent { prep: true }
      const consentOn = await host.call('coach.consent', { prep: true });
      assert.equal(consentOn.ok, true, consentOn.error?.message);
      assert.equal(consentOn.value?.consent, true);

      const profAfterOn = await host.call('coach.profile', {});
      assert.equal(profAfterOn.ok, true);
      assert.equal(profAfterOn.value?.consent, true);

      // Wait for any background prep triggered by sample wrong attempts to settle
      for (let i = 0; i < 40; i += 1) {
        const st = await host.call('coach.status', {});
        if (st.ok && !st.value?.preparing) break;
        await sleep(50);
      }

      // Disable consent: coach.consent { prep: false } (0 AI calls)
      const callsBeforeOff = aiCalls;
      const consentOff = await host.call('coach.consent', { prep: false });
      assert.equal(consentOff.ok, true, consentOff.error?.message);
      assert.equal(consentOff.value?.consent, false);

      const profAfterOff = await host.call('coach.profile', {});
      assert.equal(profAfterOff.ok, true);
      assert.equal(profAfterOff.value?.consent, false);
      assert.equal(aiCalls, callsBeforeOff, 'coach.consent { prep: false } must make 0 AI calls');

      // Populate preferences + goal (0 AI calls)
      const prefRes = await host.call('coach.preferences', { add: 'Explain with concrete edge cases' });
      assert.equal(prefRes.ok, true, prefRes.error?.message);
      assert.deepEqual(prefRes.value?.preferences, ['Explain with concrete edge cases']);

      const goalRes = await host.call('coach.goal', { goal: 'exam', expectedRevision: prefRes.value?.memoryRevision });
      assert.equal(goalRes.ok, true, goalRes.error?.message);
      assert.equal(goalRes.value?.goal, 'exam');
      const revBeforeForget = goalRes.value?.memoryRevision;
      assert.equal(revBeforeForget, rev0 + 2);
      assert.equal(aiCalls, callsBeforeOff, 'coach.preferences + coach.goal must make 0 AI calls');

      // Record a review start to verify practice history/decks remain intact across coach.forget
      const snapBefore = await host.call('snapshot', {});
      assert.equal(snapBefore.ok, true);
      const deckCountBefore = snapBefore.value?.decks?.length ?? 0;
      assert.ok(deckCountBefore > 0);
      const runStart = await host.call('review.start', { mode: 'path', deckId: snapBefore.value.decks[0].id });
      assert.equal(runStart.ok, true, runStart.error?.message);

      // Forget learner profile (0 AI calls)
      const forgetRes = await host.call('coach.forget', {});
      assert.equal(forgetRes.ok, true, forgetRes.error?.message);
      assert.deepEqual(forgetRes.value?.preferences, []);
      assert.equal(forgetRes.value?.goal, '');
      assert.notEqual(forgetRes.value?.consent, true);
      assert.equal(forgetRes.value?.ready, 0);
      assert.equal(forgetRes.value?.memoryRevision, revBeforeForget + 1);
      assert.equal(aiCalls, callsBeforeOff, 'coach.forget must make 0 AI calls');

      const profAfterForget = await host.call('coach.profile', {});
      assert.equal(profAfterForget.ok, true);
      assert.deepEqual(profAfterForget.value?.preferences, []);
      assert.equal(profAfterForget.value?.goal, '');
      assert.notEqual(profAfterForget.value?.consent, true);
      assert.equal(profAfterForget.value?.memoryRevision, revBeforeForget + 1);

      // Decks & runs stay intact
      const snapAfter = await host.call('snapshot', {});
      assert.equal(snapAfter.ok, true);
      assert.equal(snapAfter.value?.decks?.length, deckCountBefore);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: CoachPreferencesModal [p] consent (ConfirmDialog on opt-in, direct off) & [F] danger reset in zh and --ascii en (120x36 & 80x24)', async () => {
    // 2a) Default (zh) mode
    const zhBase = await makeTempDir('pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: zhDshHome } },
    );

    let zhAiCalls = 0;
    const zhHost = await createTuiHost({
      libraryRoot: join(zhBase, 'library'),
      env: { ...process.env, DSH_HOME: zhDshHome },
      home: join(zhBase, 'home'),
      documentsDir: zhBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        zhAiCalls += 1;
        return '';
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const zhTty = createVirtualTty(120, 36);
    let zhInk = null;
    try {
      resetDistStore('zh', false);
      zhInk = render(
        React.createElement(StudyHubTuiApp, {
          host: zhHost,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
          onExit: () => zhInk?.unmount(),
        }),
        {
          stdin: zhTty.stdin,
          stdout: zhTty.stdout,
          stderr: zhTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await zhTty.firstFramePromise;

      await zhTty.waitFor((s) => s.includes('载入示例课程体验'), { label: 'zh Launchpad render' });
      zhTty.send('s');
      await zhTty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      zhTty.send('9');
      await zhTty.waitFor(
        (s) => s.includes('考试教练') && s.includes('校准与考法') && !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'zh ExamCoachView rendered' },
      );

      zhTty.send('p');
      const zhPrefs0 = await zhTty.waitFor(
        (s) => s.includes('学习者画像与长期偏好') && s.includes('[p] 后台备题: OFF') && !s.includes('正在读取学习者画像'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal opened with prep OFF' },
      );
      zhTty.assertHealthyScreen(zhPrefs0, 120, 36, 'zh CoachPreferencesModal initial');

      // Press [p] -> opt-in ConfirmDialog -> cancel with 'n'
      zhTty.send('p');
      const zhConsentDlg1 = await zhTty.waitFor(
        (s) => s.includes('开启后台变式备题') && s.includes('调用 AI'),
        { timeoutMs: 5_000, label: 'zh consent opt-in ConfirmDialog opened (n test)' },
      );
      zhTty.assertHealthyScreen(zhConsentDlg1, 120, 36, 'zh consent ConfirmDialog 120x36');
      zhTty.send('n');
      await zhTty.waitFor(
        (s) => !s.includes('开启后台变式备题') && s.includes('[p] 后台备题: OFF'),
        { timeoutMs: 5_000, label: 'zh consent ConfirmDialog cancelled via n' },
      );

      // Press [p] -> opt-in ConfirmDialog -> cancel with Esc (modal must remain open!)
      zhTty.send('p');
      await zhTty.waitFor((s) => s.includes('开启后台变式备题'), { timeoutMs: 5_000, label: 'zh consent ConfirmDialog reopened (Esc test)' });
      zhTty.send('\x1b');
      await zhTty.waitFor(
        (s) => !s.includes('开启后台变式备题') && s.includes('学习者画像与长期偏好') && s.includes('[p] 后台备题: OFF'),
        { timeoutMs: 5_000, label: 'zh consent ConfirmDialog cancelled via Esc while keeping modal open' },
      );

      // Press [p] -> confirm with 'y' -> ON (0 AI calls happened before opt-in confirm!)
      assert.equal(zhAiCalls, 0, 'cancelling opt-in ConfirmDialog via n/Esc must make 0 AI calls');
      zhTty.send('p');
      await zhTty.waitFor((s) => s.includes('开启后台变式备题'), { timeoutMs: 5_000, label: 'zh consent ConfirmDialog reopened (y test)' });
      zhTty.send('y');
      const zhConsentOn = await zhTty.waitFor(
        (s) => !s.includes('开启后台变式备题') && s.includes('[p] 后台备题: ON'),
        { timeoutMs: 8_000, label: 'zh consent turned ON' },
      );
      zhTty.assertHealthyScreen(zhConsentOn, 120, 36, 'zh CoachPreferencesModal prep ON');

      let prof = await zhHost.call('coach.profile', {});
      assert.equal(prof.value?.consent, true);

      // Press [p] while ON -> directly turns OFF without ConfirmDialog
      zhTty.send('p');
      const zhConsentOff = await zhTty.waitFor(
        (s) => s.includes('[p] 后台备题: OFF') && !s.includes('开启后台变式备题'),
        { timeoutMs: 8_000, label: 'zh consent turned OFF directly' },
      );
      zhTty.assertHealthyScreen(zhConsentOff, 120, 36, 'zh CoachPreferencesModal prep OFF');

      prof = await zhHost.call('coach.profile', {});
      assert.equal(prof.value?.consent, false);

      // Wait for any background prep from earlier opt-in to settle, then ensure forget makes 0 AI calls
      for (let i = 0; i < 40; i += 1) {
        const st = await zhHost.call('coach.status', {});
        if (st.ok && !st.value?.preparing) break;
        await sleep(50);
      }
      const zhCallsBeforeForgetFlow = zhAiCalls;

      // Populate goal & preference, verify 80x24 narrow layout before forget
      zhTty.send('g');
      await zhTty.waitFor((s) => s.includes('[g] 目标: 应付考试'), { timeoutMs: 5_000, label: 'zh goal set to exam' });

      zhTty.send('a');
      await zhTty.waitFor((s) => s.includes('新增偏好'), { timeoutMs: 5_000, label: 'zh add preference opened' });
      zhTty.send('多做工程案例');
      await zhTty.waitFor((s) => s.includes('多做工程案例'), { timeoutMs: 5_000, label: 'zh preference typed' });
      zhTty.send('\r');
      await zhTty.waitFor(
        (s) => !s.includes('新增偏好') && s.includes('1/12') && s.includes('多做工程案例'),
        { timeoutMs: 8_000, label: 'zh preference saved' },
      );

      // Check 80x24 layout with forget ConfirmDialog
      zhTty.resize(80, 24);
      const zhNarrow = await zhTty.waitFor(
        (s) => s.includes('[p] 后台备题: OFF') && s.split('\n').length <= 24,
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal at 80x24' },
      );
      zhTty.assertHealthyScreen(zhNarrow, 80, 24, 'zh CoachPreferencesModal 80x24');

      // Press [F] -> danger ConfirmDialog -> cancel on 'n', then 'Esc', then confirm on 'y'
      zhTty.send('F');
      const zhForgetDlg = await zhTty.waitFor(
        (s) => s.includes('重置学习者画像') && s.includes('历史练习记录'),
        { timeoutMs: 5_000, label: 'zh forget danger ConfirmDialog at 80x24' },
      );
      zhTty.assertHealthyScreen(zhForgetDlg, 80, 24, 'zh forget ConfirmDialog 80x24');

      zhTty.send('n');
      await zhTty.waitFor(
        (s) => !s.includes('历史练习记录与题库完整保留') && s.includes('多做工程案例') && s.includes('[g] 目标: 应付考试'),
        { timeoutMs: 5_000, label: 'zh forget ConfirmDialog cancelled via n' },
      );

      zhTty.send('F');
      await zhTty.waitFor((s) => s.includes('历史练习记录与题库完整保留'), { timeoutMs: 5_000, label: 'zh forget ConfirmDialog reopened for Esc' });
      zhTty.send('\x1b');
      await zhTty.waitFor(
        (s) => !s.includes('历史练习记录与题库完整保留') && s.includes('学习者画像与长期偏好') && s.includes('多做工程案例'),
        { timeoutMs: 5_000, label: 'zh forget ConfirmDialog cancelled via Esc' },
      );

      zhTty.send('F');
      await zhTty.waitFor((s) => s.includes('历史练习记录与题库完整保留'), { timeoutMs: 5_000, label: 'zh forget ConfirmDialog reopened for y' });
      zhTty.send('y');
      const zhAfterForget = await zhTty.waitFor(
        (s) => !s.includes('历史练习记录与题库完整保留') && s.includes('[g] 目标: 未设定') && s.includes('0/12'),
        { timeoutMs: 8_000, label: 'zh profile forgotten via ConfirmDialog' },
      );
      zhTty.assertHealthyScreen(zhAfterForget, 80, 24, 'zh CoachPreferencesModal after forget 80x24');

      const zhProfFinal = await zhHost.call('coach.profile', {});
      assert.equal(zhProfFinal.value?.goal, '');
      assert.deepEqual(zhProfFinal.value?.preferences, []);
      assert.equal(zhProfFinal.value?.memoryRevision, 3);
      assert.equal(zhAiCalls, zhCallsBeforeForgetFlow, 'goal + preference + forget must make 0 AI calls');
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }

    // 2b) --ascii (en) mode at 120x36 & 80x24
    const enBase = await makeTempDir('pty-ascii-en');
    const enDshHome = join(enBase, 'dsh-home');
    process.env.DSH_HOME = enDshHome;
    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'tokyo-night', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: enDshHome } },
    );

    let enAiCalls = 0;
    const enHost = await createTuiHost({
      libraryRoot: join(enBase, 'library'),
      env: { ...process.env, DSH_HOME: enDshHome },
      home: join(enBase, 'home'),
      documentsDir: enBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        enAiCalls += 1;
        return '';
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const enTty = createVirtualTty(120, 36);
    let enInk = null;
    try {
      resetDistStore('en', true);
      enInk = render(
        React.createElement(StudyHubTuiApp, {
          host: enHost,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: true,
          onExit: () => enInk?.unmount(),
        }),
        {
          stdin: enTty.stdin,
          stdout: enTty.stdout,
          stderr: enTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await enTty.firstFramePromise;

      await enTty.waitFor((s) => s.includes('Load the sample course'), { label: 'en Launchpad render' });
      enTty.send('s');
      await enTty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Memento'),
        { timeoutMs: 12_000, label: 'en sample loaded' },
      );

      enTty.send('9');
      await enTty.waitFor(
        (s) => s.includes('Exam Coach') && s.includes('Calibration') && !s.includes('Loading'),
        { timeoutMs: 10_000, label: 'en ExamCoachView rendered' },
      );

      enTty.send('p');
      const enPrefs0 = await enTty.waitFor(
        (s) => s.includes('Learner Profile & Preferences') && s.includes('[p] Auto-Prep: OFF') && !s.includes('Loading learner profile'),
        { timeoutMs: 8_000, label: 'en CoachPreferencesModal opened' },
      );
      enTty.assertHealthyScreen(enPrefs0, 120, 36, 'en ASCII CoachPreferencesModal initial');
      enTty.assertAsciiPure(enPrefs0, 'en ASCII CoachPreferencesModal initial');

      // Press [p] -> opt-in ConfirmDialog -> cancel on 'n', cancel on Esc, confirm on 'y'
      enTty.send('p');
      const enConsentDlg = await enTty.waitFor(
        (s) => s.includes('Enable Background Variant Prep') && s.includes('call AI'),
        { timeoutMs: 5_000, label: 'en consent ConfirmDialog opened' },
      );
      enTty.assertHealthyScreen(enConsentDlg, 120, 36, 'en ASCII consent ConfirmDialog 120x36');
      enTty.assertAsciiPure(enConsentDlg, 'en ASCII consent ConfirmDialog 120x36');

      enTty.send('n');
      await enTty.waitFor(
        (s) => !s.includes('Enable Background Variant Prep') && s.includes('[p] Auto-Prep: OFF'),
        { timeoutMs: 5_000, label: 'en consent ConfirmDialog cancelled via n' },
      );

      enTty.send('p');
      await enTty.waitFor((s) => s.includes('Enable Background Variant Prep'), { timeoutMs: 5_000, label: 'en consent ConfirmDialog reopened for Esc' });
      enTty.send('\x1b');
      await enTty.waitFor(
        (s) => !s.includes('Enable Background Variant Prep') && s.includes('Learner Profile & Preferences') && s.includes('[p] Auto-Prep: OFF'),
        { timeoutMs: 5_000, label: 'en consent ConfirmDialog cancelled via Esc' },
      );

      assert.equal(enAiCalls, 0, 'cancelling en opt-in ConfirmDialog via n/Esc must make 0 AI calls');
      enTty.send('p');
      await enTty.waitFor((s) => s.includes('Enable Background Variant Prep'), { timeoutMs: 5_000, label: 'en consent ConfirmDialog reopened for y' });
      enTty.send('y');
      const enConsentOn = await enTty.waitFor(
        (s) => !s.includes('Enable Background Variant Prep') && s.includes('[p] Auto-Prep: ON'),
        { timeoutMs: 8_000, label: 'en consent turned ON' },
      );
      enTty.assertHealthyScreen(enConsentOn, 120, 36, 'en ASCII CoachPreferencesModal prep ON');
      enTty.assertAsciiPure(enConsentOn, 'en ASCII CoachPreferencesModal prep ON');

      // Direct OFF on [p]
      enTty.send('p');
      const enConsentOff = await enTty.waitFor(
        (s) => s.includes('[p] Auto-Prep: OFF') && !s.includes('Enable Background Variant Prep'),
        { timeoutMs: 8_000, label: 'en consent turned OFF directly' },
      );
      enTty.assertAsciiPure(enConsentOff, 'en ASCII CoachPreferencesModal prep OFF');

      for (let i = 0; i < 40; i += 1) {
        const st = await enHost.call('coach.status', {});
        if (st.ok && !st.value?.preparing) break;
        await sleep(50);
      }
      const enCallsBeforeForgetFlow = enAiCalls;

      // Populate goal & preference, resize to 80x24, test [F] danger ConfirmDialog
      enTty.send('g');
      await enTty.waitFor((s) => s.includes('[g] Goal: Pass Exam'), { timeoutMs: 5_000, label: 'en goal set to Pass Exam' });

      enTty.send('a');
      await enTty.waitFor((s) => s.includes('New preference'), { timeoutMs: 5_000, label: 'en add preference opened' });
      enTty.send('Prefer short proofs');
      await enTty.waitFor((s) => s.includes('Prefer short proofs'), { timeoutMs: 5_000, label: 'en preference typed' });
      enTty.send('\r');
      await enTty.waitFor(
        (s) => !s.includes('New preference') && s.includes('1/12') && s.includes('Prefer short proofs'),
        { timeoutMs: 8_000, label: 'en preference saved' },
      );

      enTty.resize(80, 24);
      const enNarrow = await enTty.waitFor(
        (s) => s.includes('[p] Auto-Prep: OFF') && s.split('\n').length <= 24,
        { timeoutMs: 8_000, label: 'en ASCII CoachPreferencesModal at 80x24' },
      );
      enTty.assertHealthyScreen(enNarrow, 80, 24, 'en ASCII CoachPreferencesModal 80x24');
      enTty.assertAsciiPure(enNarrow, 'en ASCII CoachPreferencesModal 80x24');

      enTty.send('F');
      const enForgetDlg = await enTty.waitFor(
        (s) => s.includes('Reset Learner Profile') && s.includes('practice history stay intact'),
        { timeoutMs: 5_000, label: 'en forget danger ConfirmDialog at 80x24' },
      );
      enTty.assertHealthyScreen(enForgetDlg, 80, 24, 'en ASCII forget ConfirmDialog 80x24');
      enTty.assertAsciiPure(enForgetDlg, 'en ASCII forget ConfirmDialog 80x24');

      enTty.send('n');
      await enTty.waitFor(
        (s) => !s.includes('Reset Learner Profile') && s.includes('Prefer short proofs'),
        { timeoutMs: 5_000, label: 'en forget ConfirmDialog cancelled via n' },
      );

      enTty.send('F');
      await enTty.waitFor((s) => s.includes('Reset Learner Profile'), { timeoutMs: 5_000, label: 'en forget ConfirmDialog reopened for Esc' });
      enTty.send('\x1b');
      await enTty.waitFor(
        (s) => !s.includes('Reset Learner Profile') && s.includes('Learner Profile & Preferences') && s.includes('Prefer short proofs'),
        { timeoutMs: 5_000, label: 'en forget ConfirmDialog cancelled via Esc' },
      );

      enTty.send('F');
      await enTty.waitFor((s) => s.includes('Reset Learner Profile'), { timeoutMs: 5_000, label: 'en forget ConfirmDialog reopened for y' });
      enTty.send('y');
      const enAfterForget = await enTty.waitFor(
        (s) => !s.includes('Reset Learner Profile') && s.includes('[g] Goal: Not set') && s.includes('0/12'),
        { timeoutMs: 8_000, label: 'en profile forgotten via ConfirmDialog' },
      );
      enTty.assertHealthyScreen(enAfterForget, 80, 24, 'en ASCII CoachPreferencesModal after forget 80x24');
      enTty.assertAsciiPure(enAfterForget, 'en ASCII CoachPreferencesModal after forget 80x24');

      const enProfFinal = await enHost.call('coach.profile', {});
      assert.equal(enProfFinal.value?.goal, '');
      assert.deepEqual(enProfFinal.value?.preferences, []);
      assert.equal(enProfFinal.value?.memoryRevision, 3);
      assert.equal(enAiCalls, enCallsBeforeForgetFlow, 'en goal + preference + forget must make 0 AI calls');
    } finally {
      try {
        enInk?.unmount();
      } catch {
        // ignore
      }
      await enHost.dispose();
      enTty.dispose();
    }
  });
});
