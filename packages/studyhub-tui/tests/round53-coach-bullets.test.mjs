// Round 53 CoachPreferencesModal Learner Memory Bullets CRUD (coach.profile addBullet / removeBullet)
// + HelpOverlay & KEYBINDINGS sync integration + @xterm/headless PTY E2E tests:
// node --test tests/round53-coach-bullets.test.mjs
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

let H = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') {
      H = {
        createTuiHost: mod.createTuiHost,
        saveTuiPreferences: mod.saveTuiPreferences,
      };
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(H, 'dist/ must export createTuiHost and saveTuiPreferences');
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round53-${label}-`));
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

describe('Round 53: CoachPreferencesModal Learner Memory Bullets CRUD', () => {
  test('1) createTuiHost integration (0 AI calls): coach.profile addBullet / removeBullet with expectedRevision', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const trackingComplete = async () => {
      aiCalls += 1;
      return '';
    };

    const host = await H.createTuiHost({
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

      const prof0 = await host.call('coach.profile', {});
      assert.equal(prof0.ok, true, prof0.error?.message);
      assert.deepEqual(prof0.value?.bullets, []);
      const rev0 = prof0.value?.memoryRevision ?? 0;
      assert.equal(aiCalls, 0, 'coach.profile {} must make 0 AI calls');

      const addRes = await host.call('coach.profile', {
        addBullet: { text: 'Always check boundary cases before proving invariants' },
        expectedRevision: rev0,
      });
      assert.equal(addRes.ok, true, addRes.error?.message);
      assert.equal(addRes.value?.memoryRevision, rev0 + 1);
      assert.equal(addRes.value?.bullets?.length, 1);
      const added = addRes.value.bullets[0];
      assert.ok(added.id, 'added bullet must have an id');
      assert.equal(added.text, 'Always check boundary cases before proving invariants');
      assert.equal(added.source, 'user');
      assert.equal(aiCalls, 0, 'coach.profile addBullet must make 0 AI calls');

      // Verify persistence on reload
      const prof1 = await host.call('coach.profile', {});
      assert.equal(prof1.ok, true);
      assert.equal(prof1.value?.memoryRevision, rev0 + 1);
      assert.equal(prof1.value?.bullets?.length, 1);
      assert.equal(prof1.value.bullets[0].id, added.id);

      // Verify stale expectedRevision is rejected
      const staleRes = await host.call('coach.profile', {
        addBullet: { text: 'Should fail on stale revision' },
        expectedRevision: rev0,
      });
      assert.equal(staleRes.ok, false, 'stale expectedRevision should fail');

      // Remove bullet with current expectedRevision
      const remRes = await host.call('coach.profile', {
        removeBullet: added.id,
        expectedRevision: rev0 + 1,
      });
      assert.equal(remRes.ok, true, remRes.error?.message);
      assert.equal(remRes.value?.memoryRevision, rev0 + 2);
      assert.deepEqual(remRes.value?.bullets, []);
      assert.equal(aiCalls, 0, 'coach.profile removeBullet must make 0 AI calls');

      const prof2 = await host.call('coach.profile', {});
      assert.equal(prof2.ok, true);
      assert.equal(prof2.value?.memoryRevision, rev0 + 2);
      assert.deepEqual(prof2.value?.bullets, []);
      assert.equal(aiCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: Tab 2 Memory Bullets CRUD + HelpOverlay at 120x36 zh & 80x24 --ascii en', async () => {
    // 2a) zh at 120x36
    const zhBase = await makeTempDir('pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await H.saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: zhDshHome } },
    );

    let zhAiCalls = 0;
    const zhHost = await H.createTuiHost({
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
        (s) => s.includes('学习者画像与长期偏好') && s.includes('记忆要点 (0)') && !s.includes('正在读取学习者画像'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal opened' },
      );
      zhTty.assertHealthyScreen(zhPrefs0, 120, 36, 'zh CoachPreferencesModal initial');

      // Switch to Tab 2 via Tab
      zhTty.send('\t');
      const zhBulletsEmpty = await zhTty.waitFor(
        (s) => s.includes('暂无记忆要点') && s.includes('记忆要点 (0)'),
        { timeoutMs: 5_000, label: 'zh switched to Tab 2 (bullets)' },
      );
      zhTty.assertHealthyScreen(zhBulletsEmpty, 120, 36, 'zh Tab 2 bullets empty');

      // Press [a] and add a bullet
      zhTty.send('a');
      await zhTty.waitFor((s) => s.includes('新增要点'), { timeoutMs: 5_000, label: 'zh add bullet input opened' });
      zhTty.send('先看反例再写推导');
      await zhTty.waitFor((s) => s.includes('先看反例再写推导'), { timeoutMs: 5_000, label: 'zh bullet typed' });
      zhTty.send('\r');
      const zhBulletsOne = await zhTty.waitFor(
        (s) => !s.includes('新增要点') && s.includes('记忆要点 (1)') && s.includes('先看反例再写推导') && s.includes('[用户]'),
        { timeoutMs: 8_000, label: 'zh bullet added and rendered' },
      );
      zhTty.assertHealthyScreen(zhBulletsOne, 120, 36, 'zh Tab 2 bullet added');

      const zhProf1 = await zhHost.call('coach.profile', {});
      assert.equal(zhProf1.value?.bullets?.length, 1);
      assert.equal(zhProf1.value.bullets[0].text, '先看反例再写推导');
      assert.equal(zhAiCalls, 0);

      // Press [d] to remove selected bullet
      zhTty.send('d');
      const zhBulletsRemoved = await zhTty.waitFor(
        (s) => s.includes('记忆要点 (0)') && !s.includes('先看反例再写推导') && s.includes('暂无记忆要点'),
        { timeoutMs: 8_000, label: 'zh bullet removed via d' },
      );
      zhTty.assertHealthyScreen(zhBulletsRemoved, 120, 36, 'zh Tab 2 bullet removed');

      const zhProf2 = await zhHost.call('coach.profile', {});
      assert.equal(zhProf2.value?.bullets?.length, 0);
      assert.equal(zhAiCalls, 0);

      // Close modal & check HelpOverlay
      zhTty.send('\x1b');
      await zhTty.waitFor(
        (s) => !s.includes('学习者画像与长期偏好') && s.includes('考试教练'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal closed' },
      );
      zhTty.send('?');
      const zhHelp = await zhTty.waitFor(
        (s) => s.includes('快捷键') && s.includes('题组导入/AI合并建议/拆分'),
        { timeoutMs: 5_000, label: 'zh HelpOverlay opened' },
      );
      zhTty.assertHealthyScreen(zhHelp, 120, 36, 'zh HelpOverlay 120x36');
      zhTty.send(' ');
      const zhHelpScrolled = await zhTty.waitFor(
        (s) => s.includes('本轮 AI 复盘点评'),
        { timeoutMs: 5_000, label: 'zh HelpOverlay scrolled to Review debrief' },
      );
      zhTty.assertHealthyScreen(zhHelpScrolled, 120, 36, 'zh HelpOverlay scrolled 120x36');
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }

    // 2b) --ascii en at 80x24
    const enBase = await makeTempDir('pty-ascii-en');
    const enDshHome = join(enBase, 'dsh-home');
    process.env.DSH_HOME = enDshHome;
    await H.saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'tokyo-night', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: enDshHome } },
    );

    let enAiCalls = 0;
    const enHost = await H.createTuiHost({
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

    const enTty = createVirtualTty(80, 24);
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
        (s) => s.includes('Learner Profile & Preferences') && s.includes('Memory Bullets (0)') && !s.includes('Loading learner profile'),
        { timeoutMs: 8_000, label: 'en CoachPreferencesModal opened at 80x24' },
      );
      enTty.assertHealthyScreen(enPrefs0, 80, 24, 'en ASCII CoachPreferencesModal 80x24');
      enTty.assertAsciiPure(enPrefs0, 'en ASCII CoachPreferencesModal 80x24');

      // Switch to Tab 2 via '2'
      enTty.send('2');
      const enBulletsEmpty = await enTty.waitFor(
        (s) => s.includes('No memory bullets yet') && s.includes('Memory Bullets (0)'),
        { timeoutMs: 5_000, label: 'en switched to Tab 2 via 2' },
      );
      enTty.assertHealthyScreen(enBulletsEmpty, 80, 24, 'en ASCII Tab 2 empty 80x24');
      enTty.assertAsciiPure(enBulletsEmpty, 'en ASCII Tab 2 empty 80x24');

      // Press [a] and add a bullet
      enTty.send('a');
      await enTty.waitFor((s) => s.includes('New memory bullet'), { timeoutMs: 5_000, label: 'en add bullet input opened' });
      enTty.send('Check edge cases first');
      await enTty.waitFor((s) => s.includes('Check edge cases first'), { timeoutMs: 5_000, label: 'en bullet typed' });
      enTty.send('\r');
      const enBulletsOne = await enTty.waitFor(
        (s) => !s.includes('New memory bullet') && s.includes('Memory Bullets (1)') && s.includes('Check edge cases first') && s.includes('[user]'),
        { timeoutMs: 8_000, label: 'en bullet added at 80x24' },
      );
      enTty.assertHealthyScreen(enBulletsOne, 80, 24, 'en ASCII Tab 2 bullet added 80x24');
      enTty.assertAsciiPure(enBulletsOne, 'en ASCII Tab 2 bullet added 80x24');

      // Press [d] to remove bullet
      enTty.send('d');
      const enBulletsRemoved = await enTty.waitFor(
        (s) => s.includes('Memory Bullets (0)') && !s.includes('Check edge cases first') && s.includes('No memory bullets yet'),
        { timeoutMs: 8_000, label: 'en bullet removed via d at 80x24' },
      );
      enTty.assertHealthyScreen(enBulletsRemoved, 80, 24, 'en ASCII Tab 2 bullet removed 80x24');
      enTty.assertAsciiPure(enBulletsRemoved, 'en ASCII Tab 2 bullet removed 80x24');

      const enProfFinal = await enHost.call('coach.profile', {});
      assert.equal(enProfFinal.value?.bullets?.length, 0);
      assert.equal(enAiCalls, 0);

      // Close modal & open HelpOverlay in --ascii en mode
      enTty.send('\x1b');
      await enTty.waitFor(
        (s) => !s.includes('Learner Profile & Preferences') && s.includes('Exam Coach'),
        { timeoutMs: 8_000, label: 'en CoachPreferencesModal closed' },
      );
      enTty.send('?');
      const enHelp = await enTty.waitFor(
        (s) => s.includes('Keyboard Shortcuts'),
        { timeoutMs: 5_000, label: 'en HelpOverlay opened at 80x24' },
      );
      enTty.assertHealthyScreen(enHelp, 80, 24, 'en ASCII HelpOverlay 80x24');
      enTty.assertAsciiPure(enHelp, 'en ASCII HelpOverlay 80x24');
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
