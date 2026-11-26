// P2 (#1354 D5/D12): Committed Golden Layout Snapshots across the 5 Migrated Modules
// (Library, Review, Sources, DocumentReader, Tasks) at 120x36 and 80x24 inside real AppShell.
//
// Run (verify mode): node --test tests/golden-layout-snapshots.test.mjs
// Update snapshots:  UPDATE_SNAPSHOTS=1 node --test tests/golden-layout-snapshots.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { render } from 'ink';
import {
  assertZeroExternalNetwork,
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const UPDATE_MODE = process.env.UPDATE_SNAPSHOTS === '1' && !process.env.CI;

const EXPECTED_SNAPSHOTS = Object.freeze([
  'library-120x36',
  'library-80x24',
  'review-120x36',
  'review-80x24',
  'sources-120x36',
  'sources-80x24',
  'reader-120x36',
  'reader-80x24',
  'tasks-120x36',
  'tasks-80x24',
]);

const temps = createTempTracker('studyhub-golden-snap-');
after(async () => {
  await temps.cleanup();
  disposeTerminalPool();
});

function tokenDisplayWidth(str) {
  let width = 0;
  for (const ch of str) {
    width += /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return width;
}

const REL_TIME_LABEL = '<REL_TIME>';
const REL_TIME_TOKEN_SRC = '(?:刚刚|\\d+\\s*分钟前|\\d+\\s*小时前|今天|20\\d{2}-\\d{2}-\\d{2})';
const PANEL_SUBTITLE_TIME_RE = new RegExp(`(─+)(\\s+)(${REL_TIME_TOKEN_SRC})(\\s+─)`, 'g');
const BODY_LAST_STUDIED_RE = new RegExp(`(最近学习:\\s*)(${REL_TIME_TOKEN_SRC})(\\s*│)`, 'g');

/** Normalize volatile tokens (line endings, trailing spaces, dates, relative times, temp paths) while preserving exact border geometry. */
export function normalizeGoldenFrame(raw, { tempBase } = {}) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n');
  if (tempBase) {
    const escaped = tempBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), '<TMP>');
  }
  // Normalize relative timestamps in panel headers and detail rows while keeping box borders flush.
  text = text.replace(PANEL_SUBTITLE_TIME_RE, (_m, dashes, spBefore, token, spAfter) => {
    const delta = tokenDisplayWidth(REL_TIME_LABEL) - tokenDisplayWidth(token);
    const nextDashCount = Math.max(1, dashes.length - delta);
    return `${'─'.repeat(nextDashCount)}${spBefore}${REL_TIME_LABEL}${spAfter}`;
  });
  text = text.replace(BODY_LAST_STUDIED_RE, (_m, prefix, token, suffix) => {
    const trailingSpaces = suffix.slice(0, -1);
    const delta = tokenDisplayWidth(REL_TIME_LABEL) - tokenDisplayWidth(token);
    const nextSpaces = Math.max(1, trailingSpaces.length - delta);
    return `${prefix}${REL_TIME_LABEL}${' '.repeat(nextSpaces)}│`;
  });
  // Normalize any remaining volatile dates and clock times.
  text = text
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, '<DATE>')
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<TIME>');
  const lines = text.split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

function isFrameSettled(screen, cols, rows, extraCheck) {
  const lines = screen.split('\n');
  if (lines.length !== rows) return false;
  if (!lines[0]?.includes('▙▟ StudyHub')) return false;
  if (cols >= 100 && !screen.includes('每日 Daily')) return false;
  if (cols < 100 && screen.includes('每日 Daily')) return false;
  return extraCheck(screen, lines);
}

function formatLineDiff(expected, actual, name) {
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const maxLen = Math.max(expLines.length, actLines.length);
  const diffs = [];
  for (let i = 0; i < maxLen; i += 1) {
    const e = expLines[i];
    const a = actLines[i];
    if (e !== a) {
      diffs.push(`  L${String(i + 1).padStart(2, '0')} - ${JSON.stringify(e ?? '<EOF>')}`);
      diffs.push(`  L${String(i + 1).padStart(2, '0')} + ${JSON.stringify(a ?? '<EOF>')}`);
    }
    if (diffs.length >= 24) {
      diffs.push('  ... (diff truncated)');
      break;
    }
  }
  return [
    `Golden layout snapshot mismatch for "${name}" (${path.join('tests/snapshots', `${name}.snap`)}).`,
    'If this layout change is intentional, regenerate with:',
    '  UPDATE_SNAPSHOTS=1 node --test packages/studyhub-tui/tests/golden-layout-snapshots.test.mjs',
    'Diff:',
    ...diffs,
  ].join('\n');
}

function assertMatchesGoldenSnapshot(name, normalizedFrame) {
  const filePath = path.join(SNAPSHOT_DIR, `${name}.snap`);
  if (UPDATE_MODE) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(filePath, normalizedFrame, 'utf8');
    return;
  }
  assert.ok(
    fs.existsSync(filePath),
    `Missing golden snapshot "${name}" at ${filePath}. Generate with UPDATE_SNAPSHOTS=1.`,
  );
  const expected = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  if (expected !== normalizedFrame) {
    assert.fail(formatLineDiff(expected, normalizedFrame, name));
  }
}

describe('P2 (#1354 D5/D12): Golden Layout Snapshots (5 Migrated Views x 120x36 & 80x24)', () => {
  test('1. Snapshot manifest: all 10 golden .snap files exist on disk (5 views x 2 sizes), CI refuses update mode, and normalizer preserves border width across clock drift', () => {
    if (process.env.CI) {
      assert.equal(UPDATE_MODE, false, 'CI must never silently rewrite golden snapshots');
    }
    if (!UPDATE_MODE) {
      for (const name of EXPECTED_SNAPSHOTS) {
        const snapPath = path.join(SNAPSHOT_DIR, `${name}.snap`);
        assert.ok(fs.existsSync(snapPath), `Committed golden snapshot missing: tests/snapshots/${name}.snap`);
      }
    }
    const justNow = normalizeGoldenFrame(
      '╭─ ▤ 示例 ────────────── 刚刚 ─╮\n│ 最近学习: 刚刚           │\n',
    );
    const minsAgo = normalizeGoldenFrame(
      '╭─ ▤ 示例 ───────── 12 分钟前 ─╮\n│ 最近学习: 12 分钟前      │\n',
    );
    const isoDate = normalizeGoldenFrame(
      '╭─ ▤ 示例 ──────── 2026-11-26 ─╮\n│ 最近学习: 2026-11-26     │\n',
    );
    assert.equal(minsAgo, justNow, 'Normalizer must produce identical frame for 刚刚 vs 12 分钟前');
    assert.equal(isoDate, justNow, 'Normalizer must produce identical frame for 刚刚 vs YYYY-MM-DD');
  });

  test('2. Real AppShell @xterm/headless golden snapshots match across Library, Review, Sources, DocumentReader & Tasks (0 model calls, 0 external network)', async () => {
    await assertZeroExternalNetwork(async () => {
    const base = await temps.make('golden-5views');
    const dshHome = path.join(base, 'dsh-home');
    const libraryRoot = path.join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);

    const env = sanitizedTestEnv({ DSH_HOME: dshHome });
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;

    const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
    const storeFile = fs.readdirSync(distDir).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
    assert.ok(storeFile, 'dist/ must include store-*.mjs');
    const { useTuiStore } = await import(pathToFileURL(path.join(distDir, storeFile)).href);

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, sidebarCollapsed: false, showKeyHints: true, theme: 'dsh-dark' },
      { env },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: path.join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Golden layout snapshots must make 0 model calls');
      },
    });

    const tty = createVirtualTty(120, 36);
    let inst = null;

    const verifyGolden = (name, screen, cols, rows) => {
      tty.assertHealthyScreen(screen, cols, rows, `golden:${name}`);
      const normalized = normalizeGoldenFrame(screen, { tempBase: base });
      const normLines = normalized.trimEnd().split('\n');
      assert.equal(normLines.length, rows, `golden:${name}: expected exact ${rows} rows, got ${normLines.length}`);
      assert.ok(normLines[0]?.includes('▙▟ StudyHub'), `golden:${name}: top bar missing on row 1`);
      assert.ok(!/\b20\d{2}-\d{2}-\d{2}\b/.test(normalized), `golden:${name}: volatile ISO date leaked`);
      assert.ok(!/\b\d{2}:\d{2}:\d{2}\b/.test(normalized), `golden:${name}: volatile clock time leaked`);
      assert.ok(!/(?:刚刚|\d+\s*分钟前|\d+\s*小时前)/.test(normalized), `golden:${name}: volatile relative time leaked`);
      assert.ok(!normalized.includes('studyhub-golden-snap-'), `golden:${name}: temp path leaked`);
      assertMatchesGoldenSnapshot(name, normalized);
    };

    try {
      useTuiStore.setState({
        page: 'library',
        loading: true,
        snapshot: null,
        activeRunId: null,
        toasts: [],
        showLaunchpad: false,
        commandPaletteOpen: false,
        helpOpen: false,
        coursePickerOpen: false,
        inboxOpen: false,
        notificationHistoryOpen: false,
        quitConfirmOpen: false,
        assistantOpen: false,
        assistantFocused: false,
      });

      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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

      // 1) LibraryView (学习库): 120x36 & 80x24
      const libWide = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 120, 36, (text, lines) =>
            !useTuiStore.getState().loading &&
            text.includes('示例 · Memento 与 Bridge') &&
            text.includes('题量分布') &&
            text.includes('连续天数: 7天') &&
            text.includes('移除示例课') &&
            lines[35].includes('开始练习'),
          ),
        { timeoutMs: 25_000, label: 'library-120x36' },
      );
      verifyGolden('library-120x36', libWide, 120, 36);

      tty.resize(80, 24);
      const libNarrow = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 80, 24, (text, lines) =>
            text.includes('示例 · Memento 与 Bridge') &&
            text.includes('连续天数: 7天') &&
            text.includes('题量分布') &&
            lines[23].includes('开始练习'),
          ),
        { timeoutMs: 8_000, label: 'library-80x24' },
      );
      verifyGolden('library-80x24', libNarrow, 80, 24);

      // 2) ReviewView (刷题页): 80x24 & 120x36
      tty.send('\r');
      const reviewNarrow = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 80, 24, (text, lines) =>
            useTuiStore.getState().page === 'review' &&
            Boolean(useTuiStore.getState().activeRunId) &&
            !text.includes('正在加载练习') &&
            text.includes('1/9') &&
            text.includes('翻开答案') &&
            lines[23].includes('翻卡'),
          ),
        { timeoutMs: 10_000, label: 'review-80x24' },
      );
      verifyGolden('review-80x24', reviewNarrow, 80, 24);

      tty.resize(120, 36);
      const reviewWide = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 120, 36, (text, lines) =>
            !text.includes('正在加载练习') &&
            text.includes('1/9') &&
            text.includes('翻开答案') &&
            lines[35].includes('翻卡'),
          ),
        { timeoutMs: 8_000, label: 'review-120x36' },
      );
      verifyGolden('review-120x36', reviewWide, 120, 36);

      // Exit review round cleanly so global nav keys are active
      tty.send('X');
      await tty.waitFor((s) => s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'review end confirm' });
      tty.send('y');
      await tty.waitFor((s) => s.includes('本轮练习总结') || s.includes('Round Summary'), {
        timeoutMs: 6_000,
        label: 'round summary settled',
      });

      // 3) SourcesView (资料页): 120x36 & 80x24
      tty.send('2');
      const sourcesWide = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 120, 36, (text, lines) =>
            useTuiStore.getState().page === 'sources' &&
            !text.includes('正在加载页面') &&
            text.includes('学习资料库') &&
            text.includes('内容摘录') &&
            text.includes('墨笺是一家为学生做笔记应用的小公司') &&
            lines[35].includes('阅读') &&
            lines[35].includes('多选'),
          ),
        { timeoutMs: 10_000, label: 'sources-120x36' },
      );
      verifyGolden('sources-120x36', sourcesWide, 120, 36);

      tty.resize(80, 24);
      const sourcesNarrow = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 80, 24, (text, lines) =>
            text.includes('资料列表') &&
            !text.includes('内容摘录') &&
            lines[23].includes('阅读') &&
            lines[23].includes('多选'),
          ),
        { timeoutMs: 8_000, label: 'sources-80x24' },
      );
      verifyGolden('sources-80x24', sourcesNarrow, 80, 24);

      // 4) DocumentReader (阅读器): 80x24 & 120x36
      tty.send('\r');
      const readerNarrow = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 80, 24, (text, lines) =>
            !text.includes('资料列表') &&
            !text.includes('正在读取页面内容') &&
            text.includes('第 1 / 1 页') &&
            text.includes('墨笺是一家为学生做笔记应用的小公司') &&
            lines[23].includes('翻页'),
          ),
        { timeoutMs: 10_000, label: 'reader-80x24' },
      );
      verifyGolden('reader-80x24', readerNarrow, 80, 24);

      tty.resize(120, 36);
      const readerWide = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 120, 36, (text, lines) =>
            !text.includes('资料列表') &&
            !text.includes('正在读取页面内容') &&
            text.includes('第 1 / 1 页') &&
            text.includes('墨笺是一家为学生做笔记应用的小公司') &&
            lines[35].includes('翻页'),
          ),
        { timeoutMs: 8_000, label: 'reader-120x36' },
      );
      verifyGolden('reader-120x36', readerWide, 120, 36);

      // Return from DocumentReader to SourcesView
      tty.send('\x1b');
      await tty.waitFor(
        (s) => isFrameSettled(s, 120, 36, (text, lines) => text.includes('学习资料库') && lines[35].includes('阅读')),
        { timeoutMs: 8_000, label: 'returned to SourcesView' },
      );

      // 5) TasksView (后台任务): 120x36 & 80x24
      tty.send('t');
      const tasksWide = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 120, 36, (text, lines) =>
            useTuiStore.getState().page === 'tasks' &&
            !text.includes('正在加载页面') &&
            !text.includes('学习资料库') &&
            text.includes('监控后台任务') &&
            text.includes('当前筛选下无任务') &&
            text.includes('任务详情') &&
            lines[35].includes('暂停/继续'),
          ),
        { timeoutMs: 10_000, label: 'tasks-120x36' },
      );
      verifyGolden('tasks-120x36', tasksWide, 120, 36);

      tty.resize(80, 24);
      const tasksNarrow = await tty.waitFor(
        (s) =>
          isFrameSettled(s, 80, 24, (text, lines) =>
            !text.includes('学习资料库') &&
            text.includes('当前筛选下无任务') &&
            text.includes('任务列表') &&
            lines[23].includes('暂停/继续'),
          ),
        { timeoutMs: 8_000, label: 'tasks-80x24' },
      );
      verifyGolden('tasks-80x24', tasksNarrow, 80, 24);

      assert.equal(modelCalls, 0, 'Golden layout snapshot suite must make 0 model calls');
    } finally {
      if (inst) inst.unmount();
      tty.dispose();
      await host.dispose();
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
    });
  });
});
