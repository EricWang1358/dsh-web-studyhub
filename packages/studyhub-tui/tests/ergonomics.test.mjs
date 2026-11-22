// Keyboard ergonomics & help parity unit tests: `node --test tests/ergonomics.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-ergonomics-'));
const outfile = path.join(outDir, 'bundle.mjs');

await build({
  stdin: {
    contents: [
      `export { pageStep, nextScrollOffset, scrollbarThumb } from './src/components/VirtualList.tsx';`,
      `export { pageStep as scrollViewPageStep } from './src/components/ScrollView.tsx';`,
      `export { globalShortcuts, featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});

fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
const M = await import(pathToFileURL(outfile).href);
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

test('pageStep computes exact half and full page steps with minimum 1', () => {
  assert.equal(M.pageStep(0, 'half'), 1);
  assert.equal(M.pageStep(1, 'half'), 1);
  assert.equal(M.pageStep(2, 'half'), 1);
  assert.equal(M.pageStep(10, 'half'), 5);
  assert.equal(M.pageStep(11, 'half'), 5);
  assert.equal(M.pageStep(25, 'half'), 12);

  assert.equal(M.pageStep(0, 'full'), 1);
  assert.equal(M.pageStep(1, 'full'), 1);
  assert.equal(M.pageStep(2, 'full'), 1);
  assert.equal(M.pageStep(10, 'full'), 9);
  assert.equal(M.pageStep(24, 'full'), 23);

  assert.equal(M.pageStep(Number.NaN, 'half'), 1);
  assert.equal(M.scrollViewPageStep(16, 'half'), 8);
  assert.equal(M.scrollViewPageStep(16, 'full'), 15);
});

test('nextScrollOffset keeps cursor visible with padding and clamps to bounds', () => {
  assert.equal(M.nextScrollOffset(0, 0, 10, 5), 0);
  assert.equal(M.nextScrollOffset(4, 0, 10, 5), 0);

  assert.equal(M.nextScrollOffset(0, 0, 10, 30), 0);
  assert.equal(M.nextScrollOffset(8, 0, 10, 30), 0);
  assert.equal(M.nextScrollOffset(9, 0, 10, 30), 1);
  assert.equal(M.nextScrollOffset(29, 10, 10, 30), 20);
  assert.equal(M.nextScrollOffset(0, 20, 10, 30), 0);

  // Half-page jump down from cursor 0 in a 10-row viewport of 30 items
  const halfDown = 0 + M.pageStep(10, 'half');
  assert.equal(halfDown, 5);
  assert.equal(M.nextScrollOffset(halfDown, 0, 10, 30), 0);

  // Full-page jump down to cursor 9 pushes viewport down by 1
  const fullDown = 0 + M.pageStep(10, 'full');
  assert.equal(fullDown, 9);
  assert.equal(M.nextScrollOffset(fullDown, 0, 10, 30), 1);
});

test('scrollbarThumb computes accurate thumb segments and empty track when unscrollable', () => {
  assert.deepEqual(M.scrollbarThumb(5, 10, 0), new Array(10).fill(false));
  assert.deepEqual(M.scrollbarThumb(10, 10, 0), new Array(10).fill(false));
  assert.deepEqual(M.scrollbarThumb(10, 0, 0), []);

  const topThumb = M.scrollbarThumb(40, 10, 0);
  assert.equal(topThumb.length, 10);
  assert.equal(topThumb[0], true);
  assert.equal(topThumb[9], false);
  assert.ok(topThumb.filter(Boolean).length >= 1);

  const botThumb = M.scrollbarThumb(40, 10, 30);
  assert.equal(botThumb.length, 10);
  assert.equal(botThumb[0], false);
  assert.equal(botThumb[9], true);
});

test('globalShortcuts documents required keys cleanly in zh and en without duplicates', () => {
  for (const lang of ['zh', 'en']) {
    for (const ascii of [false, true]) {
      const list = M.globalShortcuts(lang, ascii);
      assert.ok(Array.isArray(list) && list.length >= 12);
      const keys = list.map((h) => h.key);
      assert.equal(new Set(keys).size, keys.length, `duplicate key in globalShortcuts (${lang}, ascii=${ascii})`);
      const keysJoined = keys.join('\n');
      for (const expected of ['I', 'Ctrl+K', '?', 'c', '[', '\\', 'Ctrl+R', 'Ctrl+D/U', 'g/G']) {
        assert.ok(keysJoined.includes(expected), `missing ${expected} in ${lang} (ascii=${ascii})`);
      }
      for (const item of list) {
        assert.ok(item.key.trim().length > 0);
        assert.ok(item.label.trim().length > 0);
        if (ascii) {
          assert.match(item.key, /^[\x20-\x7e]+$/, `non-ASCII key in asciiMode: ${item.key}`);
        }
      }
    }
  }
});

test('featureShortcuts documents Rounds 5-23 shortcuts cleanly in zh and en without duplicates', () => {
  for (const lang of ['zh', 'en']) {
    const sections = M.featureShortcuts(lang);
    assert.equal(sections.length, 13);
    const titles = sections.map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length, `duplicate section title in ${lang}`);
    for (const sec of sections) {
      assert.ok(sec.title.trim().length > 0, `empty section title in ${lang}`);
      assert.ok(sec.items.length > 0, `empty section items for ${sec.title} in ${lang}`);
      const secKeys = sec.items.map((i) => i.key);
      const secLabels = sec.items.map((i) => i.label);
      assert.equal(new Set(secKeys).size, secKeys.length, `duplicate shortcut key in ${sec.title} (${lang})`);
      assert.equal(new Set(secLabels).size, secLabels.length, `duplicate shortcut label in ${sec.title} (${lang})`);
      for (const item of sec.items) {
        assert.ok(item.key.trim().length > 0, `empty key in ${sec.title} (${lang})`);
        assert.ok(item.label.trim().length > 0, `empty label in ${sec.title} (${lang})`);
      }
    }

    const titlesJoined = titles.join('\n');
    assert.ok(titlesJoined.includes('Generate'), `missing Generate section in ${lang}`);
    assert.ok(titlesJoined.includes('Book'), `missing Book section in ${lang}`);
    assert.ok(titlesJoined.includes('Dashboard'), `missing Dashboard section in ${lang}`);
    assert.ok(
      titles.some((title) => title.includes('Exam') && !title.includes('Coach') && !title.includes('Prep')),
      `missing Exam section in ${lang}`,
    );
    assert.ok(titlesJoined.includes('Exam Coach'), `missing Exam Coach section in ${lang}`);
    assert.ok(titlesJoined.includes('Exam Prep'), `missing Exam Prep section in ${lang}`);
    assert.ok(titlesJoined.includes('Skeleton') && titlesJoined.includes('Notes'), `missing Skeleton/Notes section in ${lang}`);
    assert.ok(titlesJoined.includes('Sources'), `missing Sources section in ${lang}`);
    assert.ok(titlesJoined.includes('Board'), `missing Board section in ${lang}`);
    assert.ok(titlesJoined.includes('Tasks'), `missing Tasks section in ${lang}`);
    assert.ok(titlesJoined.includes('Settings'), `missing Settings section in ${lang}`);
    if (lang === 'zh') {
      assert.ok(titlesJoined.includes('出题与草稿'), 'missing 出题与草稿 section in zh');
      assert.ok(titlesJoined.includes('复习全书'), 'missing 复习全书 section in zh');
      assert.ok(titlesJoined.includes('学习统计'), 'missing 学习统计 section in zh');
      assert.ok(titlesJoined.includes('模拟考'), 'missing 模拟考 section in zh');
      assert.ok(titlesJoined.includes('考试教练'), 'missing 考试教练 section in zh');
      assert.ok(titlesJoined.includes('备考补习'), 'missing 备考补习 section in zh');
      assert.ok(titlesJoined.includes('骨架与笔记'), 'missing 骨架与笔记 section in zh');
      assert.ok(titlesJoined.includes('待办看板'), 'missing 待办看板 section in zh');
      assert.ok(titlesJoined.includes('后台任务'), 'missing 后台任务 section in zh');
      assert.ok(titlesJoined.includes('设置'), 'missing 设置 section in zh');
    }

    const allKeys = sections.flatMap((s) => s.items.map((i) => i.key));
    for (const k of ['p', 'g', 'C', 'o', 'm: + / k', 'T', 'S', 'D', 'F', 'G', 'L', 'A', 'Q', '*', 'i', 'S / R', 'w', 'P', 'e', 'x', 'Enter/p', 'f', 's', 'H', 'V', 'm', 'M', 'O', 'B', 'P / Space', '+/-', 'R', 'w / o / m']) {
      assert.ok(allKeys.includes(k), `missing feature shortcut ${k} in ${lang}`);
    }
    const keysJoined = allKeys.join('\n');
    for (const token of ['o', 'g', '+', 'k', 'L', 'A', 'Q', '*', 'i', 'w', 'P', 'p', 'f', 's', 'H', 'F', 'G', 'V', 'M', 'S', 'R', 'x']) {
      assert.ok(keysJoined.includes(token), `missing token ${token} in ${lang}`);
    }

    const librarySec = sections.find((s) => s.title.includes('Library'));
    const reviewSec = sections.find((s) => s.title.includes('Review') && !s.title.includes('Book'));
    const generateSec = sections.find((s) => s.title.includes('Generate'));
    const sourcesSec = sections.find((s) => s.title.includes('Sources'));
    const bookSec = sections.find((s) => s.title.includes('Book'));
    const dashboardSec = sections.find((s) => s.title.includes('Dashboard'));
    const examSec = sections.find((s) => s.title.includes('Exam') && !s.title.includes('Coach') && !s.title.includes('Prep'));
    const coachSec = sections.find((s) => s.title.includes('Exam Coach'));
    const examPrepSec = sections.find((s) => s.title.includes('Exam Prep'));
    const skelNotesSec = sections.find((s) => s.title.includes('Skeleton') && s.title.includes('Notes'));
    const boardSec = sections.find((s) => s.title.includes('Board'));
    const tasksSec = sections.find((s) => s.title.includes('Tasks'));
    assert.ok(librarySec?.items.some((i) => i.key === 'g' && (i.label.includes('带学') || i.label.includes('Guided Study'))), `missing Library [g] label in ${lang}`);
    assert.ok(librarySec?.items.some((i) => i.key === 'm: + / k' && (i.label.includes('补题') || i.label.includes('supplement'))), `missing Library [m: + / k] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === 'L' && (i.label.includes('带学') || i.label.includes('Socratic'))), `missing Review [L] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === 'A' && (i.label.includes('答题卡') || i.label.includes('Answer card'))), `missing Review [A] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === 'Q' && (i.label.includes('队列编辑') || i.label.includes('Edit queue'))), `missing Review [Q] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === '*' && (i.label.includes('重点') || i.label.includes('focus'))), `missing Review [*] label in ${lang}`);
    assert.ok(generateSec?.items.some((i) => i.key === 'i' && (i.label.includes('录题') || i.label.includes('Capture'))), `missing Generate [i] label in ${lang}`);
    assert.ok(generateSec?.items.some((i) => i.key === 'S / R' && (i.label.includes('查重') || i.label.includes('similar'))), `missing Generate [S / R] label in ${lang}`);
    assert.ok(sourcesSec?.items.some((i) => i.key === 'G' && (i.label.includes('归类') || i.label.includes('organize'))), `missing Sources [G] label in ${lang}`);
    assert.ok(sourcesSec?.items.some((i) => i.key === 'V' && (i.label.includes('覆盖率') || i.label.includes('Coverage'))), `missing Sources [V] label in ${lang}`);
    assert.ok(sourcesSec?.items.some((i) => i.key === 'M' && i.label.includes('MinerU')), `missing Sources [M] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'w' && (i.label.includes('期末一周') || i.label.includes('Final-week'))), `missing Book [w] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'P' && (i.label.includes('精选问答') || i.label.includes('book QA'))), `missing Book [P] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'e' && (i.label.includes('编辑/回退全书') || i.label.includes('Edit/revert section'))), `missing Book [e] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'x' && (i.label.includes('导出 Markdown') || i.label.includes('Export Markdown'))), `missing Book [x] label in ${lang}`);
    assert.ok(dashboardSec?.items.some((i) => i.key === 'Enter/p' && (i.label.includes('钻取练习') || i.label.includes('Drill practice'))), `missing Dashboard [Enter/p] label in ${lang}`);
    assert.ok(dashboardSec?.items.some((i) => i.key === 'f' && (i.label.includes('7天预测') || i.label.includes('7d forecast'))), `missing Dashboard [f] label in ${lang}`);
    assert.ok(examSec?.items.some((i) => i.key === 's' && (i.label.includes('切换材料') || i.label.includes('Toggle case'))), `missing Exam [s] label in ${lang}`);
    assert.ok(examSec?.items.some((i) => i.key === 'H' && (i.label.includes('标亮段落') || i.label.includes('Highlight'))), `missing Exam [H] label in ${lang}`);
    assert.ok(coachSec?.items.some((i) => i.key === 'p' && (i.label.includes('画像与偏好') || i.label.includes('profile'))), `missing Exam Coach [p] label in ${lang}`);
    assert.ok(examPrepSec?.items.some((i) => i.key === 'P' && (i.label.includes('备考计划') || i.label.includes('Study plan'))), `missing Exam Prep [P] label in ${lang}`);
    assert.ok(skelNotesSec?.items.some((i) => i.key === 'L' && (i.label.includes('骨架自检') || i.label.includes('Skeleton lint'))), `missing Skeleton/Notes [L] label in ${lang}`);
    assert.ok(skelNotesSec?.items.some((i) => i.key === 'o' && (i.label.includes('跳转关联') || i.label.includes('Jump linked ref'))), `missing Skeleton/Notes [o] label in ${lang}`);
    assert.ok(boardSec?.items.some((i) => i.key === 'S' && (i.label.includes('同步') || i.label.includes('Sync'))), `missing Board [S] label in ${lang}`);
    assert.ok(tasksSec?.items.some((i) => i.key === 'w / o / m' && (i.label.includes('工作流') || i.label.includes('Workflows'))), `missing Tasks [w / o / m] label in ${lang}`);
  }
});
