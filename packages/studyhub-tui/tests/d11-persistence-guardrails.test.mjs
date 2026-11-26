// Guardrail & regression tests for #1354 D11:
// 1) User free-text input and card stem text (`promptPreview`) must NEVER be persisted into
//    settings (`tui.json`) or usage (`tui-usage.json`).
// 2) Usage data (recommended chip IDs) lives in separate `tui-usage.json` with schema version,
//    UTF-8 BOM tolerance, [C38] unsupported-version refusal, and corrupt/unreadable protection.
// node --test tests/d11-persistence-guardrails.test.mjs
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [prefsMod, chipsMod, usageMod, stackMod, storeMod] = await Promise.all([
  import('../src/host/tui-prefs.ts'),
  import('../src/shell/assistant-chips.ts'),
  import('../src/shell/assistant-usage.ts'),
  import('../src/state/practice-stack.ts'),
  import('../src/state/store.ts'),
]);

const { loadTuiPreferences, saveTuiPreferences, tuiPreferencesPath } = prefsMod;
const { buildContextChips, PROMOTION_THRESHOLD } = chipsMod;
const { recordAssistantCommandUsage } = usageMod;
const { toLastPracticeContext } = stackMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

async function waitForFileFlush(ms = 120) {
  await new Promise((r) => setTimeout(r, ms));
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

describe('#1354 D11 — no user input or card prompt persisted into settings; usage separated', () => {
  test('free-text assistant input is NEVER written to tui.json or tui-usage.json', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-freetext-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, assistantCommandStats: undefined },
    });

    const host = { dshHome: dir };
    const secretPrompt = '帮我整理昨晚私人日记里的敏感思考内容 XYZ-987654';
    recordAssistantCommandUsage({ host, page: 'review', text: secretPrompt, kind: 'command' });
    recordAssistantCommandUsage({ host, page: 'library', text: 'my private free-text question 42', kind: 'command' });
    await waitForFileFlush();

    const prefsRaw = await readIfExists(tuiPreferencesPath({ env: { DSH_HOME: dir } }));
    assert.equal(prefsRaw, null, 'free-text assistant input must not create or touch tui.json');

    const usagePath = path.join(dir, 'study', 'tui-usage.json');
    const usageRaw = await readIfExists(usagePath);
    if (usageRaw !== null) {
      assert.ok(!usageRaw.includes(secretPrompt), 'tui-usage.json must never contain free-text user input');
      assert.ok(!usageRaw.includes('private free-text'), 'tui-usage.json must never contain free-text user input');
    }
  });

  test('known recommended chip usage persists ONLY chip IDs to separate tui-usage.json (never tui.json) and promotes on restart', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-chip-ids-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const tuiUsageMod = await import('../src/host/tui-usage.ts');
    const { loadTuiUsageSafe, tuiUsagePath, TUI_USAGE_SCHEMA_VERSION } = tuiUsageMod;

    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, assistantCommandStats: undefined },
    });
    const host = { dshHome: dir };

    for (let i = 0; i < PROMOTION_THRESHOLD; i += 1) {
      recordAssistantCommandUsage({ host, page: 'review', text: '查看统计', kind: 'command' });
    }
    await waitForFileFlush(200);

    // tui.json must remain untouched
    const prefsRaw = await readIfExists(tuiPreferencesPath({ env: { DSH_HOME: dir } }));
    assert.equal(prefsRaw, null, 'assistant chip usage must live in tui-usage.json, never tui.json');

    // tui-usage.json must exist and contain ONLY canonical chip ID ('chip:stats'), never raw Chinese command text
    const uPath = tuiUsagePath({ env: { DSH_HOME: dir } });
    const usageRaw = await readFile(uPath, 'utf8');
    assert.ok(!usageRaw.includes('查看统计'), 'tui-usage.json must store chip IDs, not raw command text');
    const parsedDisk = JSON.parse(usageRaw);
    assert.equal(parsedDisk.version, TUI_USAGE_SCHEMA_VERSION);
    assert.ok(parsedDisk.assistantChipStats?.review?.['chip:stats']?.count >= PROMOTION_THRESHOLD);

    // Reloading on next session promotes that chip in both zh and en
    const reloaded = await loadTuiUsageSafe({ env: { DSH_HOME: dir } });
    assert.equal(reloaded.status, 'ok');
    assert.ok(reloaded.usage.assistantChipStats?.review?.['chip:stats']?.count >= PROMOTION_THRESHOLD);

    const chipsZh = buildContextChips({
      page: 'review',
      card: { cardId: 'c1', isWrong: false },
      practiceStack: [],
      statsByPage: reloaded.usage.assistantChipStats,
      lang: 'zh',
    });
    assert.equal(chipsZh[0].id, 'chip:stats');
    assert.equal(chipsZh[0].promoted, true);
    assert.equal(chipsZh[0].label, '查看统计');

    const chipsEn = buildContextChips({
      page: 'review',
      card: { cardId: 'c1', isWrong: false },
      practiceStack: [],
      statsByPage: reloaded.usage.assistantChipStats,
      lang: 'en',
    });
    assert.equal(chipsEn[0].id, 'chip:stats');
    assert.equal(chipsEn[0].promoted, true);
    assert.equal(chipsEn[0].label, 'Today stats');

    // Cross-page persistence merges without clobbering existing pages, and default pages share `chip:stats`
    const { saveTuiUsage } = tuiUsageMod;
    await saveTuiUsage(
      { assistantChipStats: { library: { 'chip:stats': { count: 1, lastUsedAt: 999999 } } } },
      { env: { DSH_HOME: dir } },
    );
    const mergedAfterLib = await loadTuiUsageSafe({ env: { DSH_HOME: dir } });
    assert.ok(mergedAfterLib.usage.assistantChipStats?.review?.['chip:stats']?.count >= PROMOTION_THRESHOLD, 'review page chip stats must survive library save');
    assert.equal(mergedAfterLib.usage.assistantChipStats?.library?.['chip:stats']?.count, 1);
    const libChipsEn = buildContextChips({
      page: 'library',
      card: null,
      practiceStack: [],
      statsByPage: mergedAfterLib.usage.assistantChipStats,
      lang: 'en',
    });
    assert.equal(libChipsEn[0].id, 'chip:stats');
    assert.equal(libChipsEn[0].recent, true);
    assert.equal(libChipsEn[0].label, 'View stats');
  });

  test('toLastPracticeContext and saveTuiPreferences strip promptPreview and free-text assistantCommandStats from tui.json', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-strip-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const frame = {
      kind: 'review',
      returnPage: 'review',
      runId: 'run-42',
      cardId: 'card-99',
      deckId: 'deck-7',
      cardIndex: 2,
      total: 10,
      promptPreview: '绝密考题题干原文：请推导拉格朗日乘数法在约束优化中的必要条件',
      originKind: 'source',
      pushedAt: 1700000000000,
    };

    // toLastPracticeContext must NOT emit promptPreview
    const persistRec = toLastPracticeContext(frame);
    assert.ok(persistRec);
    assert.equal(persistRec.runId, 'run-42');
    assert.equal(persistRec.cardId, 'card-99');
    assert.equal(persistRec.deckId, 'deck-7');
    assert.equal(persistRec.cardIndex, 2);
    assert.equal(persistRec.total, 10);
    assert.equal(Object.hasOwn(persistRec, 'promptPreview'), false, 'toLastPracticeContext must omit promptPreview');

    // Even if a legacy caller passes promptPreview and free-text assistantCommandStats to saveTuiPreferences,
    // tui.json must strip them before writing.
    await saveTuiPreferences(
      {
        theme: 'nord',
        lastPracticeContext: {
          runId: 'run-42',
          cardId: 'card-99',
          cardIndex: 2,
          promptPreview: '不应落盘的题干文本',
          savedAt: 1700000000000,
        },
        assistantCommandStats: {
          review: {
            '用户手打的自由文本秘密': { count: 4, lastUsedAt: 1700000001000 },
            'chip:stats': { count: 3, lastUsedAt: 1700000002000 },
          },
        },
      },
      { env: { DSH_HOME: dir } },
    );

    const diskRaw = await readFile(tuiPreferencesPath({ env: { DSH_HOME: dir } }), 'utf8');
    assert.ok(!diskRaw.includes('不应落盘的题干文本'), 'tui.json must never store promptPreview');
    assert.ok(!diskRaw.includes('用户手打的自由文本秘密'), 'tui.json must never store free-text user input');

    const loaded = await loadTuiPreferences({ env: { DSH_HOME: dir } });
    assert.equal(loaded.theme, 'nord');
    assert.equal(loaded.lastPracticeContext?.runId, 'run-42');
    assert.equal(loaded.lastPracticeContext?.promptPreview, undefined);
    assert.equal(loaded.assistantCommandStats?.review?.['用户手打的自由文本秘密'], undefined);
  });

  test('tui-usage.json protects against corrupt JSON, unreadable path, UTF-8 BOM, and future schema versions [C38]', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-usage-guards-'));
    t.after(async () => {
      await chmod(path.join(dir, 'unreadable.json'), 0o600).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    });

    const tuiUsageMod = await import('../src/host/tui-usage.ts');
    const { loadTuiUsageSafe, saveTuiUsage } = tuiUsageMod;

    // 1) Corrupt JSON: passive save skips and leaves original bytes untouched
    const corruptPath = path.join(dir, 'corrupt.json');
    const corruptBytes = '{"version":1,"assistantChipStats": BROKEN';
    await writeFile(corruptPath, corruptBytes, 'utf8');

    const loadedCorrupt = await loadTuiUsageSafe({ filePath: corruptPath });
    assert.equal(loadedCorrupt.status, 'corrupt');

    await saveTuiUsage({ assistantChipStats: { review: { 'chip:stats': { count: 1, lastUsedAt: 100 } } } }, { filePath: corruptPath });
    assert.equal(await readFile(corruptPath, 'utf8'), corruptBytes, 'passive save must not overwrite corrupt tui-usage.json');

    // Explicit recovery backs up corrupt file first
    await saveTuiUsage(
      { assistantChipStats: { review: { 'chip:stats': { count: 2, lastUsedAt: 200 } } } },
      { filePath: corruptPath, recover: true },
    );
    const files = await readdir(dir);
    const bak = files.find((f) => f.startsWith('corrupt.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(bak, `expected backup file before recovery, got: ${files.join(', ')}`);
    assert.equal(await readFile(path.join(dir, bak), 'utf8'), corruptBytes);
    assert.equal((await loadTuiUsageSafe({ filePath: corruptPath })).status, 'ok');

    // 2) UTF-8 BOM reads cleanly (not flagged corrupt)
    const bomPath = path.join(dir, 'bom.json');
    await writeFile(
      bomPath,
      `\uFEFF${JSON.stringify({ version: 1, assistantChipStats: { review: { 'chip:stats': { count: 3, lastUsedAt: 300 } } } })}`,
      'utf8',
    );
    const bomRes = await loadTuiUsageSafe({ filePath: bomPath });
    assert.equal(bomRes.status, 'ok');
    assert.equal(bomRes.usage.assistantChipStats?.review?.['chip:stats']?.count, 3);

    // 3) Future/invalid schema version [C38]: refuses overwrite even on recover: true and leaves bytes untouched
    for (const badVer of [2, '2', 0, null]) {
      const futurePath = path.join(dir, `future-${String(badVer)}.json`);
      const futureBytes = JSON.stringify({ version: badVer, assistantChipStats: { review: { 'chip:stats': { count: 9, lastUsedAt: 9 } } }, extraFutureField: true });
      await writeFile(futurePath, futureBytes, 'utf8');

      const res = await loadTuiUsageSafe({ filePath: futurePath });
      assert.equal(res.status, 'unsupported-version', `version=${JSON.stringify(badVer)} must be unsupported-version`);

      await saveTuiUsage({ assistantChipStats: { review: { 'chip:stats': { count: 1, lastUsedAt: 1 } } } }, { filePath: futurePath });
      assert.equal(await readFile(futurePath, 'utf8'), futureBytes, 'passive save must not overwrite future version');

      await assert.rejects(
        saveTuiUsage(
          { assistantChipStats: { review: { 'chip:stats': { count: 1, lastUsedAt: 1 } } } },
          { filePath: futurePath, recover: true },
        ),
        /version|unsupported/i,
      );
      assert.equal(await readFile(futurePath, 'utf8'), futureBytes, 'recover save must not overwrite future version');
    }

    // 4) Unreadable path (portable EISDIR directory stand-in) refuses overwrite
    const dirTarget = path.join(dir, 'dir-as-file.json');
    await mkdir(dirTarget);
    const dirRes = await loadTuiUsageSafe({ filePath: dirTarget });
    assert.equal(dirRes.status, 'unreadable');
    await assert.rejects(
      saveTuiUsage({ assistantChipStats: { review: { 'chip:stats': { count: 1, lastUsedAt: 1 } } } }, { filePath: dirTarget }),
      /EISDIR|could not be read|unreadable/i,
    );
    assert.equal((await stat(dirTarget)).isDirectory(), true);
  });
});
