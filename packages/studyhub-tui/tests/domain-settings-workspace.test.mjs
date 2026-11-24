// Consolidated Settings & Workspace Domain Suite:
// Merged from:
// - round37-settings-e2e (book auto-add, practice reset preserving fixPhrases, experimental toggle)
// - round39-settings-usage (examPrep reset preserving enabled switch, retrieval.status, usage.frequency.*)
// - round59-study-settings (StudyGenTab book & examPrep parity + 80x24 viewport scrolling)
// - round60-update-caps (AppearanceTab terminal capabilities, WorkspaceTab [a]/[A]/[z] release update & offline fail-soft)
// - round61-usage-report (UsageReportModal periods 1/2/3, pause/resume, JSON export)
// - round62-library-ctx (library.context, LibraryContextModal refresh & JSON export)
// node --test tests/domain-settings-workspace.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();

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

const [
  { displayWidth },
  { defaultBackupPath, resolveBackupPath, summarizeExportPayload, truncatePathMiddle },
] = await Promise.all([
  import('../src/render/cjk.ts'),
  import('../src/views/settings/WorkspaceTab.tsx'),
]);

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const temps = createTempTracker('studyhub-tui-dom-settings-');

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

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function assertStrictScreen(tty, screen, cols, rows, label) {
  tty.assertHealthyScreen(screen, cols, rows, label);
  assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
  const lines = screen.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    assert.ok(w <= cols, `${label}: row ${i} width ${w} > ${cols}: ${JSON.stringify(lines[i])}`);
  }
}

function makeMockReleaseResponse(version = '9.9.9', notes = 'Highlights:\n- Faster FSRS review\n- Terminal capability strip') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      tag_name: `v${version}`,
      published_at: '2026-11-22T08:00:00Z',
      html_url: `https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v${version}`,
      body: notes,
      assets: [],
    }),
    body: { cancel: async () => {} },
  };
}

async function advanceRows(tty, count, currentIndex, totalRows) {
  for (let i = 0; i < count; i += 1) {
    const nextRow = currentIndex + i + 2;
    tty.send('j');
    await tty.waitFor((s) => s.includes(`${nextRow}/${totalRows}`), {
      label: `cursor moved to ${nextRow}/${totalRows}`,
    });
  }
}

after(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetTuiStore('zh', false);
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

describe('Domain Settings & Workspace: Hygiene, Host Integration & PTY E2E', () => {
  test('1) Chunk hygiene & WorkspaceTab pure helpers', () => {
    for (const prefix of ['SettingsView-', 'WorkspaceTab-', 'StudyGenTab-', 'AppearanceTab-']) {
      const chunk = distFiles.find((f) => f.startsWith(prefix) && f.endsWith('.mjs'));
      assert.ok(chunk, `dist/ must emit lazy ${prefix}*.mjs chunk, found: ${distFiles.join(', ')}`);
      const code = fs.readFileSync(join(distDir, chunk), 'utf8');
      assert.equal(/\bmarked\b/.test(code), false, `${chunk} must be marked-free`);
      assert.equal(/\bcli-highlight\b/.test(code), false, `${chunk} must not bundle cli-highlight`);
      assert.equal(/\bzod\b/.test(code), false, `${chunk} must not bundle zod`);
      assert.equal(/src\/components\/MarkdownView\.tsx/.test(code), false, `${chunk} must not bundle MarkdownView`);
    }

    const libRoot = resolve('/tmp/studyhub-lib');
    const defPath = defaultBackupPath(libRoot);
    assert.ok(defPath.startsWith(join(libRoot, 'backups')), `unexpected defaultBackupPath: ${defPath}`);
    assert.match(defPath, /studyhub-backup-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);

    assert.equal(resolveBackupPath('   ', libRoot), '');
    assert.equal(
      resolveBackupPath('snap-one', libRoot),
      join(libRoot, 'backups', 'snap-one.json'),
    );
    assert.equal(
      resolveBackupPath(join(libRoot, 'backups', 'nested-snap'), libRoot),
      join(libRoot, 'backups', 'nested-snap.json'),
    );
    assert.throws(() => resolveBackupPath('/var/tmp/custom.json', libRoot), /Unsafe export path/);
    assert.throws(() => resolveBackupPath('~/my-bak', libRoot), /Unsafe export path/);
    assert.throws(() => resolveBackupPath('../escape.json', libRoot), /Unsafe export path/);

    const emptySummary = summarizeExportPayload(null);
    assert.equal(emptySummary.decksCount, 0);
    assert.equal(emptySummary.cardsCount, 0);
    assert.equal(emptySummary.referencedOriginals, 0);

    const populatedSummary = summarizeExportPayload({
      decks: [{ cards: [{ id: 1 }, { id: 2 }] }, { cards: [{ id: 3 }] }],
      portableMaterials: { referencedOriginals: ['a.pdf', 'b.pdf'] },
    });
    assert.equal(populatedSummary.decksCount, 2);
    assert.equal(populatedSummary.cardsCount, 3);
    assert.equal(populatedSummary.referencedOriginals, 2);

    assert.equal(truncatePathMiddle('/short/path', 30, '...'), '/short/path');
    const truncated = truncatePathMiddle('/Users/alice/Documents/very/long/workspace/studyhub-library', 28, '...');
    assert.ok(displayWidth(truncated) <= 28, `truncated path exceeded 28 cols: ${truncated}`);
    assert.ok(truncated.endsWith('/studyhub-library'), `truncated path must preserve tail: ${truncated}`);

    const tight = truncatePathMiddle('/Users/alice/Documents/studyhub-library', 10, '...');
    assert.ok(displayWidth(tight) <= 10, `tight truncation exceeded 10 cols: ${tight}`);
    assert.ok(tight.includes('...'), `tight truncation should include ellipsis: ${tight}`);

    const cjkTruncated = truncatePathMiddle('/Users/用户/学习资料库/高等数学/studyhub-lib', 18, '…');
    assert.ok(displayWidth(cjkTruncated) <= 18, `CJK path exceeded 18 cols: ${cjkTruncated}`);
    assert.ok(cjkTruncated.endsWith('/studyhub-lib'), `CJK path must preserve tail: ${cjkTruncated}`);
  });

  test('2) Host integration (round37): settings.book.set, settings.practice.reset (preserving fixPhrases), experimental.get/set', async () => {
    const base = await temps.make('r37-host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const bookAuto = await host.call('settings.book.set', { patch: { qaToBook: 'auto' } });
      assert.equal(bookAuto.ok, true, bookAuto.error?.message);
      assert.equal(bookAuto.value.qaToBook, 'auto');

      const snap1 = await host.call('snapshot');
      assert.equal(snap1.ok, true);
      assert.equal(snap1.value.settings?.book?.qaToBook, 'auto');

      const bookManual = await host.call('settings.book.set', { patch: { qaToBook: 'manual', pageLimit: 120 } });
      assert.equal(bookManual.ok, true, bookManual.error?.message);
      assert.equal(bookManual.value.qaToBook, 'manual');
      assert.equal(bookManual.value.pageLimit, 120);

      const bookCleared = await host.call('settings.book.set', { patch: { pageLimit: null } });
      assert.equal(bookCleared.ok, true, bookCleared.error?.message);
      assert.equal(bookCleared.value.qaToBook, 'manual');
      assert.equal('pageLimit' in bookCleared.value, false);

      const phrase = 'Keep my custom fix phrase';
      const pracSet = await host.call('settings.practice.set', {
        patch: {
          roundSize: 35,
          autopilot: true,
          newCardOrder: 'shuffle',
          debrief: false,
          rereadMarks: false,
          fixPhrases: [phrase],
        },
      });
      assert.equal(pracSet.ok, true, pracSet.error?.message);
      assert.equal(pracSet.value.roundSize, 35);
      assert.equal(pracSet.value.autopilot, true);
      assert.deepEqual(pracSet.value.fixPhrases, [phrase]);

      const pracReset = await host.call('settings.practice.reset', {});
      assert.equal(pracReset.ok, true, pracReset.error?.message);
      assert.equal(pracReset.value.roundSize, 20);
      assert.equal(pracReset.value.autopilot, false);
      assert.equal(pracReset.value.newCardOrder, 'reading');
      assert.equal(pracReset.value.debrief, true);
      assert.equal(pracReset.value.rereadMarks, true);
      assert.deepEqual(pracReset.value.fixPhrases, [phrase]);

      const snap2 = await host.call('snapshot');
      assert.equal(snap2.ok, true);
      assert.deepEqual(snap2.value.settings?.practice?.fixPhrases, [phrase]);
      assert.equal(snap2.value.settings?.practice?.roundSize, 20);

      const exp0 = await host.call('experimental.get', {});
      assert.equal(exp0.ok, true, exp0.error?.message);
      assert.equal(exp0.value.enabled, false);

      const expSetOn = await host.call('experimental.set', { enabled: true });
      assert.equal(expSetOn.ok, true, expSetOn.error?.message);
      assert.equal(expSetOn.value.enabled, true);
      assert.equal(existsSync(join(dshHome, 'study', 'experimental.json')), true);

      const exp1 = await host.call('experimental.get', {});
      assert.equal(exp1.ok, true, exp1.error?.message);
      assert.equal(exp1.value.enabled, true);

      const snapOn = await host.call('snapshot');
      assert.equal(snapOn.ok, true);
      assert.equal(snapOn.value.experimental, true);

      const expSetOff = await host.call('experimental.set', { enabled: false });
      assert.equal(expSetOff.ok, true, expSetOff.error?.message);
      assert.equal(expSetOff.value.enabled, false);

      const exp2 = await host.call('experimental.get', {});
      assert.equal(exp2.ok, true, exp2.error?.message);
      assert.equal(exp2.value.enabled, false);

      const snapOff = await host.call('snapshot');
      assert.equal(snapOff.ok, true);
      assert.equal(snapOff.value.experimental, false);
    } finally {
      await host.dispose();
    }
  });

  test('3) Host integration (round39): settings.examPrep.reset, retrieval.status & usage.frequency.*', async () => {
    const base = await temps.make('r39-host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const epSetOff = await host.call('settings.examPrep.set', {
        patch: {
          autoRoles: false,
          paperWords: ['mock-exam'],
          language: 'en',
          showOtherCourses: true,
          enabled: false,
        },
      });
      assert.equal(epSetOff.ok, true, epSetOff.error?.message);
      assert.equal(epSetOff.value.autoRoles, false);
      assert.deepEqual(epSetOff.value.paperWords, ['mock-exam']);
      assert.equal(epSetOff.value.language, 'en');
      assert.equal(epSetOff.value.showOtherCourses, true);
      assert.equal(epSetOff.value.enabled, false);

      const epResetOff = await host.call('settings.examPrep.reset', {});
      assert.equal(epResetOff.ok, true, epResetOff.error?.message);
      assert.equal(epResetOff.value.autoRoles, true);
      assert.deepEqual(epResetOff.value.paperWords, []);
      assert.equal(epResetOff.value.language, 'auto');
      assert.equal(epResetOff.value.showOtherCourses, false);
      assert.equal(epResetOff.value.enabled, false);

      const snapEp = await host.call('snapshot');
      assert.equal(snapEp.ok, true);
      assert.equal(snapEp.value.settings?.examPrep?.enabled, false);

      await host.call('settings.examPrep.set', { patch: { enabled: true, paperWords: ['past-paper'] } });
      const epResetOn = await host.call('settings.examPrep.reset', {});
      assert.equal(epResetOn.ok, true, epResetOn.error?.message);
      assert.equal(epResetOn.value.enabled, true);
      assert.deepEqual(epResetOn.value.paperWords, []);

      const retStatus = await host.call('retrieval.status', {});
      assert.equal(retStatus.ok, true, retStatus.error?.message);
      assert.equal(retStatus.value.effective, 'builtin');
      assert.equal(typeof retStatus.value.companion?.running, 'boolean');
      assert.equal(typeof retStatus.value.hostCanSearch, 'boolean');

      const u0 = await host.call('usage.frequency.status', {});
      assert.equal(u0.ok, true, u0.error?.message);
      assert.equal(u0.value.enabled, false);
      assert.equal(u0.value.paused, false);
      assert.equal(u0.value.hasData, false);
      assert.equal(u0.value.daysWithData, 0);

      const uOn = await host.call('usage.frequency.set', { enabled: true });
      assert.equal(uOn.ok, true, uOn.error?.message);
      assert.equal(uOn.value.enabled, true);
      assert.equal(uOn.value.paused, false);

      const rec = await host.call('usage.frequency.record', {
        records: [{ key: 'settings.usage.toggle', area: 'settings', day: todayLocalYmd(), n: 2 }],
      });
      assert.equal(rec.ok, true, rec.error?.message);
      assert.equal(rec.value.accepted, 1);

      const uPaused = await host.call('usage.frequency.set', { paused: true });
      assert.equal(uPaused.ok, true, uPaused.error?.message);
      assert.equal(uPaused.value.paused, true);
      assert.equal(uPaused.value.enabled, true);

      const uResumed = await host.call('usage.frequency.set', { paused: false });
      assert.equal(uResumed.ok, true, uResumed.error?.message);
      assert.equal(uResumed.value.paused, false);
      assert.equal(uResumed.value.enabled, true);

      const uWithData = await host.call('usage.frequency.status', {});
      assert.equal(uWithData.ok, true);
      assert.equal(uWithData.value.hasData, true);
      assert.equal(uWithData.value.daysWithData, 1);

      const uCleared = await host.call('usage.frequency.clear', {});
      assert.equal(uCleared.ok, true, uCleared.error?.message);
      assert.equal(uCleared.value.enabled, true);
      assert.equal(uCleared.value.hasData, false);
      assert.equal(uCleared.value.daysWithData, 0);

      const uOff = await host.call('usage.frequency.set', { enabled: false });
      assert.equal(uOff.ok, true, uOff.error?.message);
      assert.equal(uOff.value.enabled, false);

      const uFinal = await host.call('usage.frequency.status', {});
      assert.equal(uFinal.ok, true);
      assert.equal(uFinal.value.enabled, false);
      assert.equal(uFinal.value.hasData, false);
      assert.equal(uFinal.value.daysWithData, 0);
    } finally {
      await host.dispose();
    }
  });

  test('4) Host integration (round59): settings.book.set, settings.examPrep.set & general settings persist (0 model calls)', async () => {
    const base = await temps.make('r59-host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected model call in settings host test');
      },
    });

    try {
      const bookRes = await host.call('settings.book.set', {
        patch: { coverage: 'full', inlinePractice: false, confusableDrill: false },
      });
      assert.equal(bookRes.ok, true, bookRes.error?.message);
      assert.equal(bookRes.value.coverage, 'full');
      assert.equal(bookRes.value.inlinePractice, false);
      assert.equal(bookRes.value.confusableDrill, false);

      const epRes = await host.call('settings.examPrep.set', {
        patch: { autoRoles: false, showOtherCourses: true },
      });
      assert.equal(epRes.ok, true, epRes.error?.message);
      assert.equal(epRes.value.autoRoles, false);
      assert.equal(epRes.value.showOtherCourses, true);

      const genRes = await host.call('settings', {
        request_retention: 0.85,
        maximum_interval: 3650,
        generation: { kind: 'mixed', count: 15, difficulty: 'application' },
        dailyRecap: { automatic: true, tone: 'professional' },
      });
      assert.equal(genRes.ok, true, genRes.error?.message);

      const allSettings = await host.call('settings', {});
      assert.equal(allSettings.ok, true, allSettings.error?.message);
      assert.equal(allSettings.value?.book?.coverage, 'full');
      assert.equal(allSettings.value?.book?.inlinePractice, false);
      assert.equal(allSettings.value?.book?.confusableDrill, false);
      assert.equal(allSettings.value?.examPrep?.autoRoles, false);
      assert.equal(allSettings.value?.examPrep?.showOtherCourses, true);
      assert.equal(allSettings.value?.request_retention, 0.85);
      assert.equal(allSettings.value?.maximum_interval, 3650);
      assert.equal(allSettings.value?.generation?.kind, 'mixed');
      assert.equal(allSettings.value?.generation?.count, 15);
      assert.equal(allSettings.value?.generation?.difficulty, 'application');
      assert.equal(allSettings.value?.dailyRecap?.automatic, true);
      assert.equal(allSettings.value?.dailyRecap?.tone, 'professional');
      assert.equal(modelCalls, 0, 'settings persistence must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('5) PTY E2E (round37+39): WorkspaceTab [f]/[u]/[U] & StudyGenTab qaToBook/practice_reset/examprep_reset with P2 cancel/confirm', async () => {
    const base = await temps.make('r37-39-pty');
    const dshHome = join(base, 'dsh-home');
    const env = sanitizedTestEnv({ DSH_HOME: dshHome });
    process.env.DSH_HOME = dshHome;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    resetTuiStore('en', false);
    await saveTuiPreferences({ language: 'en', asciiMode: false }, { env });
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    const savedPhrase = 'Explain step by step';
    await host.call('settings.practice.set', {
      patch: { roundSize: 35, autopilot: true, fixPhrases: [savedPhrase] },
    });
    await host.call('settings.examPrep.set', {
      patch: {
        autoRoles: false,
        paperWords: ['mock-paper'],
        language: 'en',
        showOtherCourses: true,
        enabled: false,
      },
    });
    await host.call('usage.frequency.set', { enabled: true });
    await host.call('usage.frequency.record', {
      records: [{ key: 'settings.usage.seed', area: 'settings', day: todayLocalYmd(), n: 1 }],
    });
    await host.call('usage.frequency.set', { enabled: false });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'settings',
          initialLanguage: 'en',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
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
      await tty.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
        label: 'SettingsView loaded on Models tab',
      });
      await tty.flush();
      assert.equal(useTuiStore.getState().page, 'settings');
      assert.equal(useTuiStore.getState().preferences.language, 'en');
      assert.equal(useTuiStore.getState().preferences.asciiMode, false);

      // Switch to WorkspaceTab ('2')
      tty.send('2');
      const wsWide = await tty.waitFor(
        (s) =>
          s.includes('Library Root & Workspace') &&
          s.includes('Experimental Features:') &&
          s.includes('Disabled') &&
          s.includes('[f]') &&
          s.includes('Retrieval:') &&
          s.includes('Usage Frequency:') &&
          s.includes('Disabled (1d)') &&
          s.includes('[u]') &&
          s.includes('[U]'),
        { label: 'WorkspaceTab rendered at 120x36' },
      );
      assertStrictScreen(tty, wsWide, 120, 36, 'WorkspaceTab 120x36');

      // Resize to 80x24 and verify clean rendering
      tty.resize(80, 24);
      const wsNarrow = await tty.waitFor(
        (s) =>
          s.includes('Experimental Features:') &&
          s.includes('Retrieval:') &&
          s.includes('Usage Frequency:') &&
          s.includes('Disabled (1d)') &&
          s.split('\n').length <= 24,
        { label: 'WorkspaceTab at 80x24' },
      );
      assertStrictScreen(tty, wsNarrow, 80, 24, 'WorkspaceTab 80x24');

      // Restore 120x36 and toggle Experimental Features on/off via 'f'
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('Experimental Features:'), { label: 'WorkspaceTab restored 120x36' });
      await tty.flush();

      tty.send('f');
      const afterExpOn = await tty.waitFor(
        (s) => s.includes('Enabled') && s.includes('Experimental features enabled'),
        { label: 'Experimental Features toggled on' },
      );
      assertStrictScreen(tty, afterExpOn, 120, 36, 'WorkspaceTab experimental on');
      const expAfterOn = await host.call('experimental.get', {});
      assert.equal(expAfterOn.value?.enabled, true);

      tty.send('f');
      const afterExpOff = await tty.waitFor(
        (s) => s.includes('Disabled') && s.includes('Experimental features disabled'),
        { label: 'Experimental Features toggled off' },
      );
      assertStrictScreen(tty, afterExpOff, 120, 36, 'WorkspaceTab experimental off');
      const expAfterOff = await host.call('experimental.get', {});
      assert.equal(expAfterOff.value?.enabled, false);

      // Toggle Usage Frequency on via 'u'
      tty.send('u');
      const afterUsageOn = await tty.waitFor(
        (s) => s.includes('Enabled ✓ (1d)') && s.includes('Usage frequency recording enabled'),
        { label: 'Usage Frequency toggled on via [u]' },
      );
      assertStrictScreen(tty, afterUsageOn, 120, 36, 'WorkspaceTab usage on');
      const usageAfterOn = await host.call('usage.frequency.status', {});
      assert.equal(usageAfterOn.value?.enabled, true);
      assert.equal(usageAfterOn.value?.daysWithData, 1);

      // Press 'U' -> ConfirmDialog -> cancel with 'n' (P2 guard: data must remain)
      tty.send('U');
      const clearDialog = await tty.waitFor(
        (s) => s.includes('Clear Usage Frequency Data') && s.includes('Clear Data'),
        { label: 'Clear Usage Frequency ConfirmDialog opened via [U]' },
      );
      assertStrictScreen(tty, clearDialog, 120, 36, 'Clear Usage ConfirmDialog');

      tty.send('n');
      await tty.waitFor((s) => !s.includes('Clear Usage Frequency Data') && s.includes('Enabled ✓ (1d)'), {
        label: 'Clear Usage Frequency ConfirmDialog cancelled via n',
      });
      const usageAfterCancel = await host.call('usage.frequency.status', {});
      assert.equal(usageAfterCancel.value?.hasData, true);
      assert.equal(usageAfterCancel.value?.daysWithData, 1);

      // Press 'U' again -> confirm with 'y' -> data cleared, switch remains enabled
      tty.send('U');
      await tty.waitFor((s) => s.includes('Clear Usage Frequency Data'), {
        label: 'Clear Usage Frequency ConfirmDialog reopened',
      });
      tty.send('y');
      const afterUsageClear = await tty.waitFor(
        (s) => s.includes('Enabled ✓ (0d)') && s.includes('All usage frequency records cleared'),
        { label: 'Usage Frequency data cleared' },
      );
      assertStrictScreen(tty, afterUsageClear, 120, 36, 'WorkspaceTab usage cleared');
      const usageAfterClear = await host.call('usage.frequency.status', {});
      assert.equal(usageAfterClear.value?.enabled, true);
      assert.equal(usageAfterClear.value?.hasData, false);
      assert.equal(usageAfterClear.value?.daysWithData, 0);

      // Toggle Usage Frequency back off with 'u'
      tty.send('u');
      const afterUsageOff = await tty.waitFor(
        (s) => s.includes('Disabled (0d)') && s.includes('Usage frequency recording disabled'),
        { label: 'Usage Frequency toggled off via [u]' },
      );
      assertStrictScreen(tty, afterUsageOff, 120, 36, 'WorkspaceTab usage off');
      const usageAfterOff = await host.call('usage.frequency.status', {});
      assert.equal(usageAfterOff.value?.enabled, false);

      // Switch to StudyGenTab ('3')
      tty.send('3');
      const sgWide = await tty.waitFor(
        (s) =>
          s.includes('Review, Generation & Daily Recap Settings') &&
          s.includes('Auto-add Q&A to Book') &&
          s.includes('Reset Practice Defaults') &&
          s.includes('Reset ExamPrep Defaults'),
        { label: 'StudyGenTab rendered at 120x36' },
      );
      assertStrictScreen(tty, sgWide, 120, 36, 'StudyGenTab 120x36');
      await tty.flush();

      // Resize StudyGenTab to 80x24 and restore
      tty.resize(80, 24);
      const sgNarrow = await tty.waitFor(
        (s) => s.includes('Auto-add Q&A') && s.includes('Reset Practice') && s.split('\n').length <= 24,
        { label: 'StudyGenTab at 80x24' },
      );
      assertStrictScreen(tty, sgNarrow, 80, 24, 'StudyGenTab 80x24');
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('Auto-add Q&A to Book') && s.includes('1/22'), {
        label: 'StudyGenTab restored 120x36',
      });
      await tty.flush();

      // Move cursor to index 5 ('book_qaToBook', 6/22) and toggle manual -> auto -> manual
      await advanceRows(tty, 5, 0, 22);
      tty.send('\r');
      await tty.waitFor((s) => s.includes('Auto ✓'), { label: 'book.qaToBook toggled to Auto' });
      const snapBook = await host.call('snapshot');
      assert.equal(snapBook.value?.settings?.book?.qaToBook, 'auto');

      tty.send(' ');
      await tty.waitFor((s) => s.split('\n').some((line) => line.includes('Auto-add Q&A to Book') && line.includes('< Manual >')), {
        label: 'book.qaToBook toggled back to Manual',
      });
      const snapBookManual = await host.call('snapshot');
      assert.equal(snapBookManual.value?.settings?.book?.qaToBook, 'manual');

      // Move cursor to index 6 ('practice_reset', 7/22) -> ConfirmDialog cancel ('n') then confirm ('y')
      await advanceRows(tty, 1, 5, 22);
      tty.send('\r');
      const resetDialog = await tty.waitFor(
        (s) => s.includes('Reset Practice Defaults') && s.includes('Cancel (n)') && s.includes('Reset (y)'),
        { label: 'Reset Practice Defaults ConfirmDialog opened' },
      );
      assertStrictScreen(tty, resetDialog, 120, 36, 'Reset Practice ConfirmDialog');

      tty.send('n');
      const afterPracCancel = await tty.waitFor((s) => !s.includes('Cancel (n)') && !s.includes('Reset (y)'), {
        label: 'Reset Practice Defaults cancelled via n',
      });
      assertStrictScreen(tty, afterPracCancel, 120, 36, 'StudyGenTab after practice cancel');
      const snapPracCanceled = await host.call('snapshot');
      assert.equal(snapPracCanceled.value?.settings?.practice?.roundSize, 35);
      assert.equal(snapPracCanceled.value?.settings?.practice?.autopilot, true);
      assert.deepEqual(snapPracCanceled.value?.settings?.practice?.fixPhrases, [savedPhrase]);

      tty.send('\r');
      await tty.waitFor((s) => s.includes('Reset Practice Defaults') && s.includes('Reset (y)'), {
        label: 'Reset Practice Defaults ConfirmDialog reopened',
      });
      tty.send('y');
      const afterReset = await tty.waitFor(
        (s) => s.includes('Practice defaults reset') && s.includes('20 cards'),
        { label: 'Practice defaults reset confirmed' },
      );
      assertStrictScreen(tty, afterReset, 120, 36, 'StudyGenTab after practice reset');
      const snapAfterReset = await host.call('snapshot');
      assert.equal(snapAfterReset.value?.settings?.practice?.roundSize, 20);
      assert.equal(snapAfterReset.value?.settings?.practice?.autopilot, false);
      assert.deepEqual(snapAfterReset.value?.settings?.practice?.fixPhrases, [savedPhrase]);

      // Move cursor to index 7 ('examprep_reset', 8/22) -> ConfirmDialog Esc cancel then confirm ('y')
      await advanceRows(tty, 1, 6, 22);
      tty.send('\r');
      const epDialog = await tty.waitFor(
        (s) => s.includes('Reset ExamPrep Defaults') && s.includes('page on/off switch'),
        { label: 'Reset ExamPrep Defaults ConfirmDialog opened' },
      );
      assertStrictScreen(tty, epDialog, 120, 36, 'Reset ExamPrep ConfirmDialog');

      tty.send('\x1b');
      const afterEpCancel = await tty.waitFor((s) => !s.includes('Cancel (n)') && !s.includes('Reset (y)'), {
        label: 'Reset ExamPrep Defaults cancelled via Esc',
      });
      assertStrictScreen(tty, afterEpCancel, 120, 36, 'StudyGenTab after examprep cancel');
      const snapEpCanceled = await host.call('snapshot');
      assert.deepEqual(snapEpCanceled.value?.settings?.examPrep?.paperWords, ['mock-paper']);
      assert.equal(snapEpCanceled.value?.settings?.examPrep?.autoRoles, false);

      tty.send('\r');
      await tty.waitFor((s) => s.includes('Reset ExamPrep Defaults') && s.includes('page on/off switch'), {
        label: 'Reset ExamPrep Defaults ConfirmDialog reopened',
      });
      tty.send('y');
      const afterEpReset = await tty.waitFor(
        (s) => s.includes('ExamPrep defaults reset (page switch kept)'),
        { label: 'ExamPrep defaults reset confirmed' },
      );
      assertStrictScreen(tty, afterEpReset, 120, 36, 'StudyGenTab after examprep reset');
      const snapAfterEpReset = await host.call('snapshot');
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.autoRoles, true);
      assert.deepEqual(snapAfterEpReset.value?.settings?.examPrep?.paperWords, []);
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.language, 'auto');
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.showOtherCourses, false);
      assert.equal(snapAfterEpReset.value?.settings?.examPrep?.enabled, false);
      assert.equal(useTuiStore.getState().lastError, null);
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('6) PTY E2E (round59): StudyGenTab Book & ExamPrep rows at 120x36 & 80x24 zh with smooth PageDown/PageUp scrolling', async () => {
    const base = await temps.make('r59-pty');
    const dshHome = join(base, 'dsh-home');
    const env = sanitizedTestEnv({ DSH_HOME: dshHome });
    process.env.DSH_HOME = dshHome;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    resetTuiStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });
    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'settings',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
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
      await tty.waitFor((s) => s.includes('模型配置'), { label: 'SettingsView zh loaded' });
      await tty.flush();

      tty.send('3');
      const sgZh = await tty.waitFor(
        (s) =>
          s.includes('1/22') &&
          s.includes('全书详略') &&
          s.includes('全书内嵌练习') &&
          s.includes('易混对比专练') &&
          s.includes('备考自动识别岗位') &&
          s.includes('备考显示其他课程'),
        { label: 'StudyGenTab zh 120x36 shows all 22 rows' },
      );
      assertStrictScreen(tty, sgZh, 120, 36, 'StudyGenTab zh 120x36');
      await tty.flush();

      // Resize to 80x24 to verify viewport clipping and smooth PageDown/PageUp scrolling
      tty.resize(80, 24);
      const sgTop = await tty.waitFor(
        (s) => s.includes('1/22') && s.includes('每轮题数') && s.split('\n').length <= 24,
        { label: 'StudyGenTab 80x24 zh top viewport' },
      );
      assertStrictScreen(tty, sgTop, 80, 24, 'StudyGenTab 80x24 top');
      assert.equal(sgTop.includes('备考显示其他课程'), false, 'Bottom rows should be below initial 80x24 viewport');
      await tty.flush();

      // PageDown moves smoothly toward bottom; then navigate to index 17 (18/22 book_coverage)
      tty.send('\x1b[6~');
      await tty.waitFor((s) => !s.includes('1/22') && s.includes('15/22'), {
        label: 'PageDown moved cursor to 15/22',
      });
      await advanceRows(tty, 3, 14, 22);
      const sgCov = await tty.waitFor(
        (s) => s.includes('18/22') && s.includes('全书详略'),
        { label: 'StudyGenTab 80x24 scrolled to 18/22 (book_coverage)' },
      );
      assertStrictScreen(tty, sgCov, 80, 24, 'StudyGenTab 80x24 at 18/22');
      assert.ok(sgCov.includes('18/22'));

      // Toggle book_coverage standard -> full with Space
      tty.send(' ');
      const sgCovFull = await tty.waitFor(
        (s) => s.split('\n').some((line) => line.includes('全书详略') && line.includes('详尽')),
        { label: 'book_coverage toggled to full at 80x24' },
      );
      assertStrictScreen(tty, sgCovFull, 80, 24, 'StudyGenTab 80x24 book_coverage full');

      // Navigate to index 20 (21/22 examprep_autoRoles) and toggle true -> false with 'l'
      await advanceRows(tty, 3, 17, 22);
      const sgEp = await tty.waitFor(
        (s) => s.includes('21/22') && s.includes('备考自动识别岗位') && s.includes('备考显示其他课程'),
        { label: 'StudyGenTab 80x24 scrolled to 21/22 (examprep_autoRoles)' },
      );
      assertStrictScreen(tty, sgEp, 80, 24, 'StudyGenTab 80x24 at 21/22');
      assert.ok(sgEp.includes('21/22'));

      tty.send('l');
      const sgEpOff = await tty.waitFor(
        (s) =>
          s.includes('21/22') &&
          s.split('\n').some((line) => line.includes('备考自动识别岗位') && line.includes('关闭')),
        { label: 'examprep_autoRoles toggled off via l at 80x24' },
      );
      assertStrictScreen(tty, sgEpOff, 80, 24, 'StudyGenTab 80x24 examprep_autoRoles off');

      // Navigate to index 21 (22/22 examprep_showOtherCourses) and toggle false -> true with 'l'
      await advanceRows(tty, 1, 20, 22);
      tty.send('l');
      await tty.waitFor(
        (s) => s.split('\n').some((line) => line.includes('备考显示其他课程') && line.includes('开启')),
        { label: 'examprep_showOtherCourses toggled On at 80x24' },
      );

      // PageUp smoothly scrolls back toward top
      tty.send('\x1b[5~');
      const sgScrolledUp = await tty.waitFor(
        (s) => !s.includes('22/22') && s.includes('8/22'),
        { label: 'PageUp scrolled cleanly up from 22/22' },
      );
      assertStrictScreen(tty, sgScrolledUp, 80, 24, 'StudyGenTab 80x24 after PageUp');
      assert.ok(sgScrolledUp.includes('8/22'));

      const zhPersisted = await host.call('settings', {});
      assert.equal(zhPersisted.ok, true);
      assert.equal(zhPersisted.value?.book?.coverage, 'full');
      assert.equal(zhPersisted.value?.examPrep?.autoRoles, false);
      assert.equal(zhPersisted.value?.examPrep?.showOtherCourses, true);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });

  describe('Shared Host Workspace Features (round60, round61, round62)', () => {
    let boxDir;
    let dshHome;
    let libraryRoot;
    let host;
    let fetchImpl;
    let fetchCalls = 0;
    let activeTty = null;
    let activeInk = null;
    let disposed = false;

    async function unmountActiveApp() {
      const ink = activeInk;
      const tty = activeTty;
      activeInk = null;
      activeTty = null;
      try {
        ink?.unmount();
      } catch {
        // Ignore unmount errors during test teardown
      }
      tty?.dispose();
    }

    async function mountApp({ initialPage = 'library', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
      await unmountActiveApp();
      resetTuiStore(language, asciiMode);
      await saveTuiPreferences({ language, asciiMode }, { env: sanitizedTestEnv({ DSH_HOME: dshHome }) });
      host.setLanguage(language);
      const tty = createVirtualTty(cols, rows);
      let inkInstance = null;
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage,
          initialLanguage: language,
          initialAsciiMode: asciiMode,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
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
      activeTty = tty;
      activeInk = inkInstance;
      await tty.firstFramePromise;
      return tty;
    }

    before(async () => {
      boxDir = await temps.make('shared-ws');
      dshHome = join(boxDir, 'dsh-home');
      libraryRoot = join(boxDir, 'library');
      await mkdir(libraryRoot, { recursive: true });
      process.env.DSH_HOME = dshHome;

      fetchImpl = async () => {
        throw new Error('Unexpected fetch in before()');
      };

      host = await createTuiHost({
        env: sanitizedTestEnv({ DSH_HOME: dshHome }),
        home: join(boxDir, 'home'),
        libraryRoot,
        skipAutoProbe: true,
        language: 'zh',
        eventDebounceMs: 30,
        fetch: async (url, init) => {
          fetchCalls += 1;
          return fetchImpl(url, init);
        },
      });

      globalThis.fetch = async (url, init) => {
        fetchCalls += 1;
        return fetchImpl(url, init);
      };
    });

    after(async () => {
      if (disposed) return;
      disposed = true;
      await unmountActiveApp();
      await host?.dispose();
    });

    test('7) Host integration (round60): update.check, update.preferences autoCheck/snooze/clear, offline error', async () => {
      fetchCalls = 0;
      fetchImpl = async () => makeMockReleaseResponse('9.9.9', 'Release 9.9.9\n• Improved study workflow');

      const checkRes = await host.call('update.check', { force: true });
      assert.equal(checkRes.ok, true, checkRes.error?.message);
      assert.equal(checkRes.value.newer, true);
      assert.equal(checkRes.value.latest, '9.9.9');
      assert.ok(String(checkRes.value.notes).includes('Improved study workflow'));
      assert.equal(fetchCalls, 1);

      const autoOffRes = await host.call('update.preferences', { autoCheck: false });
      assert.equal(autoOffRes.ok, true, autoOffRes.error?.message);
      assert.equal(autoOffRes.value.autoCheck, false);

      const autoOnRes = await host.call('update.preferences', { autoCheck: true });
      assert.equal(autoOnRes.ok, true, autoOnRes.error?.message);
      assert.equal(autoOnRes.value.autoCheck, true);

      const snoozeRes = await host.call('update.preferences', { snooze: '9.9.9' });
      assert.equal(snoozeRes.ok, true, snoozeRes.error?.message);
      assert.equal(snoozeRes.value.snoozed, true);

      const unsnoozeRes = await host.call('update.preferences', { snooze: null });
      assert.equal(unsnoozeRes.ok, true, unsnoozeRes.error?.message);
      assert.equal(unsnoozeRes.value.snoozed, false);

      fetchImpl = async () => {
        throw new Error('ECONNREFUSED offline');
      };
      const offlineRes = await host.call('update.check', { force: true });
      assert.equal(offlineRes.ok, true, offlineRes.error?.message);
      assert.equal(offlineRes.value.error, 'network');
    });

    test('8) PTY E2E (round60 120x36 zh): AppearanceTab caps + theme cycle + WorkspaceTab [a] toggle + [A] modal + [z] snooze/unsnooze', async () => {
      await rm(join(dshHome, 'study', 'update.json'), { force: true });
      fetchCalls = 0;
      fetchImpl = async () =>
        makeMockReleaseResponse('9.9.9', 'New in 9.9.9:\n• Faster FSRS review • Live capabilities readout');

      const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), {
        label: 'Initial Library view rendered (zh)',
      });
      await tty.flush();

      tty.send(',');
      await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'settings' &&
          s.includes('模型配置') &&
          s.includes('TUI 外观与偏好'),
        { label: 'SettingsView rendered via , (zh)' },
      );
      await tty.flush(25);

      // Switch to AppearanceTab ('4')
      tty.send('4');
      const appearanceScreen = await tty.waitFor(
        (s) =>
          s.includes('终端能力与运行诊断') &&
          s.includes(process.platform) &&
          /L[0-3]\)/.test(s) &&
          /\d+x\d+/.test(s) &&
          s.includes('SGR 1006:'),
        { label: 'AppearanceTab capability readout rendered (120x36 zh)' },
      );
      assertStrictScreen(tty, appearanceScreen, 120, 36, 'AppearanceTab 120x36 zh');
      assert.equal(fetchCalls, 0, 'AppearanceTab must trigger 0 fetch calls');
      await tty.flush();

      // Cycle theme forward & back on row 0 in AppearanceTab
      const initialTheme = useTuiStore.getState().preferences.theme;
      tty.send('l');
      await tty.waitFor((s) => s.includes('主题已切换为'), {
        label: 'AppearanceTab theme cycled forward',
      });
      assert.notEqual(useTuiStore.getState().preferences.theme, initialTheme);
      tty.send('h');
      await tty.waitFor(() => useTuiStore.getState().preferences.theme === initialTheme, {
        label: 'AppearanceTab theme cycled back to initial',
      });
      assert.equal(useTuiStore.getState().preferences.theme, initialTheme);

      // Switch to WorkspaceTab ('2') and verify 0 fetch calls on mount
      tty.send('2');
      const wsScreen = await tty.waitFor(
        (s) => s.includes('自动检查更新:') && s.includes('[a] 切换') && s.includes('[A] 检查更新'),
        { label: 'WorkspaceTab [A] 检查更新 visible (120x36 zh)' },
      );
      assertStrictScreen(tty, wsScreen, 120, 36, 'WorkspaceTab 120x36 zh');
      assert.equal(fetchCalls, 0, 'WorkspaceTab mount must trigger 0 fetch calls');
      await tty.flush();

      // Toggle auto-check off & back on via 'a' (0 fetch calls)
      tty.send('a');
      await tty.waitFor((s) => s.includes('已关闭自动检查更新'), {
        label: 'Auto update check disabled via [a]',
      });
      const prefOff = await host.call('update.preferences', {});
      assert.equal(prefOff.value?.autoCheck, false);

      tty.send('a');
      await tty.waitFor((s) => s.includes('已开启自动检查更新'), {
        label: 'Auto update check re-enabled via [a]',
      });
      const prefOn = await host.call('update.preferences', {});
      assert.equal(prefOn.value?.autoCheck, true);
      assert.equal(fetchCalls, 0, 'Toggling autoCheck must trigger 0 fetch calls');

      // Press 'A' to open Release Update Modal and run forced check
      tty.send('A');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('检查版本更新') &&
          s.includes('v9.9.9') &&
          s.includes('发现新版本') &&
          s.includes('Faster FSRS review'),
        { label: 'Release Update Modal displays mocked v9.9.9 & notes (zh)' },
      );
      assertStrictScreen(tty, modalScreen, 120, 36, 'ReleaseUpdateModal 120x36 zh');
      assert.equal(fetchCalls, 1, 'Pressing [A] must trigger update.check fetch once');

      // Press 'z' to snooze, then 'z' again to unsnooze
      tty.send('z');
      const snoozedScreen = await tty.waitFor(
        (s) => s.includes('检查版本更新') && s.includes('已推迟提醒'),
        { label: 'Release Update Modal displays snoozed status after [z] (zh)' },
      );
      assertStrictScreen(tty, snoozedScreen, 120, 36, 'ReleaseUpdateModal snoozed 120x36 zh');

      tty.send('z');
      await tty.waitFor((s) => s.includes('已恢复 v9.9.9 更新提醒'), {
        label: 'Release Update Modal unsnoozed after second [z] (zh)',
      });

      // Press Esc to close modal cleanly
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('检查版本更新') && s.includes('[A] 检查更新'),
        { label: 'Release Update Modal closed via Esc (zh)' },
      );
      assertStrictScreen(tty, closedScreen, 120, 36, 'WorkspaceTab after update modal close 120x36 zh');

      // Folded 80x24 AppearanceTab readout + WorkspaceTab [A] offline fail-soft modal check in same mounted app
      tty.resize(80, 24);
      tty.send('4');
      const appNarrow = await tty.waitFor(
        (s) =>
          s.includes(process.platform) &&
          /L[0-3]\)/.test(s) &&
          s.includes('SGR 1006:') &&
          s.split('\n').length <= 24,
        { label: 'AppearanceTab capability readout at 80x24 (zh)' },
      );
      assertStrictScreen(tty, appNarrow, 80, 24, 'AppearanceTab 80x24 zh');
      assert.equal(fetchCalls, 1, 'Resizing/switching to AppearanceTab must not trigger fetch');

      tty.send('2');
      const wsNarrow = await tty.waitFor(
        (s) => s.includes('自动检查更新:') && s.includes('[a] 切换') && s.includes('[A] 检查更新') && s.split('\n').length <= 24,
        { label: 'WorkspaceTab at 80x24 (zh)' },
      );
      assertStrictScreen(tty, wsNarrow, 80, 24, 'WorkspaceTab 80x24 zh');

      await rm(join(dshHome, 'study', 'update.json'), { force: true });
      fetchImpl = async () => {
        throw new Error('offline network error');
      };
      tty.send('A');
      const offlineModalScreen = await tty.waitFor(
        (s) => s.includes('检查版本更新') && s.includes('离线 / 网络不可用'),
        { label: 'Release Update Modal displays graceful offline status (80x24 zh)' },
      );
      assertStrictScreen(tty, offlineModalScreen, 80, 24, 'ReleaseUpdateModal offline 80x24 zh');
      assert.ok(offlineModalScreen.includes('离线 / 网络不可用'));
      assert.ok(fetchCalls >= 2, 'Pressing [A] for offline check should attempt fetch');

      tty.send('\x1b');
      const closedOfflineScreen = await tty.waitFor(
        (s) => !s.includes('检查版本更新') && s.includes('[A] 检查更新'),
        { label: 'Offline Release Update Modal closed via Esc (80x24 zh)' },
      );
      assertStrictScreen(tty, closedOfflineScreen, 80, 24, 'WorkspaceTab after offline modal close 80x24 zh');
      assert.equal(useTuiStore.getState().page, 'settings');
      assert.equal(useTuiStore.getState().lastError ?? null, null);
    });

    test('10) Host integration (round61): usage.frequency enable, record, report (7/30/all), pause/resume & export JSON/Markdown (0 fetch)', async () => {
      fetchCalls = 0;
      const today = todayLocalYmd();

      const enableRes = await host.call('usage.frequency.set', { enabled: true });
      assert.equal(enableRes.ok, true, enableRes.error?.message);
      assert.equal(enableRes.value.enabled, true);
      assert.equal(enableRes.value.paused, false);

      const recRes = await host.call('usage.frequency.record', {
        records: [
          { key: 'review.option', area: 'review', day: today, n: 12 },
          { key: 'review.flip', area: 'review', day: today, n: 8 },
          { key: 'nav.library', area: 'library', day: today, n: 5 },
        ],
      });
      assert.equal(recRes.ok, true, recRes.error?.message);
      assert.equal(recRes.value.accepted, 3);
      assert.equal(recRes.value.rejected, 0);

      for (const period of [7, 30, 'all']) {
        const reportRes = await host.call('usage.frequency.report', { period, language: 'zh' });
        assert.equal(reportRes.ok, true, reportRes.error?.message);
        assert.equal(reportRes.value.period, period);
        assert.equal(reportRes.value.summary.interactions, 25);
        assert.equal(reportRes.value.summary.daysWithData, 1);
        assert.equal(reportRes.value.summary.distinctControls, 3);
        assert.equal(reportRes.value.ranking[0].key, 'review.option');
        assert.equal(reportRes.value.ranking[0].count, 12);
        assert.ok(Array.isArray(reportRes.value.observations) && reportRes.value.observations.length >= 1);
      }

      const pauseRes = await host.call('usage.frequency.set', { paused: true });
      assert.equal(pauseRes.ok, true, pauseRes.error?.message);
      assert.equal(pauseRes.value.enabled, true);
      assert.equal(pauseRes.value.paused, true);

      const resumeRes = await host.call('usage.frequency.set', { paused: false });
      assert.equal(resumeRes.ok, true, resumeRes.error?.message);
      assert.equal(resumeRes.value.enabled, true);
      assert.equal(resumeRes.value.paused, false);

      const exportRes = await host.call('usage.frequency.export', { format: 'json', period: 30, language: 'en' });
      assert.equal(exportRes.ok, true, exportRes.error?.message);
      assert.match(exportRes.value.filename, /^studyhub-usage-\d{4}-\d{2}-\d{2}\.json$/);
      assert.equal(exportRes.value.mime, 'application/json');
      const parsed = JSON.parse(exportRes.value.content);
      assert.equal(parsed.app, 'StudyHub');
      assert.equal(parsed.summary.interactions, 25);
      assert.equal(parsed.controls.length, 3);

      const mdExport = await host.call('usage.frequency.export', { format: 'markdown', period: 7, language: 'en' });
      assert.equal(mdExport.ok, true, mdExport.error?.message);
      assert.match(mdExport.value.filename, /^studyhub-usage-\d{4}-\d{2}-\d{2}\.md$/);
      assert.equal(mdExport.value.mime, 'text/markdown');
      assert.ok(mdExport.value.content.includes('# StudyHub usage report'));
      assert.ok(mdExport.value.content.includes('Interactions: 25'));
      assert.ok(mdExport.value.content.includes('Controls used: 3'));
      assert.equal(fetchCalls, 0, 'usage frequency operations must make 0 network/model calls');
    });

    test('11) PTY E2E (round61): UsageReportModal [1] 7d / [2] 30d / [p] pause-resume / [e] export JSON (120x36 zh) & [3] All (80x24 --ascii en)', async () => {
      fetchCalls = 0;
      const statusRes = await host.call('usage.frequency.set', { enabled: true, paused: false });
      assert.equal(statusRes.ok, true, statusRes.error?.message);

      // 120x36 zh flow
      const ttyZh = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
      await ttyZh.waitFor((s) => s.includes('学习库') || s.includes('Library'), {
        label: 'Initial Library view rendered (zh)',
      });
      await ttyZh.flush(60);

      ttyZh.send(',');
      await ttyZh.flush(40);
      if (useTuiStore.getState().page !== 'settings') ttyZh.send(',');
      await ttyZh.waitFor(
        (s) =>
          useTuiStore.getState().page === 'settings' &&
          s.includes('模型配置') &&
          s.includes('学习库与工作区'),
        { label: 'SettingsView rendered via , (zh)' },
      );
      await ttyZh.flush(25);

      ttyZh.send('2');
      const wsZh = await ttyZh.waitFor(
        (s) => s.includes('使用频率记录:') && s.includes('[i] 报表'),
        { label: 'WorkspaceTab [i] 报表 visible (120x36 zh)' },
      );
      assertStrictScreen(ttyZh, wsZh, 120, 36, 'WorkspaceTab 120x36 zh');
      assert.equal(fetchCalls, 0, 'WorkspaceTab mount must trigger 0 fetch calls');
      await ttyZh.flush();

      ttyZh.send('i');
      const modalScreen = await ttyZh.waitFor(
        (s) =>
          s.includes('本地使用频率报表') &&
          s.includes('运行中') &&
          s.includes('互动 25 次') &&
          s.includes('选择答案选项'),
        { label: 'UsageReportModal displays stats & top controls (120x36 zh)' },
      );
      assertStrictScreen(ttyZh, modalScreen, 120, 36, 'UsageReportModal 120x36 zh');

      ttyZh.send('2');
      const period30Screen = await ttyZh.waitFor(
        (s) => s.includes('本地使用频率报表') && s.includes('最近 30 天') && s.includes('互动 25 次'),
        { label: 'UsageReportModal switched to 30d period via [2] (zh)' },
      );
      assertStrictScreen(ttyZh, period30Screen, 120, 36, 'UsageReportModal 30d 120x36 zh');

      ttyZh.send('1');
      const period7Screen = await ttyZh.waitFor(
        (s) => s.includes('本地使用频率报表') && s.includes('最近 7 天') && s.includes('互动 25 次'),
        { label: 'UsageReportModal switched to 7d period via [1] (zh)' },
      );
      assertStrictScreen(ttyZh, period7Screen, 120, 36, 'UsageReportModal 7d 120x36 zh');

      ttyZh.send('p');
      const pausedScreen = await ttyZh.waitFor(
        (s) => s.includes('本地使用频率报表') && s.includes('已暂停'),
        { label: 'UsageReportModal displays Paused status after [p] (zh)' },
      );
      assertStrictScreen(ttyZh, pausedScreen, 120, 36, 'UsageReportModal paused 120x36 zh');

      ttyZh.send('p');
      await ttyZh.waitFor(
        (s) => s.includes('本地使用频率报表') && s.includes('运行中') && s.includes('已恢复使用频率记录'),
        { label: 'UsageReportModal resumed after second [p] (zh)' },
      );

      const backupsDir = join(libraryRoot, 'backups');
      await rm(backupsDir, { recursive: true, force: true });
      ttyZh.send('e');
      const exportedScreen = await ttyZh.waitFor(
        (s) => s.includes('studyhub-usage-') && s.includes('已导出'),
        { label: 'UsageReportModal confirms JSON export after [e] (zh)' },
      );
      assertStrictScreen(ttyZh, exportedScreen, 120, 36, 'UsageReportModal exported 120x36 zh');

      const usageExport = await findExportedBackupFile(backupsDir, 'studyhub-usage', 'json', todayLocalYmd());
      assert.ok(usageExport, `expected studyhub-usage-${todayLocalYmd()}-HHmmss.json in ${backupsDir}`);
      const rawExported = await readFile(usageExport.path, 'utf8');
      const exportedJson = JSON.parse(rawExported);
      assert.equal(exportedJson.app, 'StudyHub');
      assert.equal(exportedJson.period, 7);
      assert.equal(exportedJson.summary.interactions, 25);
      assert.equal(exportedJson.controls[0].key, 'review.option');

      // Folded [3] All time period check at 80x24 in same mounted app
      ttyZh.resize(80, 24);
      ttyZh.send('3');
      const allScreen = await ttyZh.waitFor(
        (s) => s.includes('本地使用频率报表') && s.includes('全部时间') && s.includes('互动 25 次') && s.split('\n').length <= 24,
        { label: 'UsageReportModal switched to All time via [3] (80x24 zh)' },
      );
      assertStrictScreen(ttyZh, allScreen, 80, 24, 'UsageReportModal All 80x24 zh');
      assert.ok(allScreen.includes('全部时间'));

      ttyZh.send('\x1b');
      const closedZh = await ttyZh.waitFor(
        (s) => !s.includes('本地使用频率报表') && s.includes('[i] 报表'),
        { label: 'UsageReportModal closed via Esc (zh)' },
      );
      assertStrictScreen(ttyZh, closedZh, 80, 24, 'WorkspaceTab after usage report close 80x24 zh');
      assert.equal(fetchCalls, 0);
    });

    test('12) Host integration (round62): load sample course -> library.context {} verifies counts, courses, areas, focus (0 fetch)', async () => {
      fetchCalls = 0;

      await cloneSampleLibrary('zh', libraryRoot);
      const snapAfterClone = await host.refreshSnapshot();
      assert.ok(snapAfterClone, 'refreshSnapshot after cloneSampleLibrary must return snapshot');

      const ctxRes = await host.call('library.context', {});
      assert.equal(ctxRes.ok, true, ctxRes.error?.message);
      const ctx = ctxRes.value;

      assert.equal(ctx.library, libraryRoot);
      assert.match(ctx.today, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(typeof ctx.timeZone === 'string' && ctx.timeZone.length > 0);
      assert.ok(ctx.focus && typeof ctx.focus.mode === 'string');
      assert.ok(typeof ctx.focus.course === 'string' && ctx.focus.course.length > 0, 'expected sample course in focus.course');
      assert.equal(typeof ctx.focus.role, 'string');

      assert.ok(ctx.counts.sources >= 1, `expected >= 1 source, got ${ctx.counts.sources}`);
      assert.ok(ctx.counts.decks >= 1, `expected >= 1 deck, got ${ctx.counts.decks}`);
      assert.equal(typeof ctx.counts.archivedDecks, 'number');
      assert.equal(typeof ctx.counts.drafts, 'number');
      assert.ok(ctx.counts.cards >= 1, `expected >= 1 card, got ${ctx.counts.cards}`);

      assert.ok(Array.isArray(ctx.courses) && ctx.courses.length >= 1, 'expected courses array');
      assert.ok(ctx.courses.includes(ctx.focus.course), 'expected focus course in courses list');
      assert.equal(typeof ctx.coursesPage?.total, 'number');
      assert.ok(Array.isArray(ctx.areas) && ctx.areas.length >= 1, 'expected areas array');
      assert.equal(fetchCalls, 0, 'library.context must make 0 model/network calls');
    });

    test('13) PTY E2E (round62 120x36 zh): WorkspaceTab [L] LibraryContextModal -> [r] refresh -> [e] export JSON -> Esc', async () => {
      fetchCalls = 0;

      const ctxRes = await host.call('library.context', {});
      assert.equal(ctxRes.ok, true, ctxRes.error?.message);
      const expectedCtx = ctxRes.value;

      const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), {
        label: 'Initial Library view rendered (zh)',
      });
      await tty.flush();

      tty.send(',');
      await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'settings' &&
          s.includes('模型配置') &&
          s.includes('学习库与工作区'),
        { label: 'SettingsView rendered via , (zh)' },
      );
      await tty.flush(25);

      tty.send('2');
      const wsScreen = await tty.waitFor(
        (s) => s.includes('当前学习库:') && s.includes('[L] 上下文'),
        { label: 'WorkspaceTab [L] 上下文 visible (120x36 zh)' },
      );
      assertStrictScreen(tty, wsScreen, 120, 36, 'WorkspaceTab 120x36 zh');
      assert.equal(fetchCalls, 0, 'WorkspaceTab mount must trigger 0 fetch calls');
      await tty.flush();

      tty.send('L');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('学习库上下文总览') &&
          s.includes(`资料 ${expectedCtx.counts.sources}`) &&
          s.includes(`题组 ${expectedCtx.counts.decks}`) &&
          s.includes(`卡片 ${expectedCtx.counts.cards}`) &&
          s.includes(expectedCtx.focus.course),
        { label: 'LibraryContextModal shows counts, focus course & courses list (120x36 zh)' },
      );
      assertStrictScreen(tty, modalScreen, 120, 36, 'LibraryContextModal 120x36 zh');

      tty.send('r');
      const refreshedScreen = await tty.waitFor(
        (s) => s.includes('学习库上下文总览') && s.includes('可用上下文域:') && s.includes(expectedCtx.today),
        { label: 'LibraryContextModal refreshed via [r] (zh)' },
      );
      assertStrictScreen(tty, refreshedScreen, 120, 36, 'LibraryContextModal refreshed 120x36 zh');

      const backupsDir = join(libraryRoot, 'backups');
      await rm(backupsDir, { recursive: true, force: true });
      tty.send('e');
      const exportedScreen = await tty.waitFor(
        (s) => s.includes('已导出:') && s.includes('-context-') && s.includes('.json'),
        { label: 'LibraryContextModal confirms JSON export after [e] (zh)' },
      );
      assertStrictScreen(tty, exportedScreen, 120, 36, 'LibraryContextModal exported 120x36 zh');

      const ctxExport = await findExportedBackupFile(backupsDir, 'studyhub-context', 'json', todayLocalYmd());
      assert.ok(ctxExport, `expected studyhub-context-${todayLocalYmd()}-HHmmss.json in ${backupsDir}`);
      const rawExported = await readFile(ctxExport.path, 'utf8');
      const exportedJson = JSON.parse(rawExported);
      assert.equal(exportedJson.library, libraryRoot);
      assert.equal(exportedJson.today, expectedCtx.today);
      assert.equal(exportedJson.counts.sources, expectedCtx.counts.sources);
      assert.equal(exportedJson.counts.decks, expectedCtx.counts.decks);
      assert.equal(exportedJson.counts.cards, expectedCtx.counts.cards);
      assert.equal(exportedJson.focus.course, expectedCtx.focus.course);
      assert.deepEqual(exportedJson.areas, expectedCtx.areas);

      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('学习库上下文总览') && s.includes('[L] 上下文'),
        { label: 'LibraryContextModal closed via Esc (zh)' },
      );
      assertStrictScreen(tty, closedScreen, 120, 36, 'WorkspaceTab after library context close 120x36 zh');
      assert.equal(fetchCalls, 0);
    });
  });
});
