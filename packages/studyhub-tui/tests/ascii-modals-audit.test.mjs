// Static --ascii audit across all modals/drawers/overlays/palettes + owned views,
// and runtime unit tests for truncatePathMiddle():
// `node --test tests/ascii-modals-audit.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import ts from 'typescript';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const srcRoot = path.join(pkgRoot, 'src');

const STRUCTURAL_CHROME_RE = /[›✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾]/;
const ALL_CHROME_RE = /[›…✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾]/;
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/;

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
  'src/views/notes/NoteEditorModal.tsx',
  'src/views/library/GuidedStudyModal.tsx',
  'src/views/tasks/WorkflowHistoryModal.tsx',
  'src/shell/CommandPalette.tsx',
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

const [{ truncatePathMiddle }, { displayWidth }, badgeMod, textInputMod, storeMod] = await Promise.all([
  import('../src/views/settings/WorkspaceTab.tsx'),
  import('../src/render/cjk.ts'),
  import('../src/components/Badge.tsx'),
  import('../src/components/TextInput.tsx'),
  import('../src/state/store.js'),
]);

const { normalizeAsciiChrome, Spinner, KeyHintBar, ToastStack, EmptyState } = badgeMod;
const { TextInput } = textInputMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

const R35_VIEW_FILES = [
  'src/views/review/TeachModal.tsx',
  'src/views/review/RoundSummary.tsx',
  'src/views/wrongbook/WrongBookView.tsx',
  'src/views/generate/GenerateView.tsx',
];

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

  test('Round-35 owned views (TeachModal, RoundSummary, WrongBookView, GenerateView) have zero unguarded UI chrome', () => {
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
    const prevPrefs = useTuiStore.getState().preferences;
    try {
      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: true } });

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
      useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, asciiMode: false } });
      const unicodeSpinnerOut = renderInkOnce(
        React.createElement(Spinner, { label: '正在加载…', active: false }),
      );
      assert.ok(unicodeSpinnerOut.includes('⠋ 正在加载…'), `Default Spinner output: ${JSON.stringify(unicodeSpinnerOut)}`);
    } finally {
      useTuiStore.setState({ preferences: prevPrefs });
    }
  });
});
