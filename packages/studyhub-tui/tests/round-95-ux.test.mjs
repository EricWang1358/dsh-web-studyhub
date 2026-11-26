// Round 95 comprehensive behavior & layout tests:
// - Track A13: BookView 96-col ultrawide prose centering + reading-time subtitle
// - Track D9: Proactive pacing fatigue rest nudge (`fatigue-nudge.ts` >= 25 cards, max 1/round, opt-out, non-interrupting)
// - Track B9: Persistent quick-jump bookmarks (`pinnedTargets` in tui.json capped at 5 + `/pin` in CommandPalette)
// node --test tests/round-95-ux.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
const tempDirs = [];
after(async () => {
  unregisterTsx?.();
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const [
  fatigueMod,
  prefsMod,
  paletteMod,
  storeMod,
] = await Promise.all([
  import('../src/views/review/fatigue-nudge.ts'),
  import('../src/host/tui-prefs.ts'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/state/store.ts'),
]);

const { shouldShowFatigueNudge, buildFatigueNudgeBanner } = fatigueMod;
const { saveTuiPreferences, loadTuiPreferences } = prefsMod;
const { buildPaletteItems } = paletteMod;
const { useTuiStore } = storeMod;

describe('Round 95 Track D9 — Proactive Pacing Fatigue Rest Nudge (3 Guardrails)', () => {
  test('triggers at >= 25 answered cards, fires at most once per round, and honors disable/typing/modal guards', () => {
    const base = {
      enabled: true,
      isActive: true,
      isEditing: false,
      anyModalOpen: false,
      answeredInRound: 25,
      alreadyShownInRound: false,
    };
    assert.equal(shouldShowFatigueNudge(base), true);
    assert.equal(shouldShowFatigueNudge({ ...base, answeredInRound: 24 }), false);
    assert.equal(shouldShowFatigueNudge({ ...base, enabled: false }), false, 'Disable switch must block');
    assert.equal(shouldShowFatigueNudge({ ...base, alreadyShownInRound: true }), false, 'At most once per round');
    assert.equal(shouldShowFatigueNudge({ ...base, isEditing: true }), false, 'Never interrupts typing');
    assert.equal(shouldShowFatigueNudge({ ...base, anyModalOpen: true }), false, 'Never fires over modals');

    assert.match(buildFatigueNudgeBanner(25, 'zh', true), /连续作答 25 题.*小休 3 分钟/);
    assert.match(buildFatigueNudgeBanner(30, 'en', true), /30 cards done.*3-min break/);
  });
});

describe('Round 95 Track B9 — Persistent Quick-Jump Bookmarks (/pin + tui.json)', () => {
  test('persists up to 5 deduplicated pinnedTargets in tui.json and exposes /pin + pinned items in CommandPalette', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studyhub-r95-pins-'));
    tempDirs.push(dir);

    const rawPins = [
      { kind: 'page', id: 'wrongbook', label: '错题本' },
      { kind: 'page', id: 'wrongbook', label: '错题本重复' }, // duplicate
      { kind: 'deck', id: 'd1', label: '线代' },
      { kind: 'source', id: 's1', label: '讲义' },
      { kind: 'page', id: 'notes', label: '笔记' },
      { kind: 'page', id: 'dashboard', label: '统计' },
      { kind: 'page', id: 'board', label: '超上限6' },
    ];
    await saveTuiPreferences({ pinnedTargets: rawPins }, { env: { DSH_HOME: dir } });
    const loaded = await loadTuiPreferences({ env: { DSH_HOME: dir } });
    assert.equal(loaded.pinnedTargets?.length, 5, 'Should dedupe and cap at 5 pinned targets');
    assert.equal(loaded.pinnedTargets?.[0].id, 'wrongbook');

    // Toggle /pin in CommandPalette
    useTuiStore.setState({
      page: 'dashboard',
      preferences: { ...useTuiStore.getState().preferences, language: 'zh', asciiMode: true, pinnedTargets: [] },
    });
    const dummyActions = { refresh: async () => {}, switchCourse: async () => {}, loadSample: async () => {}, removeSample: async () => {}, quit: () => {} };
    const items1 = buildPaletteItems(useTuiStore.getState(), dummyActions, [], undefined);
    const pinCmd = items1.find((it) => it.id === 'cmd:pin');
    assert.ok(pinCmd, '/pin command must exist');
    pinCmd.action();
    assert.equal(useTuiStore.getState().preferences.pinnedTargets?.length, 1);
    assert.equal(useTuiStore.getState().preferences.pinnedTargets?.[0].id, 'dashboard');

    // Rebuilding palette now includes the pinned bookmark item
    const items2 = buildPaletteItems(useTuiStore.getState(), dummyActions, [], undefined);
    const pinnedItem = items2.find((it) => it.id === 'pin:page:dashboard');
    assert.ok(pinnedItem, 'Pinned bookmark must appear in CommandPalette');
    useTuiStore.setState({ page: 'library' });
    pinnedItem.action();
    assert.equal(useTuiStore.getState().page, 'dashboard');
  });
});
