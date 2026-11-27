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
const { buildContextChips, extractPersistableChipStats, PROMOTION_THRESHOLD, resolveAssistantChipId } = chipsMod;
const { recordAssistantCommandUsage } = usageMod;
const { toLastPracticeContext } = stackMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

async function waitForCondition(predicate, timeoutMs = 5000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function waitForSettledIdle(ms = 120) {
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
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, assistantCommandStats: undefined },
    });

    const host = { dshHome: dir };
    const secretPrompt = '帮我整理昨晚私人日记里的敏感思考内容 XYZ-987654';
    recordAssistantCommandUsage({ host, page: 'review', text: secretPrompt, kind: 'command' });
    recordAssistantCommandUsage({ host, page: 'library', text: 'my private free-text question 42', kind: 'command' });
    await waitForSettledIdle();

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
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

    const tuiUsageMod = await import('../src/host/tui-usage.ts');
    const { loadTuiUsageSafe, tuiUsagePath, TUI_USAGE_SCHEMA_VERSION } = tuiUsageMod;

    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, assistantCommandStats: undefined },
    });
    const host = { dshHome: dir };

    for (let i = 0; i < PROMOTION_THRESHOLD; i += 1) {
      recordAssistantCommandUsage({ host, page: 'review', text: '查看统计', kind: 'command' });
    }

    // Wait deterministically ([C36]) until the last queued write reaches disk with count >= PROMOTION_THRESHOLD
    const uPath = tuiUsagePath({ env: { DSH_HOME: dir } });
    const usageRaw = await waitForCondition(async () => {
      const raw = await readIfExists(uPath);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed?.assistantChipStats?.review?.['chip:stats']?.count >= PROMOTION_THRESHOLD ? raw : null;
      } catch {
        return null;
      }
    });

    // tui.json must remain untouched
    const prefsRaw = await readIfExists(tuiPreferencesPath({ env: { DSH_HOME: dir } }));
    assert.equal(prefsRaw, null, 'assistant chip usage must live in tui-usage.json, never tui.json');

    // tui-usage.json must exist and contain ONLY canonical chip ID ('chip:stats'), never raw Chinese command text
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
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

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
            'chip:unregistered-secret-slug': { count: 5, lastUsedAt: 1700000001500 },
            'chip:stats': { count: 3, lastUsedAt: 1700000002000 },
          },
        },
      },
      { env: { DSH_HOME: dir } },
    );

    const diskRaw = await readFile(tuiPreferencesPath({ env: { DSH_HOME: dir } }), 'utf8');
    assert.ok(!diskRaw.includes('不应落盘的题干文本'), 'tui.json must never store promptPreview');
    assert.ok(!diskRaw.includes('用户手打的自由文本秘密'), 'tui.json must never store free-text user input');
    assert.ok(!diskRaw.includes('chip:unregistered-secret-slug'), 'tui.json must reject unregistered chip:* tokens');

    const loaded = await loadTuiPreferences({ env: { DSH_HOME: dir } });
    assert.equal(loaded.theme, 'nord');
    assert.equal(loaded.lastPracticeContext?.runId, 'run-42');
    assert.equal(loaded.lastPracticeContext?.promptPreview, undefined);
    assert.equal(loaded.assistantCommandStats?.review?.['用户手打的自由文本秘密'], undefined);
    assert.equal(loaded.assistantCommandStats?.review?.['chip:unregistered-secret-slug'], undefined);
  });

  test('cross-session chip promotion aggregates ID+command counts, keeps English labels & guided kind, and respects card context', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-cross-session-'));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

    const tuiUsageMod = await import('../src/host/tui-usage.ts');
    const { loadTuiUsage, saveTuiUsage } = tuiUsageMod;
    const host = { dshHome: dir };

    // Session 1: 2 uses persisted as canonical chip ID (below threshold 3)
    await saveTuiUsage(
      { assistantChipStats: { review: { 'chip:stats': { count: PROMOTION_THRESHOLD - 1, lastUsedAt: 1000 } } } },
      { env: { DSH_HOME: dir } },
    );

    // Session 2 boot: hydrate store from tui-usage.json, then run the command 1 more time (total = 3)
    const bootedUsage = await loadTuiUsage({ env: { DSH_HOME: dir } });
    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, assistantCommandStats: bootedUsage.assistantChipStats },
    });
    const afterThird = recordAssistantCommandUsage({ host, page: 'review', text: '查看统计', kind: 'command' });

    const chipsEnThird = buildContextChips({
      page: 'review',
      card: { cardId: 'c1', isWrong: false },
      practiceStack: [],
      statsByPage: afterThird,
      lang: 'en',
    });
    assert.equal(chipsEnThird[0].id, 'chip:stats', '2 persisted + 1 in-session use must reach promotion threshold');
    assert.equal(chipsEnThird[0].promoted, true);
    assert.equal(chipsEnThird[0].label, 'Today stats', 'promoted chip must keep localized English label');

    // Repeating 3+ more times in Session 2 must NOT shadow the catalog chip with raw Chinese text or downgrade kind
    let stats = afterThird;
    for (let i = 0; i < PROMOTION_THRESHOLD; i += 1) {
      stats = recordAssistantCommandUsage({ host, page: 'review', text: '进入带学', kind: 'command' });
    }

    const normalCardChips = buildContextChips({
      page: 'review',
      card: { cardId: 'c2', isWrong: false },
      practiceStack: [],
      statsByPage: stats,
      lang: 'en',
    });
    assert.equal(normalCardChips[0].id, 'chip:guided-help', 'normal card must promote chip:guided-help, never wrongCardOnly chip:guided-retell');
    assert.equal(normalCardChips[0].kind, 'guided', 'promoted guided chip must preserve kind=guided');
    assert.equal(normalCardChips[0].label, 'Guided hint', 'promoted guided chip must stay localized in English');
    assert.equal(normalCardChips[0].promoted, true);

    const wrongCardChips = buildContextChips({
      page: 'review',
      card: { cardId: 'c3', isWrong: true },
      practiceStack: [],
      statsByPage: stats,
      lang: 'en',
    });
    assert.equal(wrongCardChips[0].id, 'chip:guided-retell', 'wrong card must promote chip:guided-retell');
    assert.equal(wrongCardChips[0].kind, 'guided');
    assert.equal(wrongCardChips[0].label, 'Guided & Retell');
    assert.equal(wrongCardChips[0].promoted, true);

    // Wait for the last fire-and-forget usage write (they are queued in order) before tempdir cleanup
    await waitForCondition(async () => {
      const u = await loadTuiUsage({ env: { DSH_HOME: dir } });
      return (u.assistantChipStats?.review?.['chip:stats']?.count ?? 0) >= PROMOTION_THRESHOLD
        && (u.assistantChipStats?.review?.[resolveAssistantChipId('进入带学', 'review')]?.count ?? 0) >= PROMOTION_THRESHOLD;
    });
  });

  test('tui-usage.json handles malformed incoming stats, merges raw aliases canonically, and aborts recovery if backup fails', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-usage-robust-'));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

    const tuiUsageMod = await import('../src/host/tui-usage.ts');
    const { loadTuiUsageSafe, saveTuiUsage } = tuiUsageMod;
    const usageFile = path.join(dir, 'tui-usage.json');

    // 1) Seed valid usage, then pass malformed nested stats + raw command alias
    await saveTuiUsage(
      { assistantChipStats: { review: { 'chip:stats': { count: 3, lastUsedAt: 100 } } } },
      { filePath: usageFile },
    );
    await saveTuiUsage(
      {
        assistantChipStats: {
          review: { '查看统计': { count: 1, lastUsedAt: 200 } },
          // Malformed runtime entry must not throw TypeError
          broken: null,
        },
      },
      { filePath: usageFile },
    );
    const merged = await loadTuiUsageSafe({ filePath: usageFile });
    assert.equal(merged.status, 'ok');
    assert.equal(merged.usage.assistantChipStats?.review?.['chip:stats']?.count, 3, 'raw alias merge must use max(3, 1) = 3, not sum to 4');
    assert.equal(merged.usage.assistantChipStats?.review?.['chip:stats']?.lastUsedAt, 200);

    // 2) Backup failure during corrupt recovery must abort and leave original corrupt bytes untouched
    const corruptBytes = '{"version":1,"assistantChipStats": CORRUPT_DO_NOT_LOSE';
    await writeFile(usageFile, corruptBytes, 'utf8');
    await assert.rejects(
      saveTuiUsage(
        { assistantChipStats: { review: { 'chip:stats': { count: 1, lastUsedAt: 300 } } } },
        {
          filePath: usageFile,
          fsOps: {
            writeAndSync: async () => {
              throw Object.assign(new Error('Simulated disk full during backup'), { code: 'ENOSPC' });
            },
          },
        },
      ),
      /ENOSPC|disk full/i,
    );
    assert.equal(await readFile(usageFile, 'utf8'), corruptBytes, 'original corrupt tui-usage.json must stay intact when backup fails');
  });

  test('tui-usage.json protects against corrupt JSON, unreadable path, UTF-8 BOM, and future schema versions [C38]', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-usage-guards-'));
    t.after(async () => {
      await chmod(path.join(dir, 'unreadable.json'), 0o600).catch(() => {});
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    const tuiUsageMod = await import('../src/host/tui-usage.ts');
    const { loadTuiUsageSafe, saveTuiUsage } = tuiUsageMod;

    // 1) Corrupt JSON: the save backs the file up first, then starts afresh (usage counters only, like lib/jev-usage.js)
    const corruptPath = path.join(dir, 'corrupt.json');
    const corruptBytes = '{"version":1,"assistantChipStats": BROKEN';
    await writeFile(corruptPath, corruptBytes, 'utf8');

    const loadedCorrupt = await loadTuiUsageSafe({ filePath: corruptPath });
    assert.equal(loadedCorrupt.status, 'corrupt');

    await saveTuiUsage({ assistantChipStats: { review: { 'chip:stats': { count: 2, lastUsedAt: 200 } } } }, { filePath: corruptPath });
    const files = await readdir(dir);
    const baks = files.filter((f) => f.startsWith('corrupt.json.corrupt-') && f.endsWith('.bak'));
    assert.equal(baks.length, 1, `expected one backup file before recovery, got: ${files.join(', ')}`);
    assert.equal(await readFile(path.join(dir, baks[0]), 'utf8'), corruptBytes);
    const recovered = await loadTuiUsageSafe({ filePath: corruptPath });
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.usage.assistantChipStats?.review?.['chip:stats']?.count, 2, 'a damaged usage file must not stop chip usage from being recorded');

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

    // 3) Future/invalid schema version [C38]: never overwritten, bytes untouched
    for (const badVer of [2, '2', 0, null]) {
      const futurePath = path.join(dir, `future-${String(badVer)}.json`);
      const futureBytes = JSON.stringify({ version: badVer, assistantChipStats: { review: { 'chip:stats': { count: 9, lastUsedAt: 9 } } }, extraFutureField: true });
      await writeFile(futurePath, futureBytes, 'utf8');

      const res = await loadTuiUsageSafe({ filePath: futurePath });
      assert.equal(res.status, 'unsupported-version', `version=${JSON.stringify(badVer)} must be unsupported-version`);

      await saveTuiUsage({ assistantChipStats: { review: { 'chip:stats': { count: 1, lastUsedAt: 1 } } } }, { filePath: futurePath });
      assert.equal(await readFile(futurePath, 'utf8'), futureBytes, 'a save must not overwrite a future version');
      assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith(`future-${String(badVer)}.json.corrupt-`)), [], 'a future version is not damaged: no backup');
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

  test('extractPersistableChipStats keeps only registered chip ids: free text never reaches disk', () => {
    const typed = '帮我整理昨晚私人日记里的敏感思考内容 XYZ-987654';
    const out = extractPersistableChipStats({
      review: {
        [typed]: { count: 7, lastUsedAt: 700 },
        '查看统计': { count: 2, lastUsedAt: 200 },
      },
      library: { 'my private free-text question 42': { count: 5, lastUsedAt: 500 } },
    });
    assert.deepEqual(out, { review: { 'chip:stats': { count: 2, lastUsedAt: 200 } } }, 'only the registered command survives, under its chip id');
    assert.ok(!JSON.stringify(out).includes(typed));
    assert.equal(extractPersistableChipStats({ library: { 'my private free-text question 42': { count: 5, lastUsedAt: 500 } } }), undefined);
  });
});
