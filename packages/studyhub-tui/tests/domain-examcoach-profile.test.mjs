// Consolidated ExamCoach Profile & Consent Domain Suite
// Merges: round43-coach-consent, round53-coach-bullets
// node --test tests/domain-examcoach-profile.test.mjs
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useDistTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-coach-profile-');

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
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
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
    ...extra,
  });
}

after(async () => {
  restoreNetworkGuard();
  resetDistStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

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

async function waitForCoachIdle(host) {
  for (let i = 0; i < 5; i += 1) {
    const st = await host.call('coach.status', {});
    if (st.ok && !st.value?.preparing) return;
    await new Promise((r) => setImmediate(r));
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const st = await host.call('coach.status', {});
    if (st.ok && !st.value?.preparing) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('Round 43: Coach Background Prep Consent & Learner Profile Reset', () => {
  test('1) createTuiHost integration: coach.profile -> coach.consent (true/false) -> coach.preferences + coach.goal -> coach.forget', async () => {
    const base = await temps.make('r43-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);

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
      const initSnap = await host.call('snapshot', {});
      assert.equal(initSnap.ok, true, initSnap.error?.message);

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
      await waitForCoachIdle(host);

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

  test('2) PTY E2E: CoachPreferencesModal [p] consent (ConfirmDialog on opt-in, direct off) & [F] danger reset in zh (120x36 & 80x24)', async () => {
    const zhBase = await temps.make('r43-pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: zhDshHome }) },
    );

    const zhLibraryRoot = join(zhBase, 'library');
    await cloneSampleLibrary('zh', zhLibraryRoot);

    let zhAiCalls = 0;
    const zhHost = await createTuiHost({
      libraryRoot: zhLibraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: zhDshHome }),
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
          autoLaunchpad: false,
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

      await zhTty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
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
      assert.equal(prof.ok, true);
      assert.equal(prof.value?.consent, true);

      // Press [p] while ON -> directly turns OFF without ConfirmDialog
      zhTty.send('p');
      const zhConsentOff = await zhTty.waitFor(
        (s) => s.includes('[p] 后台备题: OFF') && !s.includes('开启后台变式备题'),
        { timeoutMs: 8_000, label: 'zh consent turned OFF directly' },
      );
      zhTty.assertHealthyScreen(zhConsentOff, 120, 36, 'zh CoachPreferencesModal prep OFF');

      prof = await zhHost.call('coach.profile', {});
      assert.equal(prof.ok, true);
      assert.equal(prof.value?.consent, false);

      // Wait for any background prep from earlier opt-in to settle, then ensure forget makes 0 AI calls
      await waitForCoachIdle(zhHost);
      await zhTty.flush();
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

      const zhProfBeforeForget = await zhHost.call('coach.profile', {});
      assert.equal(zhProfBeforeForget.ok, true);
      assert.equal(zhProfBeforeForget.value?.goal, 'exam');
      assert.deepEqual(zhProfBeforeForget.value?.preferences, ['多做工程案例']);
      assert.equal(zhProfBeforeForget.value?.memoryRevision, 2);

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
      assert.equal(useDistTuiStore.getState().page, 'examcoach');

      zhTty.send('F');
      await zhTty.waitFor((s) => s.includes('历史练习记录与题库完整保留'), { timeoutMs: 5_000, label: 'zh forget ConfirmDialog reopened for y' });
      zhTty.send('y');
      const zhAfterForget = await zhTty.waitFor(
        (s) => !s.includes('历史练习记录与题库完整保留') && s.includes('[g] 目标: 未设定') && s.includes('0/12'),
        { timeoutMs: 8_000, label: 'zh profile forgotten via ConfirmDialog' },
      );
      zhTty.assertHealthyScreen(zhAfterForget, 80, 24, 'zh CoachPreferencesModal after forget 80x24');

      const zhProfFinal = await zhHost.call('coach.profile', {});
      assert.equal(zhProfFinal.ok, true);
      assert.equal(zhProfFinal.value?.goal, '');
      assert.deepEqual(zhProfFinal.value?.preferences, []);
      assert.deepEqual(zhProfFinal.value?.bullets, []);
      assert.notEqual(zhProfFinal.value?.consent, true);
      assert.equal(zhProfFinal.value?.memoryRevision, 3);
      assert.equal(zhAiCalls, zhCallsBeforeForgetFlow, 'goal + preference + forget must make 0 AI calls');
      assert.equal(useDistTuiStore.getState().page, 'examcoach');
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }
  });
});

describe('Round 53: CoachPreferencesModal Learner Memory Bullets CRUD', () => {
  test('1) createTuiHost integration (0 AI calls): coach.profile addBullet / removeBullet with expectedRevision', async () => {
    const base = await temps.make('r53-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);

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
      const initSnap = await host.call('snapshot', {});
      assert.equal(initSnap.ok, true, initSnap.error?.message);

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

      // Empty bullet text must be rejected cleanly
      const emptyBulletRes = await host.call('coach.profile', {
        addBullet: { text: '   ' },
        expectedRevision: rev0 + 1,
      });
      assert.equal(emptyBulletRes.ok, false, 'empty bullet text must fail cleanly');
      assert.ok(emptyBulletRes.error?.message);

      // Verify persistence on reload
      const prof1 = await host.call('coach.profile', {});
      assert.equal(prof1.ok, true);
      assert.equal(prof1.value?.memoryRevision, rev0 + 1);
      assert.equal(prof1.value?.bullets?.length, 1);
      assert.equal(prof1.value.bullets[0].id, added.id);
      assert.equal(prof1.value.bullets[0].text, 'Always check boundary cases before proving invariants');
      assert.equal(prof1.value.bullets[0].source, 'user');

      // Verify stale expectedRevision is rejected
      const staleRes = await host.call('coach.profile', {
        addBullet: { text: 'Should fail on stale revision' },
        expectedRevision: rev0,
      });
      assert.equal(staleRes.ok, false, 'stale expectedRevision should fail');
      assert.ok(staleRes.error?.message);

      // Remove nonexistent bullet fails cleanly or leaves bullets intact
      const missRemRes = await host.call('coach.profile', {
        removeBullet: 'nonexistent-bullet-id',
        expectedRevision: rev0 + 1,
      });
      assert.equal(missRemRes.ok, true);
      assert.equal(missRemRes.value?.bullets?.length, 1);
      const revAfterMiss = missRemRes.value?.memoryRevision ?? (rev0 + 1);

      // Remove bullet with current expectedRevision
      const remRes = await host.call('coach.profile', {
        removeBullet: added.id,
        expectedRevision: revAfterMiss,
      });
      assert.equal(remRes.ok, true, remRes.error?.message);
      assert.equal(remRes.value?.memoryRevision, revAfterMiss + 1);
      assert.deepEqual(remRes.value?.bullets, []);
      assert.equal(aiCalls, 0, 'coach.profile removeBullet must make 0 AI calls');

      const prof2 = await host.call('coach.profile', {});
      assert.equal(prof2.ok, true);
      assert.equal(prof2.value?.memoryRevision, revAfterMiss + 1);
      assert.deepEqual(prof2.value?.bullets, []);
      assert.equal(aiCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: Tab 2 Memory Bullets CRUD + HelpOverlay at 120x36 & 80x24 (zh)', async () => {
    const zhBase = await temps.make('r53-pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: zhDshHome }) },
    );

    const zhLibraryRoot = join(zhBase, 'library');
    await cloneSampleLibrary('zh', zhLibraryRoot);

    let zhAiCalls = 0;
    const zhHost = await createTuiHost({
      libraryRoot: zhLibraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: zhDshHome }),
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
          autoLaunchpad: false,
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

      await zhTty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
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
      assert.equal(zhProf1.ok, true);
      assert.equal(zhProf1.value?.bullets?.length, 1);
      assert.equal(zhProf1.value.bullets[0].text, '先看反例再写推导');
      assert.equal(zhProf1.value.bullets[0].source, 'user');
      assert.ok(zhProf1.value.bullets[0].id);
      assert.equal(zhAiCalls, 0);

      // Press [d] to remove selected bullet
      zhTty.send('d');
      const zhBulletsRemoved = await zhTty.waitFor(
        (s) => s.includes('记忆要点 (0)') && !s.includes('先看反例再写推导') && s.includes('暂无记忆要点'),
        { timeoutMs: 8_000, label: 'zh bullet removed via d' },
      );
      assert.ok(zhBulletsRemoved.includes('暂无记忆要点'));
      zhTty.assertHealthyScreen(zhBulletsRemoved, 120, 36, 'zh Tab 2 bullet removed');

      const zhProf2 = await zhHost.call('coach.profile', {});
      assert.equal(zhProf2.ok, true);
      assert.equal(zhProf2.value?.bullets?.length, 0);
      assert.deepEqual(zhProf2.value?.bullets, []);
      assert.equal(zhAiCalls, 0);

      // Resize to 80x24 and verify Tab 1 -> Tab 2 via '2' key, bullet CRUD at narrow width, and HelpOverlay at 80x24
      zhTty.resize(80, 24);
      zhTty.send('1');
      const zhTab1Narrow = await zhTty.waitFor(
        (s) => s.includes('[p] 后台备题:') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'zh switched back to Tab 1 at 80x24' },
      );
      zhTty.assertHealthyScreen(zhTab1Narrow, 80, 24, 'zh CoachPreferencesModal Tab 1 80x24');

      zhTty.send('2');
      const zhTab2Narrow = await zhTty.waitFor(
        (s) => s.includes('暂无记忆要点') && s.includes('记忆要点 (0)') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'zh switched to Tab 2 via 2 at 80x24' },
      );
      zhTty.assertHealthyScreen(zhTab2Narrow, 80, 24, 'zh Tab 2 empty 80x24');

      zhTty.send('a');
      await zhTty.waitFor((s) => s.includes('新增要点'), { timeoutMs: 5_000, label: 'zh add bullet input opened at 80x24' });
      zhTty.send('先检查边界条件');
      await zhTty.waitFor((s) => s.includes('先检查边界条件'), { timeoutMs: 5_000, label: 'zh bullet typed at 80x24' });
      zhTty.send('\r');
      const zhNarrowOne = await zhTty.waitFor(
        (s) => !s.includes('新增要点') && s.includes('记忆要点 (1)') && s.includes('先检查边界条件') && s.includes('[用户]'),
        { timeoutMs: 8_000, label: 'zh bullet added at 80x24' },
      );
      zhTty.assertHealthyScreen(zhNarrowOne, 80, 24, 'zh Tab 2 bullet added 80x24');

      zhTty.send('d');
      const zhNarrowRemoved = await zhTty.waitFor(
        (s) => s.includes('记忆要点 (0)') && !s.includes('先检查边界条件') && s.includes('暂无记忆要点'),
        { timeoutMs: 8_000, label: 'zh bullet removed via d at 80x24' },
      );
      zhTty.assertHealthyScreen(zhNarrowRemoved, 80, 24, 'zh Tab 2 bullet removed 80x24');

      const zhProfFinal = await zhHost.call('coach.profile', {});
      assert.equal(zhProfFinal.ok, true);
      assert.equal(zhProfFinal.value?.bullets?.length, 0);
      assert.deepEqual(zhProfFinal.value?.bullets, []);
      assert.equal(zhAiCalls, 0);

      // Close modal & check HelpOverlay at 80x24 and 120x36
      zhTty.send('\x1b');
      await zhTty.waitFor(
        (s) => !s.includes('学习者画像与长期偏好') && s.includes('考试教练'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal closed' },
      );
      zhTty.send('?');
      const zhHelpNarrow = await zhTty.waitFor(
        (s) => s.includes('快捷键') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'zh HelpOverlay opened at 80x24' },
      );
      zhTty.assertHealthyScreen(zhHelpNarrow, 80, 24, 'zh HelpOverlay 80x24');

      zhTty.resize(120, 36);
      const zhHelp = await zhTty.waitFor(
        (s) => s.includes('快捷键') && s.includes('题组导入/AI'),
        { timeoutMs: 5_000, label: 'zh HelpOverlay resized to 120x36' },
      );
      zhTty.assertHealthyScreen(zhHelp, 120, 36, 'zh HelpOverlay 120x36');
      zhTty.send(' ');
      await zhTty.flush(30);
      zhTty.send('j');
      const zhHelpScrolled = await zhTty.waitFor(
        (s) => s.includes('本轮 AI 复盘点评'),
        { timeoutMs: 5_000, label: 'zh HelpOverlay scrolled to Review debrief' },
      );
      zhTty.assertHealthyScreen(zhHelpScrolled, 120, 36, 'zh HelpOverlay scrolled 120x36');
      assert.equal(useDistTuiStore.getState().helpOpen, true);
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }
  });
});
