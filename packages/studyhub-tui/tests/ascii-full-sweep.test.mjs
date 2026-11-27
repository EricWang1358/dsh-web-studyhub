// Authoritative --ascii Purity Suite:
// - Runtime 16-view sweep across 120x36 & 80x24 in en & zh (pooled virtual TTY)
// - Static modal/drawer/overlay/palette + Round-34/35 source audit
// - Component & path-truncation ASCII unit tests + resource leak check
// node --test tests/ascii-full-sweep.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';
import ts from 'typescript';
import {
  UNICODE_UI_CHROME_RE,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  formatLeakedChars,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const unregisterTsx = register();

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const srcRoot = join(pkgRoot, 'src');

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES: DIST_DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');

const [{ truncatePathMiddle }, { displayWidth }, badgeMod, textInputMod, storeMod] = await Promise.all([
  import('../src/views/settings/WorkspaceTab.tsx'),
  import('../src/render/cjk.ts'),
  import('../src/components/Badge.tsx'),
  import('../src/components/TextInput.tsx'),
  import('../src/state/store.js'),
]);
assert.ok(displayWidth, 'src/render/cjk.ts must export displayWidth');

const { normalizeAsciiChrome, Spinner, KeyHintBar, ToastStack, EmptyState } = badgeMod;
const { TextInput } = textInputMod;
const { useTuiStore: useSrcTuiStore, DEFAULT_PREFERENCES } = storeMod;

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-ascii-');

after(async () => {
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function resetDistTuiStore(language, asciiMode) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    snapshot: null,
    binding: null,
    desktopConfig: null,
    loading: true,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: {
      ...DIST_DEFAULT_PREFERENCES,
      recentCommands: [...DIST_DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
  });
}

function collectScreenIssues(tty, screen, expectedCols, expectedRows, contextLabel) {
  const issues = [];
  const lines = screen.split('\n');

  if (lines.length > expectedRows) {
    issues.push(`${contextLabel}: Row count exceeds viewport (${lines.length} > ${expectedRows})`);
  }
  if (screen.includes('页面渲染异常') || screen.includes('View Error') || /(?:^|\s)Error:\s/m.test(screen)) {
    issues.push(`${contextLabel}: Error boundary or Error: detected`);
  }
  if (screen.includes('TypeError:') || screen.includes('ReferenceError:')) {
    issues.push(`${contextLabel}: Runtime JS error rendered`);
  }
  if (/\bNaN\b/.test(screen)) {
    issues.push(`${contextLabel}: Raw NaN leaked`);
  }
  if (/\bundefined\b/.test(screen)) {
    issues.push(`${contextLabel}: Raw undefined leaked`);
  }
  if (screen.includes('[object Object]')) {
    issues.push(`${contextLabel}: Raw [object Object] leaked`);
  }
  if (screen.includes('\uFFFD')) {
    issues.push(`${contextLabel}: Replacement char U+FFFD found`);
  }
  if (screen.includes('\u001b')) {
    issues.push(`${contextLabel}: Unparsed escape sequence leaked into xterm buffer`);
  }

  const bodyLines = lines.slice(1, Math.max(1, expectedRows - 1));
  const nonBlankBody = bodyLines.filter((l) => l.trim().length > 0);
  const bodyTextLen = nonBlankBody.map((l) => l.trim()).join('').length;
  if (nonBlankBody.length < 2 || bodyTextLen < 12) {
    issues.push(`${contextLabel}: Blank or nearly empty body (lines=${nonBlankBody.length}, chars=${bodyTextLen})`);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    if (w > expectedCols) {
      issues.push(`${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`);
    }
    const lineChrome = lines[i].match(UNICODE_UI_CHROME_RE);
    if (lineChrome) {
      issues.push(
        `${contextLabel}: Row ${i} leaked Unicode UI chrome in --ascii mode ${JSON.stringify(formatLeakedChars(lineChrome))}: ${JSON.stringify(lines[i])}`,
      );
    }
  }

  const buf = tty.term.buffer.active;
  for (let y = 0; y < tty.term.rows; y += 1) {
    const line = buf.getLine(buf.viewportY + y);
    if (line && line.isWrapped) {
      issues.push(`${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`);
    }
  }

  return issues;
}

function createAuditCompleteStub() {
  return async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const out = 'StudyHub ascii audit stub response.';
    execution.onOutput?.(out);
    return out;
  };
}

const STILL_LOADING_RE =
  /正在加载页面|Loading view|正在打开学习库|Opening library/;

const ALL_16_VIEWS = [
  { id: 'library', key: '1', zh: /题组列表|今日到期/, en: /Decks|Start practice/ },
  { id: 'sources', key: '2', zh: /资料列表/, en: /Materials/ },
  { id: 'generate', key: '3', zh: /新建出题任务/, en: /New Generation/ },
  { id: 'wrongbook', key: '4', zh: /错题列表|暂无错题/, en: /Mistakes|No mistakes/ },
  { id: 'exam', key: '5', zh: /组卷设置/, en: /Mock Exam|Select Scope/ },
  { id: 'dashboard', key: '6', zh: /学习统计与掌握度/, en: /Study Analytics/ },
  { id: 'book', key: '7', zh: /章节目录|这门课还没有复习全书/, en: /Contents|No review book/ },
  { id: 'skeleton', key: '8', zh: /知识层级树|还没有知识骨架/, en: /Knowledge Tree|No knowledge skeletons/ },
  { id: 'examcoach', key: '9', zh: /考试教练/, en: /Exam Coach/ },
  { id: 'examprep', key: '0', zh: /考纲重点进度/, en: /Focus Progress/ },
  { id: 'notes', key: 'n', zh: /学习笔记|正文阅读|笔记列表|今日总结|关联题卡|更新于|暂无笔记/, en: /Notes|Daily Recap|Linked card|Updated|No notes/ },
  { id: 'board', key: 'b', zh: /进行中|待办 Todo/, en: /Doing|Todo/ },
  { id: 'tasks', key: 't', zh: /后台任务/, en: /Background Jobs/ },
  { id: 'settings', key: ',', zh: /模型配置|1 模型/, en: /Models|1 Models/ },
  { id: 'audio', key: 'a', zh: /音频转写工作台|已完成转写稿/, en: /Audio Transcription|Completed Transcripts/ },
  { id: 'review', key: '1r', zh: /AI讲解|翻开答案|FSRS|1\/\d+/, en: /AI Tutor|flip card|FSRS|1\/\d+/ },
];

const ASCII_SWEEP_PASSES = [
  { name: '120x36 en --ascii', cols: 120, rows: 36, language: 'en' },
  { name: '120x36 zh --ascii', cols: 120, rows: 36, language: 'zh' },
  { name: '80x24 en --ascii', cols: 80, rows: 24, language: 'en' },
  { name: '80x24 zh --ascii', cols: 80, rows: 24, language: 'zh' },
];

describe('StudyHub TUI Full 16-View --ascii Runtime Purity Sweep', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let baselineResources;

  before(async () => {
    boxDir = await temps.make('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createAuditCompleteStub(),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, 'sample.load must succeed');
  });

  after(async () => {
    await host?.dispose();
    if (boxDir) {
      await rm(boxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  });

  for (const pass of ASCII_SWEEP_PASSES) {
    test(`All 16 views zero Unicode UI chrome @ ${pass.name}`, async () => {
      resetDistTuiStore(pass.language, true);
      await saveTuiPreferences(
        { language: pass.language, asciiMode: true },
        { env: { DSH_HOME: dshHome } },
      );
      host.setLanguage(pass.language);

      const tty = createVirtualTty(pass.cols, pass.rows);
      let inkInstance = null;
      const failures = [];

      try {
        inkInstance = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'library',
            initialLanguage: pass.language,
            initialAsciiMode: true,
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

        for (const step of ALL_16_VIEWS) {
          if (step.key && step.id !== 'library') {
            for (const ch of step.key) {
              tty.send(ch);
              await tty.flush();
            }
          }

          const expectedRe = pass.language === 'en' ? step.en : step.zh;
          await tty.waitFor(
            (s) =>
              useTuiStore.getState().page === step.id &&
              (expectedRe.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
              !STILL_LOADING_RE.test(s),
            { timeoutMs: 8_000, label: `${step.id} @ ${pass.name}` },
          );

          await tty.flush();
          const screen = tty.readScreen();

          const viewIssues = collectScreenIssues(
            tty,
            screen,
            pass.cols,
            pass.rows,
            `${step.id} [${pass.name}]`,
          );
          if (viewIssues.length > 0) {
            failures.push(...viewIssues, `--- SNAPSHOT (${step.id}) ---\n${screen}\n--- END ---`);
          }
        }
      } finally {
        try {
          inkInstance?.unmount();
        } catch {
          // Ignore unmount errors on teardown
        }
        tty.dispose();
      }

      assert.deepEqual(failures, [], `${pass.name} failures:\n${failures.join('\n')}`);
    });
  }

  test('Clean resource teardown with zero leaked handles', async () => {
    await host.dispose();
    disposeTerminalPool();
    const deadline = Date.now() + 500;
    let afterRes = resourceCounts();
    while (
      Date.now() < deadline &&
      ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout'].some(
        (kind) => (afterRes[kind] || 0) > (baselineResources[kind] || 0),
      )
    ) {
      await new Promise((r) => setTimeout(r, 15));
      afterRes = resourceCounts();
    }
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0} after=${afterRes[kind] || 0}`,
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Static Modal / Drawer / Overlay / Palette + Component --ascii Audit
// -----------------------------------------------------------------------------

const STRUCTURAL_CHROME_RE = /[›✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾]/;
const ALL_CHROME_RE = /[›…✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾]/;

const OWNED_STRICT_FILES = [
  'src/views/sources/FolderModal.tsx',
  'src/views/sources/ImportModal.tsx',
  'src/views/sources/ReaderNotesDrawer.tsx',
  'src/views/sources/ReaderOutlineDrawer.tsx',
  'src/views/sources/MinerUModal.tsx',
  'src/views/review/ReviewView.tsx',
  'src/views/review/AnswerCardModal.tsx',
  'src/views/review/CardToolsModal.tsx',
  'src/views/review/RetellModal.tsx',
  'src/views/review/AiHelpDrawer.tsx',
  'src/views/skeleton/SkeletonView.tsx',
  'src/views/library/CourseSettingsModal.tsx',
  'src/views/library/DeckOpsModal.tsx',
  'src/views/library/DeckManageModal.tsx',
  'src/views/examprep/AddFocusModal.tsx',
  'src/views/examprep/ExamPrepView.tsx',
  'src/views/examprep/StudyPlanModal.tsx',
  'src/views/examcoach/ExamCoachView.tsx',
  'src/views/settings/WorkspaceTab.tsx',
  'src/views/settings/LibraryContextModal.tsx',
  'src/views/settings/ReleaseUpdateModal.tsx',
  'src/views/settings/RetrievalDiagModal.tsx',
  'src/views/settings/UsageReportModal.tsx',
  'src/views/settings/useWorkspaceActions.ts',
  'src/views/settings/workspace-model.ts',
  'src/views/notes/NoteEditorModal.tsx',
  'src/views/library/GuidedStudyModal.tsx',
  'src/views/tasks/WorkflowHistoryModal.tsx',
  'src/shell/CommandPalette.tsx',
];

const R35_VIEW_FILES = [
  'src/views/review/RoundSummary.tsx',
  'src/views/wrongbook/WrongBookView.tsx',
  'src/views/generate/GenerateView.tsx',
];

function walkOverlayFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkOverlayFiles(full));
    } else if (entry.isFile() && /(Modal|Drawer|Overlay|Palette)\.tsx$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function scanFileChromeLiterals(filePath, pattern) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const readsAscii = /\basciiMode\b|\bascii\b/.test(sourceText);

  let anyNonCommentMatch = false;
  const unguarded = [];

  function isGuardedByAscii(node) {
    // Allow helper function default parameter `ell = '…'` when callers pass `asciiMode ? '...' : '…'`
    if (
      node.parent &&
      ts.isParameter(node.parent) &&
      node.parent.initializer === node &&
      node.parent.name.getText(sf) === 'ell'
    ) {
      return true;
    }

    let cur = node;
    while (cur) {
      if (ts.isConditionalExpression(cur) && /\basciiMode\b|\bascii\b/.test(cur.condition.getText(sf))) {
        return true;
      }
      if (ts.isIfStatement(cur) && /\basciiMode\b|\bascii\b/.test(cur.expression.getText(sf))) {
        return true;
      }
      if (
        ts.isVariableDeclaration(cur) &&
        ts.isIdentifier(cur.name) &&
        /^[A-Z0-9_]+$/.test(cur.name.text) &&
        sourceText.includes(`ASCII_${cur.name.text}`)
      ) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  function visit(node) {
    let textVal = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      textVal = node.text;
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      textVal = node.text;
    } else if (ts.isJsxText(node)) {
      textVal = node.getText(sf);
    }

    if (textVal !== null && pattern.test(textVal)) {
      anyNonCommentMatch = true;
      if (!isGuardedByAscii(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        unguarded.push(`L${line + 1}: ${JSON.stringify(textVal.trim())}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { readsAscii, anyNonCommentMatch, unguarded };
}

function renderInkOnce(element, cols = 80) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = 10;
  stdout.getColorDepth = () => 1;

  let raw = '';
  stdout.on('data', (chunk) => {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  });

  const inst = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
  inst.unmount();
  stdin.destroy();
  stdout.destroy();
  return stripAnsi(raw);
}

describe('Modal / Drawer / Overlay / Palette --ascii Audit', () => {
  test('All *Modal/*Drawer/*Overlay/*Palette files with UI chrome glyphs read asciiMode/ascii and have zero unguarded structural glyphs', () => {
    const files = walkOverlayFiles(srcRoot);
    assert.ok(files.length >= 30, `Expected at least 30 modal/drawer/overlay/palette files, got ${files.length}`);

    const missingAscii = [];
    const structuralViolations = [];

    for (const file of files) {
      const rel = path.relative(pkgRoot, file);
      const anyCheck = scanFileChromeLiterals(file, ALL_CHROME_RE);
      if (anyCheck.anyNonCommentMatch && !anyCheck.readsAscii) {
        missingAscii.push(rel);
      }

      const structCheck = scanFileChromeLiterals(file, STRUCTURAL_CHROME_RE);
      if (structCheck.unguarded.length > 0) {
        structuralViolations.push(`${rel}:\n  ${structCheck.unguarded.join('\n  ')}`);
      }
    }

    assert.deepEqual(
      missingAscii,
      [],
      `Files containing UI chrome glyphs must read asciiMode or accept ascii prop:\n${missingAscii.join('\n')}`,
    );
    assert.deepEqual(
      structuralViolations,
      [],
      `Found unguarded structural UI chrome literals in modal/drawer/overlay/palette files:\n${structuralViolations.join('\n')}`,
    );
  });

  test('All 23 Round-34 owned files have zero unguarded UI chrome literals (including ellipsis)', () => {
    const violations = [];
    for (const rel of OWNED_STRICT_FILES) {
      const abs = path.join(pkgRoot, rel);
      assert.ok(fs.existsSync(abs), `Expected owned file to exist: ${rel}`);
      const res = scanFileChromeLiterals(abs, ALL_CHROME_RE);
      assert.equal(res.readsAscii, true, `${rel} must read asciiMode`);
      if (res.unguarded.length > 0) {
        violations.push(`${rel}:\n  ${res.unguarded.join('\n  ')}`);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found unguarded UI chrome literals (including …) in owned files:\n${violations.join('\n')}`,
    );
  });

  test('truncatePathMiddle(path, 24, "...") emits pure ASCII and respects displayWidth', () => {
    const cases = [
      {
        input: '/Users/alice/Documents/Projects/StudyHub/Library/CourseMaterials/2026',
        maxWidth: 24,
        expectTruncated: true,
        expectAsciiOnly: true,
      },
      {
        input: 'C:\\Users\\Administrator\\Documents\\StudyHub\\Backup\\library-root',
        maxWidth: 24,
        expectTruncated: true,
        expectAsciiOnly: true,
      },
      {
        input: '/Users/学习资料/高等数学/微积分讲义与真题汇总',
        maxWidth: 24,
        expectTruncated: true,
        expectAsciiOnly: false,
      },
      {
        input: '/tmp/short',
        maxWidth: 24,
        expectTruncated: false,
        expectAsciiOnly: true,
      },
      {
        input: 'very-long-single-segment-folder-name-without-separators',
        maxWidth: 24,
        expectTruncated: true,
        expectAsciiOnly: true,
      },
      {
        input: '/Users/alice/workspace/studyhub-library/',
        maxWidth: 12,
        expectTruncated: true,
        expectAsciiOnly: true,
      },
    ];

    for (const tc of cases) {
      const out = truncatePathMiddle(tc.input, tc.maxWidth, '...');
      const w = displayWidth(out);
      assert.ok(w <= tc.maxWidth, `Expected displayWidth("${out}")=${w} <= ${tc.maxWidth}`);
      assert.equal(UNICODE_UI_CHROME_RE.test(out), false, `Unexpected Unicode UI chrome in "${out}"`);
      assert.equal(out.includes('…'), false, `Unexpected U+2026 ellipsis in "${out}"`);
      if (tc.expectTruncated) {
        assert.ok(out.includes('...'), `Expected "..." in truncated output "${out}"`);
      } else {
        assert.equal(out, tc.input);
      }
      if (tc.expectAsciiOnly) {
        assert.match(out, /^[\x20-\x7e]*$/, `Expected pure printable ASCII in "${out}"`);
      }
    }
  });

  test('Round-35 owned views (RoundSummary, WrongBookView, GenerateView) have zero unguarded UI chrome', () => {
    const violations = [];
    for (const rel of R35_VIEW_FILES) {
      const abs = path.join(pkgRoot, rel);
      const res = scanFileChromeLiterals(abs, ALL_CHROME_RE);
      assert.equal(res.readsAscii, true, `${rel} must read asciiMode`);
      if (res.unguarded.length > 0) {
        violations.push(`${rel}:\n  ${res.unguarded.join('\n  ')}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Found unguarded UI chrome literals in Round-35 owned files:\n${violations.join('\n')}`,
    );
  });

  test('normalizeAsciiChrome maps all UI chrome glyphs when ascii=true and preserves input when ascii=false', () => {
    const pairs = [
      ['…', '...'],
      ['↑↓', 'Up/Down'],
      ['↑/↓', 'Up/Down'],
      ['←/→', 'Left/Right'],
      ['←→', 'Left/Right'],
      ['↑', 'Up'],
      ['↓', 'Down'],
      ['←', 'Left'],
      ['→', 'Right'],
      ['›', '>'],
      ['▸', '>'],
      ['▾', 'v'],
      ['•', '-'],
      ['✓', 'OK'],
      ['✕', 'x'],
      ['★', '*'],
      ['◆', '*'],
      ['●', '*'],
      ['○', 'o'],
      ['☑', '[x]'],
      ['☐', '[ ]'],
      ['⚠', '[!]'],
    ];

    for (const [src, expected] of pairs) {
      assert.equal(normalizeAsciiChrome(src, true), expected, `ascii=true mapping for ${src}`);
      assert.equal(normalizeAsciiChrome(src, false), src, `ascii=false preservation for ${src}`);
    }

    const combined = '↑↓ 移动…  ←/→ 翻页 › ✓ 完成 ✕ 失败 ★ ◆ ● ○ ☑ ☐ ⚠ • ▸ ▾ ↑ ↓ ← → ←→ ↑/↓';
    assert.equal(
      normalizeAsciiChrome(combined, true),
      'Up/Down 移动...  Left/Right 翻页 > OK 完成 x 失败 * * * o [x] [ ] [!] - > v Up Down Left Right Left/Right Up/Down',
    );
    assert.equal(normalizeAsciiChrome(combined, false), combined);

    const regular = '高等数学 Linear Algebra 100% [OK] (v1.2) - item_a';
    assert.equal(normalizeAsciiChrome(regular, true), regular);
    assert.equal(normalizeAsciiChrome('', true), '');
  });

  test('Spinner, KeyHintBar, ToastStack, EmptyState, and TextInput emit pure ASCII chrome when asciiMode=true', () => {
    const prevPrefs = useSrcTuiStore.getState().preferences;
    try {
      useSrcTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: true } });

      const spinnerOut = renderInkOnce(
        React.createElement(Spinner, { label: '正在加载… ✓', active: false }),
      );
      assert.ok(spinnerOut.includes('正在加载... OK'), `Spinner output: ${JSON.stringify(spinnerOut)}`);
      assert.equal(UNICODE_UI_CHROME_RE.test(spinnerOut), false, `Unexpected Unicode UI chrome in Spinner: ${spinnerOut}`);

      const hintsOut = renderInkOnce(
        React.createElement(KeyHintBar, {
          width: 80,
          hints: [
            { key: '↑↓', label: '选择…' },
            { key: '←/→', label: '切换▸' },
            { key: 'Enter', label: '确认✓' },
          ],
          right: '● 3/10…',
        }),
      );
      assert.ok(hintsOut.includes('Up/Down'), `KeyHintBar key normalized: ${JSON.stringify(hintsOut)}`);
      assert.ok(hintsOut.includes('选择...'), `KeyHintBar label normalized: ${JSON.stringify(hintsOut)}`);
      assert.ok(hintsOut.includes('Left/Right'), `KeyHintBar arrow pair normalized: ${JSON.stringify(hintsOut)}`);
      assert.ok(hintsOut.includes('切换>'), `KeyHintBar triangle normalized: ${JSON.stringify(hintsOut)}`);
      assert.ok(hintsOut.includes('确认OK'), `KeyHintBar check normalized: ${JSON.stringify(hintsOut)}`);
      assert.ok(hintsOut.includes('* 3/10...'), `KeyHintBar right normalized: ${JSON.stringify(hintsOut)}`);
      assert.equal(UNICODE_UI_CHROME_RE.test(hintsOut), false, `Unexpected Unicode UI chrome in KeyHintBar: ${hintsOut}`);

      const toastOut = renderInkOnce(
        React.createElement(ToastStack, {
          width: 60,
          autoDismissMs: 0,
          onDismiss: () => {},
          toasts: [{ id: 't1', tone: 'success', text: '✓ 已保存 ⚠ 请注意…', createdAt: Date.now() }],
        }),
      );
      assert.ok(toastOut.includes('OK 已保存 [!] 请注意...'), `ToastStack output: ${JSON.stringify(toastOut)}`);
      assert.equal(UNICODE_UI_CHROME_RE.test(toastOut), false, `Unexpected Unicode UI chrome in ToastStack: ${toastOut}`);

      const emptyOut = renderInkOnce(
        React.createElement(EmptyState, {
          title: '○ 暂无记录…',
          hint: '按 ↑↓ 选择 • 按 Enter 继续',
          actions: [{ key: '←/→', label: '切换▸' }],
        }),
      );
      assert.ok(emptyOut.includes('o 暂无记录...'), `EmptyState title: ${JSON.stringify(emptyOut)}`);
      assert.ok(emptyOut.includes('按 Up/Down 选择 - 按 Enter 继续'), `EmptyState hint: ${JSON.stringify(emptyOut)}`);
      assert.ok(emptyOut.includes('Left/Right'), `EmptyState action key: ${JSON.stringify(emptyOut)}`);
      assert.equal(UNICODE_UI_CHROME_RE.test(emptyOut), false, `Unexpected Unicode UI chrome in EmptyState: ${emptyOut}`);

      const inputPlaceholderOut = renderInkOnce(
        React.createElement(TextInput, {
          value: '',
          onChange: () => {},
          prompt: '›',
          placeholder: '搜索关键词… ↑↓',
          isActive: false,
          width: 40,
        }),
      );
      assert.ok(inputPlaceholderOut.includes('> 搜索关键词... Up/Down'), `TextInput placeholder: ${JSON.stringify(inputPlaceholderOut)}`);
      assert.equal(
        UNICODE_UI_CHROME_RE.test(inputPlaceholderOut),
        false,
        `Unexpected Unicode UI chrome in TextInput placeholder: ${inputPlaceholderOut}`,
      );

      // User value must NEVER be mutated by normalizeAsciiChrome even in asciiMode=true
      const userVal = '用户笔记…✓→';
      const inputValueOut = renderInkOnce(
        React.createElement(TextInput, {
          value: userVal,
          onChange: () => {},
          prompt: '›',
          placeholder: '忽略…',
          isActive: false,
          width: 40,
        }),
      );
      assert.ok(inputValueOut.includes(`> ${userVal}`), `TextInput should normalize prompt while preserving user value: ${JSON.stringify(inputValueOut)}`);

      // Default asciiMode=false keeps original Unicode chrome
      useSrcTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: false } });
      const unicodeSpinnerOut = renderInkOnce(
        React.createElement(Spinner, { label: '正在加载…', active: false }),
      );
      assert.ok(unicodeSpinnerOut.includes('⠋ 正在加载…'), `Default Spinner output: ${JSON.stringify(unicodeSpinnerOut)}`);
    } finally {
      useSrcTuiStore.setState({ preferences: prevPrefs });
    }
  });
});
