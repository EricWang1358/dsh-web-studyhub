/* global localStorage, document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../lib/store.js';
import { StudyService } from '../lib/service.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import {
  RESTORE_POINT_RETENTION,
  selectRetainedRestorePoints,
  shardNamesOfManifest,
} from '../lib/contexts/library/restore-points.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

const require = createRequire(import.meta.url);
const uiCompiled = await build({
  stdin: {
    contents: `
      export { BackupSection, formatRestorePointDate } from './ui/settings/BackupSection.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text', '.jsx': 'jsx' },
  logLevel: 'silent',
});
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', uiCompiled.outputFiles[0].text)(require, uiMod, uiMod.exports);
const { BackupSection, formatRestorePointDate, StudyServicesContext, setUiLanguage } = uiMod.exports;

const h = React.createElement;
const HAN_RE = /[\u3400-\u9fff]/;

const makeTempRoot = async (t, prefix = 'study-restore-points-') => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  return dir;
};

const shardFiles = async (root) => {
  const out = [];
  for (const dir of await readdir(join(root, 'shards')).catch(() => [])) {
    for (const name of await readdir(join(root, 'shards', dir)).catch(() => [])) {
      out.push(`${dir}/${name}`);
    }
  }
  return out.sort();
};

const cardOf = (id, text = 'Prompt') => ({
  id,
  kind: 'quiz',
  topic: 'Topic',
  objective: `Objective ${id}`,
  prompt: `${text} ${id}?`,
  answer: 'A',
  hint: '',
  explanation: 'Because A.',
  misconception: 'Not B.',
  citations: [],
  options: [
    { id: 'a', text: 'A', correct: true, explanation: 'Right' },
    { id: 'b', text: 'B', correct: false, explanation: 'Wrong' },
  ],
});

const deckOf = (id, title, cardCount = 2) => ({
  id,
  title,
  cards: Array.from({ length: cardCount }, (_, idx) => cardOf(`${id}-c${idx}`, title)),
});

const localNoonMs = (year, month, day) => new Date(year, month - 1, day, 12, 0, 0, 0).getTime();

test('#892: 35+ consecutive days keep exactly 7 daily + 4 weekly restore points, protect their shards from GC, release older shards, and never delete backups/', async (t) => {
  const root = await makeTempRoot(t, 'study-rp-35days-');
  let clockMs = localNoonMs(2026, 9, 1); // 2026-09-01 local noon
  const store = new Store(root, { now: () => clockMs });

  // Seed a manual/user backup file in backups/ that must NEVER be auto-deleted.
  const userBackupDir = join(root, 'backups');
  await mkdir(userBackupDir, { recursive: true });
  const manualBackupPath = join(userBackupDir, 'user-manual-export-keep-forever.json');
  await writeFile(manualBackupPath, '{"manual":true}\n', 'utf8');

  // Simulate 36 consecutive days of activity (producing 35 historical days of snapshots).
  // On each day `d`, write a day-specific ephemeral deck `ephemeral-d` (replaced the next day)
  // plus a shared source `shared-src` that never changes across all 36 days.
  for (let dayOffset = 0; dayOffset < 36; dayOffset++) {
    clockMs = localNoonMs(2026, 9, 1 + dayOffset);
    await store.update((state) => {
      if (dayOffset === 0) {
        state.sources.push({ id: 'shared-src', title: 'Immutable Lecture', text: 'Content-addressed text '.repeat(80) });
      }
      state.decks = [deckOf('rolling', `Day ${dayOffset} version`, 2)];
      state.attempts.push({ id: `att-${dayOffset}`, grade: 4 });
    });
  }

  const listing = await store.listRestorePoints();
  assert.deepEqual(listing.retention, { daily: 7, weekly: 4 });
  assert.deepEqual(RESTORE_POINT_RETENTION, { daily: 7, weekly: 4 });

  const dailyPoints = listing.points.filter((p) => p.tier === 'daily');
  const weeklyPoints = listing.points.filter((p) => p.tier === 'weekly');
  assert.equal(dailyPoints.length, 7, 'exactly 7 daily restore points');
  assert.equal(weeklyPoints.length, 4, 'exactly 4 weekly restore points');
  assert.equal(listing.points.length, 11, '11 restore points total');

  // Files on disk in restore-points/ match the 11 kept points (pruned days removed).
  const filesOnDisk = (await readdir(join(root, 'restore-points'))).sort();
  assert.equal(filesOnDisk.length, 11);
  assert.deepEqual(filesOnDisk, listing.points.map((p) => `${p.id}.json`).sort());

  // Every shard referenced by any of the 11 kept restore points + live manifest exists on disk,
  // while unreferenced shards from pruned earlier days have been garbage-collected!
  const allDiskShards = new Set(await shardFiles(root));
  const liveManifest = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  const expectedLiveOrProtected = new Set(shardNamesOfManifest(liveManifest));
  for (const fileName of filesOnDisk) {
    const pointRaw = JSON.parse(await readFile(join(root, 'restore-points', fileName), 'utf8'));
    for (const shard of shardNamesOfManifest(pointRaw.manifest)) {
      assert.ok(allDiskShards.has(shard), `kept restore point ${fileName} shard ${shard} is protected from GC`);
      expectedLiveOrProtected.add(shard);
    }
  }
  // Rolling deck was rewritten 36 times (36 distinct hashes), but only 1 live + 11 kept = 12 deck shards remain!
  const deckShardsOnDisk = [...allDiskShards].filter((s) => s.startsWith('decks/rolling.'));
  assert.equal(deckShardsOnDisk.length, 12, '24 expired daily deck shards were released and collected by GC');
  assert.deepEqual([...allDiskShards].sort(), [...expectedLiveOrProtected].sort());

  // Unchanged source shard was stored ONCE (zero duplication across 11 restore points + live manifest).
  const sourceShardsOnDisk = [...allDiskShards].filter((s) => s.startsWith('sources/shared-src.'));
  assert.equal(sourceShardsOnDisk.length, 1, 'unchanged source shard is stored once, zero duplication');

  // User/upgrade backups in backups/ were NEVER touched.
  const backupsRemaining = await readdir(userBackupDir);
  assert.ok(backupsRemaining.includes('user-manual-export-keep-forever.json'));
});

test('#892: selectRetainedRestorePoints enforces 7 daily + 4 weekly boundary caps, custom overrides, and invalid-input fallbacks', () => {
  // 1) 8 consecutive days -> 7 daily + 1 weekly (catches +-1 drift on daily cap).
  const eightDays = [
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
  ];
  const eightRes = selectRetainedRestorePoints(eightDays);
  assert.deepEqual(
    eightRes.kept.filter((p) => p.tier === 'daily').map((p) => p.id),
    ['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02'],
  );
  assert.deepEqual(
    eightRes.kept.filter((p) => p.tier === 'weekly').map((p) => p.id),
    ['2026-10-01'],
  );
  assert.deepEqual(eightRes.pruned, []);

  // 2) 7 newest days + 6 older calendar weeks -> 7 daily + 4 weekly + 2 pruned (catches +-1 drift on weekly cap).
  const newestSeven = [
    '2026-11-16', '2026-11-15', '2026-11-14', '2026-11-13',
    '2026-11-12', '2026-11-11', '2026-11-10',
  ];
  const sixOlderWeeks = [
    '2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12',
    '2026-10-05', '2026-09-28',
  ];
  const boundaryRes = selectRetainedRestorePoints([...newestSeven, ...sixOlderWeeks]);
  assert.deepEqual(
    boundaryRes.kept.filter((p) => p.tier === 'daily').map((p) => p.id),
    newestSeven,
  );
  assert.deepEqual(
    boundaryRes.kept.filter((p) => p.tier === 'weekly').map((p) => p.id),
    ['2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12'],
  );
  assert.deepEqual(boundaryRes.pruned, ['2026-10-05', '2026-09-28']);

  // Same-week deduplication among older points keeps the newest date per calendar week.
  const sameWeekRes = selectRetainedRestorePoints([...newestSeven, '2026-11-03', '2026-11-02']);
  assert.deepEqual(
    sameWeekRes.kept.filter((p) => p.tier === 'weekly').map((p) => p.id),
    ['2026-11-03'],
  );
  assert.deepEqual(sameWeekRes.pruned, ['2026-11-02']);

  // 3) Custom { daily: 2, weekly: 1 } override.
  const customRes = selectRetainedRestorePoints(['2026-11-16', '2026-11-15', '2026-11-02', '2026-10-26'], { daily: 2, weekly: 1 });
  assert.deepEqual(customRes.kept, [
    { id: '2026-11-16', date: '2026-11-16', tier: 'daily' },
    { id: '2026-11-15', date: '2026-11-15', tier: 'daily' },
    { id: '2026-11-02', date: '2026-11-02', tier: 'weekly' },
  ]);
  assert.deepEqual(customRes.pruned, ['2026-10-26']);

  // 4) Invalid retention { daily: -1, weekly: 1.5 } falls back to default 7 daily / 4 weekly.
  const fallbackRes = selectRetainedRestorePoints([...newestSeven, ...sixOlderWeeks], { daily: -1, weekly: 1.5 });
  assert.equal(fallbackRes.kept.filter((p) => p.tier === 'daily').length, 7);
  assert.equal(fallbackRes.kept.filter((p) => p.tier === 'weekly').length, 4);
  assert.deepEqual(fallbackRes.pruned, ['2026-10-05', '2026-09-28']);
});

test('#892: deleting a deck today and restoring to yesterday recovers all end-of-yesterday decks while saving a safety backup of current state', async (t) => {
  const root = await makeTempRoot(t, 'study-rp-restore-');
  let clockMs = localNoonMs(2026, 11, 16); // Yesterday: 2026-11-16
  const store = new Store(root, { now: () => clockMs });
  const service = new StudyService(root, { storage: store });
  t.after(() => service.dispose());

  // Yesterday morning (commit 1): create course & source & first deck.
  await service.call('source.add', { id: 'lec-1', title: 'Lecture 1', text: 'Distributed consensus notes.', courses: ['Systems'] });
  await store.update((state) => {
    state.decks.push(deckOf('deck-keep', 'Consensus Basics', 2));
  });
  // Yesterday evening (commit 2): add second deck & practice attempts (must be captured in yesterday's point!).
  await store.update((state) => {
    state.decks.push(deckOf('deck-precious', 'Raft Deep Dive', 3));
    state.attempts.push({ id: 'a-1', grade: 3 }, { id: 'a-2', grade: 4 });
  });

  // Today (2026-11-17): learner accidentally archives & permanently deletes `deck-precious` today!
  clockMs = localNoonMs(2026, 11, 17);
  await service.call('deck.archive', { id: 'deck-precious', archived: true });
  await service.call('deck.remove', { id: 'deck-precious', confirm: true });

  const afterDelete = await service.call('snapshot');
  assert.deepEqual(afterDelete.decks.map((d) => d.id), ['deck-keep']);

  // `library.restorePoints.list` shows yesterday's point (`2026-11-16`) with both decks & 5 cards!
  const list = await service.call('library.restorePoints.list');
  assert.equal(list.points.length, 1);
  const yesterday = list.points[0];
  assert.equal(yesterday.id, '2026-11-16');
  assert.equal(yesterday.tier, 'daily');
  assert.equal(yesterday.summary.decks, 2);
  assert.equal(yesterday.summary.cards, 5);
  assert.equal(yesterday.summary.attempts, 2);
  assert.ok(yesterday.extraBytes > 0, 'reports extra bytes held by the deleted deck shard + manifest');

  // Restore to yesterday (`2026-11-16`).
  const restored = await service.call('library.restorePoints.restore', { id: '2026-11-16' });
  assert.equal(restored.id, '2026-11-16');
  assert.equal(restored.decks, 2);
  assert.ok(restored.backupPath.includes('study-workspace-before-restore-'));

  // Safety backup holds the pre-restore state (1 deck: `deck-keep`) so the learner can change their mind again!
  const safetyCopy = JSON.parse(await readFile(restored.backupPath, 'utf8'));
  assert.deepEqual(safetyCopy.decks.map((d) => d.id), ['deck-keep']);

  // Both hot snapshot cache and a cold Store instance immediately see `deck-precious` restored!
  const afterRestoreSnap = await service.call('snapshot');
  assert.deepEqual(afterRestoreSnap.decks.map((d) => d.id).sort(), ['deck-keep', 'deck-precious']);
  const coldRead = await new Store(root).read();
  assert.deepEqual(coldRead.decks.map((d) => d.id).sort(), ['deck-keep', 'deck-precious']);

  // And restoring the safety copy via `restore` reverses the restore cleanly!
  await service.call('restore', { state: safetyCopy });
  assert.deepEqual((await service.call('snapshot')).decks.map((d) => d.id), ['deck-keep']);
});

test('#892: library.restorePoints.restore refuses active jobs, invalid IDs, and missing/corrupt shards without touching the live library', async (t) => {
  const root = await makeTempRoot(t, 'study-rp-safety-');
  let clockMs = localNoonMs(2026, 11, 15);
  const store = new Store(root, { now: () => clockMs });
  const service = new StudyService(root, { storage: store });
  t.after(() => service.dispose());

  await store.update((state) => {
    state.decks.push(deckOf('d1', 'Day 1 Deck', 2));
  });
  clockMs = localNoonMs(2026, 11, 16);
  await store.update((state) => {
    state.decks = [deckOf('d2', 'Day 2 Live Deck', 1)];
  });

  // 1. Refuse invalid / path-traversal IDs and missing dates.
  await assert.rejects(() => service.call('library.restorePoints.restore', { id: '../study-workspace' }), /无效的恢复点日期/);
  await assert.rejects(() => service.call('library.restorePoints.restore', { id: '2099-01-01' }), /已经不在了/);

  // 2. Refuse when a background job is running on this library.
  service.runtime.work.jobs.set('job-active-1', { id: 'job-active-1', root, type: 'generation', status: 'running' });
  try {
    await assert.rejects(
      () => service.call('library.restorePoints.restore', { id: '2026-11-15' }),
      /请先完成或取消当前学习库的出题任务/,
    );
  } finally {
    service.runtime.work.jobs.delete('job-active-1');
  }

  // 3. Assistant tool boundary refuses restorePoints operations (learner-only Settings action).
  assert.match(assistantRefusal('library.restorePoints.restore') || '', /not available to the assistant/);
  assert.match(assistantRefusal('library.restorePoints.list') || '', /not available to the assistant/);

  // 4. Refuse when a referenced shard of the restore point is missing on disk; leave live library & backups/ untouched.
  const pointRaw = JSON.parse(await readFile(join(root, 'restore-points', '2026-11-15.json'), 'utf8'));
  const oldDeckShard = pointRaw.manifest.shards.decks[0];
  await rm(join(root, 'shards', oldDeckShard), { force: true });

  const liveBefore = await readFile(join(root, 'study-workspace.json'), 'utf8');
  await assert.rejects(
    () => service.call('library.restorePoints.restore', { id: '2026-11-15' }),
    (err) => err.code === 'restore-point-corrupt' && /缺少分片文件/.test(err.message),
  );
  assert.equal(await readFile(join(root, 'study-workspace.json'), 'utf8'), liveBefore, 'live manifest untouched');
  const backups = await readdir(join(root, 'backups')).catch(() => []);
  assert.equal(backups.length, 0, 'no partial safety backup written when shard preflight fails');
});

test('#892: BackupSection renders restore points in Chinese & English (zero Han chars in English) with 2-step InlineConfirm', () => {
  const samplePoints = {
    retention: { daily: 7, weekly: 4 },
    totalExtraBytes: 49152,
    points: [
      {
        id: '2026-11-16',
        date: '2026-11-16',
        tier: 'daily',
        extraBytes: 16384,
        summary: { revision: 18, courses: 2, sources: 5, decks: 3, cards: 42, attempts: 120 },
      },
      {
        id: '2026-11-01',
        date: '2026-11-01',
        tier: 'weekly',
        extraBytes: 32768,
        summary: { revision: 9, courses: 1, sources: 3, decks: 2, cards: 25, attempts: 60 },
      },
    ],
  };
  const refNow = new Date(2026, 10, 17, 12, 0, 0); // 2026-11-17

  setUiLanguage('zh');
  assert.equal(formatRestorePointDate('2026-11-16', refNow), '昨天 · 2026-11-16');
  assert.equal(formatRestorePointDate('2026-11-15', refNow), '前天 · 2026-11-15');
  const zhHtml = renderToStaticMarkup(
    h(StudyServicesContext.Provider, { value: { busy: false, act: async () => {}, call: async () => samplePoints } },
      h(BackupSection, { root: 'D:\\Study\\lib', exportData() {}, onRestored() {}, initialRestorePoints: samplePoints, now: refNow })),
  );
  assert.match(zhHtml, /自动恢复点/);
  assert.match(zhHtml, /昨天 · 2026-11-16/);
  assert.match(zhHtml, /周恢复点/);
  assert.match(zhHtml, /保存次数 18 · 2 门课程 · 5 份资料 · 3 个题组（42 道题） · 120 条作答记录/);
  assert.match(zhHtml, /额外 16 KB/);
  assert.match(zhHtml, /共额外占用 48 KB/);
  assert.match(zhHtml, /恢复到这一天/);

  setUiLanguage('en');
  try {
    assert.equal(formatRestorePointDate('2026-11-16', refNow), 'Yesterday · 2026-11-16');
    assert.equal(formatRestorePointDate('2026-11-15', refNow), '2 days ago · 2026-11-15');
    const enPopulated = renderToStaticMarkup(
      h(StudyServicesContext.Provider, { value: { busy: false, act: async () => {}, call: async () => samplePoints } },
        h(BackupSection, { root: 'D:\\Study\\lib', exportData() {}, onRestored() {}, initialRestorePoints: samplePoints, now: refNow })),
    );
    const enEmpty = renderToStaticMarkup(
      h(StudyServicesContext.Provider, { value: { busy: false, act: async () => {}, call: async () => ({ retention: { daily: 7, weekly: 4 }, totalExtraBytes: 0, points: [] }) } },
        h(BackupSection, { root: 'D:\\Study\\lib', exportData() {}, onRestored() {}, now: refNow })),
    );
    assert.doesNotMatch(enPopulated.replace(/<[^>]*>/g, ' '), HAN_RE, 'zero Han characters in English populated BackupSection');
    assert.doesNotMatch(enEmpty.replace(/<[^>]*>/g, ' '), HAN_RE, 'zero Han characters in English empty BackupSection');
    assert.match(enPopulated, /Automatic restore points/);
    assert.match(enPopulated, /Yesterday · 2026-11-16/);
    assert.match(enPopulated, /Weekly/);
    assert.match(enPopulated, /Restore to this day/);
  } finally {
    setUiLanguage('zh');
  }
});

let browser, browserUnavailable = false;
try {
  browser = await launchChromium();
} catch (error) {
  if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error;
  browserUnavailable = true;
}
test.after(() => browser?.close());

test('#892: BackupSection Playwright layout & 2-step InlineConfirm restore at 1280x800 dark and 390x844 light', { skip: browserUnavailable, timeout: 180000 }, async (t) => {
  const root = await makeTempRoot(t, 'study-rp-pw-');
  const libRoot = join(root, 'library');
  const now = new Date();
  const yesterdayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 0, 0).getTime();
  const eightDaysAgoMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 8, 14, 0, 0).getTime();
  let clockMs = eightDaysAgoMs;

  const store = new Store(libRoot, { now: () => clockMs });
  const service = new StudyService(libRoot, { storage: store });

  await service.call('source.add', { id: 's-1', title: 'Week Ago Notes', text: 'Early lecture content '.repeat(30), courses: ['Algorithms'] });
  await store.update((s) => { s.decks.push(deckOf('d-week', 'Graph Basics', 2)); });

  clockMs = yesterdayMs;
  await store.update((s) => {
    s.decks.push(deckOf('d-yesterday', 'Dynamic Programming', 3));
    s.attempts.push({ id: 'att-y1', grade: 4 });
  });

  // Today: remove `d-yesterday` so restoring yesterday brings it back!
  clockMs = now.getTime();
  await service.call('deck.archive', { id: 'd-yesterday', archived: true });
  await service.call('deck.remove', { id: 'd-yesterday', confirm: true });
  await service.dispose();

  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({
    libraryRoot: libRoot,
    home: join(root, 'home'),
    port: 0,
    model: createFakeModel({ latencyMs: 5, usage: true }),
    distDir,
  });
  t.after(async () => { await server.close(); });

  for (const spec of [
    { width: 1280, height: 800, theme: 'dark', lang: 'en' },
    { width: 390, height: 844, theme: 'light', lang: 'zh' },
  ]) {
    const context = await browser.newContext({
      viewport: { width: spec.width, height: spec.height },
      colorScheme: spec.theme,
      locale: spec.lang === 'en' ? 'en-US' : 'zh-CN',
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.addInitScript(({ theme, lang }) => {
      localStorage.setItem('study-appearance', JSON.stringify({ theme }));
      localStorage.setItem('study-ui-language', lang);
      localStorage.setItem('study-autopilot', 'off');
    }, spec);

    await page.goto(server.url);
    await page.locator('.study-app').first().waitFor({ timeout: 30000 });

    // Open Settings -> Data / Backup category.
    const navMenu = page.locator('[data-tour="nav-menu"]').first();
    if (await navMenu.isVisible().catch(() => false)) {
      await navMenu.click();
    }
    const settingsBtn = page.locator('[data-tour="nav-settings"]').first();
    await settingsBtn.waitFor({ timeout: 20000 });
    await settingsBtn.click();

    const dataTab = page.locator('.settings-nav__item', { hasText: spec.lang === 'en' ? /Import|Backup|Data/i : /导入、计划与备份/ }).first();
    await dataTab.waitFor({ timeout: 20000 });
    await dataTab.click();

    const block = page.locator('.restore-points-block');
    await block.waitFor({ timeout: 20000 });
    await page.locator('.restore-point-row').first().waitFor({ timeout: 20000 });
    await block.scrollIntoViewIfNeeded();

    const metrics = await page.evaluate(() => {
      const el = document.querySelector('.restore-points-block');
      const rect = el.getBoundingClientRect();
      return {
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        blockRight: rect.right,
        blockLeft: rect.left,
        viewportWidth: window.innerWidth,
        text: el.innerText,
      };
    });
    assert.ok(metrics.docOverflow <= 1, `${spec.width}x${spec.height} ${spec.theme}: zero horizontal overflow (${metrics.docOverflow})`);
    assert.ok(metrics.blockLeft >= 0 && metrics.blockRight <= spec.width + 1, `${spec.width}x${spec.height}: restore-points block fits inside viewport`);

    if (spec.lang === 'en') {
      assert.doesNotMatch(metrics.text, HAN_RE, 'zero Han chars in rendered English BackupSection');
      assert.match(metrics.text, /Yesterday · \d{4}-\d{2}-\d{2}/);
      // Open InlineConfirm in English and cancel cleanly so the zh pass can execute the actual restore!
      await page.locator('.restore-point-row button', { hasText: 'Restore to this day' }).first().click();
      const confirmBox = page.locator('.restore-point-row__confirm');
      await confirmBox.waitFor({ timeout: 10000 });
      const confirmText = await confirmBox.innerText();
      assert.doesNotMatch(confirmText, HAN_RE);
      assert.match(confirmText, /Before restoring to this day, a full copy of your current library is saved/);
      await confirmBox.locator('button', { hasText: 'Cancel' }).click();
    } else {
      assert.match(metrics.text, /昨天 · \d{4}-\d{2}-\d{2}/);
      // Step 1 -> Step 2 InlineConfirm -> Confirm restore!
      await page.locator('.restore-point-row button', { hasText: '恢复到这一天' }).first().click();
      const confirmBox = page.locator('.restore-point-row__confirm');
      await confirmBox.waitFor({ timeout: 10000 });
      const confirmText = await confirmBox.innerText();
      assert.match(confirmText, /回到这一天前会自动保存当前状态副本/);
      const confirmOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(confirmOverflow <= 1, `390x844 InlineConfirm has zero horizontal overflow (${confirmOverflow})`);
      await confirmBox.locator('button', { hasText: '确认恢复到这一天' }).click();
      // Verify persistent toast appears in the real UI AND `Dynamic Programming` deck is restored on disk!
      await page.locator('text=/学习库已恢复/').first().waitFor({ timeout: 20000 });
      const restoredDisk = await new Store(libRoot).read();
      assert.ok(restoredDisk.decks.some((d) => d.id === 'd-yesterday' && !d.archived), 'd-yesterday restored unarchived on disk');
      const backupsWritten = await readdir(join(libRoot, 'backups'));
      assert.ok(backupsWritten.some((name) => name.startsWith('study-workspace-before-restore-')), 'pre-restore safety backup saved to backups/');
    }
    assert.deepEqual(pageErrors, [], `${spec.width}x${spec.height}: zero page errors`);
    await context.close();
  }
});
