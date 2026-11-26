// Permanent automated guardrails for the 5-category systematic TUI audit (#1374-#1383).
// Note on static architectural scanners below: repo-wide tree checks scanning ALL_SRC_FILES
// (flexWrap+gap, leaked backend action names, error truncation, followup/note persistence params,
// raw fs.rename bans, streamComplete AbortController signals) intentionally inspect the entire
// packages/studyhub-tui/src/ tree statically because they enforce cross-codebase invariants that
// no single runtime scenario can exhaustively cover. Single-component behaviors (AiHelpDrawer,
// NoteEditorModal, AddFocusModal, ExamSetup, GenerateView, CoachNudgeModal, update-check &
// usage-frequency corrupt backups) are verified dynamically at runtime via Ink / module execution.
// node --test tests/audit-guardrails.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

const [{ useTuiStore, DEFAULT_PREFERENCES }, { getModalHintsSnapshot }, { useKeyDispatcherBridge }] = await Promise.all([
  import('../src/state/store.ts'),
  import('../src/components/focus.ts'),
  import('../src/input/hooks.ts'),
]);

function KeyBridgeWrapper({ children }) {
  useKeyDispatcherBridge();
  return React.createElement(Box, { width: 112, height: 34 }, children);
}

function createInkHarness(element, { cols = 112, rows = 34 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const instance = render(
    React.createElement(KeyBridgeWrapper, null, element),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  return {
    write: (data) => stdin.write(data),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Last frame:\n${latest}`);
    },
    cleanup() {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetTuiStore(extra = {}) {
  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    inputCaptured: false,
    footerHints: [],
    toasts: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    ...extra,
  });
}

function walkSourceFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const ALL_SRC_FILES = walkSourceFiles(SRC_ROOT).sort();
const rel = (p) => path.relative(SRC_ROOT, p).replace(/\\/g, '/');

describe('Systematic 5-Category Audit Guardrails (#1374-#1383)', () => {
  test('[Cat 1: Key Conflicts] Reusable list/scroll components gate g/G jump keys behind vimJumpKeys (#1349, #1374, #1375)', () => {
    const targets = ['components/VirtualList.tsx', 'components/ScrollView.tsx', 'components/SelectList.tsx'];
    const violations = [];
    for (const r of targets) {
      const code = fs.readFileSync(path.join(SRC_ROOT, r), 'utf8');
      if (!/\bvimJumpKeys\b/.test(code)) {
        violations.push(`${r}: missing vimJumpKeys opt-in prop`);
        continue;
      }
      const lines = code.split('\n');
      lines.forEach((line, idx) => {
        if (/input\s*===\s*['"][gG]['"]/.test(line) && !/vimJumpKeys/.test(line)) {
          violations.push(`${r}:${idx + 1}: unguarded g/G handler -> ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(violations, [], `Component g/G key conflict violations:\n${violations.join('\n')}`);
  });

  test('[Cat 1: Key Conflicts Runtime] AiHelpDrawer holds opaque input capture and registers modal footer hints while mounted (#1376)', async () => {
    resetTuiStore();
    const { AiHelpDrawer } = await import('../src/views/review/AiHelpDrawer.tsx');
    const host = {
      mode: 'embedded',
      snapshot: async () => null,
      call: async () => ({ ok: true, value: {} }),
      stream: async () => {},
      close: async () => {},
    };
    const run = {
      id: 'run-1376',
      index: 0,
      total: 1,
      mode: 'flashcard',
      deckId: 'd1',
      card: { id: 'c1', kind: 'flashcard', prompt: '什么是死锁？', answer: '循环等待' },
      revealed: true,
      solution: {
        answer: '循环等待',
        followups: [{ id: 'fu-1', question: '解释死锁', answer: '四个必要条件同时满足。' }],
      },
    };
    const h = createInkHarness(
      React.createElement(AiHelpDrawer, {
        host,
        run,
        cardId: 'c1',
        kind: 'flashcard',
        userAnswer: '',
        width: 96,
        height: 28,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
      }),
    );
    try {
      await h.waitFor((s) => s.includes('四个必要条件'), 4000, 'AiHelpDrawer mounted');
      assert.equal(useTuiStore.getState().inputCaptured, true, 'AiHelpDrawer must hold opaque input capture while mounted');
      const modalHints = getModalHintsSnapshot();
      assert.ok(Array.isArray(modalHints) && modalHints.length > 0, 'AiHelpDrawer must register modal footer hints');
      assert.ok(modalHints.some((hint) => /esc/i.test(hint.key)), 'AiHelpDrawer modal hints include Esc');
    } finally {
      h.cleanup();
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(useTuiStore.getState().inputCaptured, false, 'AiHelpDrawer releases input capture on unmount');
    assert.equal(getModalHintsSnapshot(), null, 'AiHelpDrawer clears modal footer hints on unmount');
  });

  test('[Cat 2: Layout] Zero flexWrap="wrap" containers using gap={N} instead of columnGap={N} (#1353, #1377)', () => {
    const violations = [];
    for (const file of ALL_SRC_FILES) {
      const r = rel(file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (/flexWrap\s*=\s*["']wrap["']/.test(line) && /\bgap\s*=\s*\{?\s*[1-9]/.test(line)) {
          violations.push(`${r}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Found flexWrap="wrap" paired with gap={N} (causes vertical rowGap blank lines; use columnGap instead):\n${violations.join('\n')}`,
    );
  });

  test('[Cat 2: Copy] Zero internal backend action names exposed in user-facing UI strings (#1352, #1378)', () => {
    const ACTION_NAME_RE =
      /\b(card\.(?:update|slay|restore|terms|link|followup(?:\.add|\.suggest)?|translate|grade|convert|revert|flag|focus|suspend|place)|coach\.(?:feedback|rewrite\.retry|nudge|reply|profile|preferences|debrief|variants|practice|revert)|review\.(?:start|get|reveal|answer|move|skip|end|similar|grading|grade\.adjust|correction\.ack|draft\.save|queue\.edit|weak\.start)|teach\.(?:start|get|answer|skip|retell)|note\.(?:create|save|delete|qa\.add|generate|daily\.\w+|link|material\.prepare)|book\.(?:retell|qa\.\w+|crunch\.\w+|mock\.\w+|write)|deck\.(?:import|merge|split|archive|remove|reorder|move|edit)|course\.method\.save|wrongbook\.reason\.set)\b/g;
    const violations = [];
    for (const file of ALL_SRC_FILES) {
      const r = rel(file);
      if (r.startsWith('host/')) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (/^\s*\/\//.test(line)) return;
        if (/tryAction|host\.call|callAction|actionName\s*===|case\s+['"]/.test(line)) return;
        if (!/\bt\s*\(\s*lang\b|label\s*:|title\s*:|message\s*:|hint\s*:|badge\s*:|desc\s*:|text\s*:|actionSummary\s*:/.test(line)) {
          return;
        }
        // Ignore property accesses like `card.flag` inside template interpolation `${card.flag}`
        const stripped = line.replace(/\$\{[^}]+\}/g, '');
        const matches = stripped.match(ACTION_NAME_RE);
        if (matches) {
          violations.push(`${r}:${idx + 1}: [${matches.join(', ')}] ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Found internal backend action names leaked in UI copy:\n${violations.join('\n')}`,
    );
  });

  test('[Cat 2: Truncation] Zero truncateDisplay() calls slicing error or warning messages (#1354 D5, #1379, #1391)', () => {
    const violations = [];
    const ERR_TRUNC_RE =
      /truncateDisplay\s*\(\s*(?:(?:[a-zA-Z0-9_]*Error|[a-zA-Z0-9_]*Err|errorText|errorMsg|failure|proposal\.failure\.message|warnings\[0\])\b|normalizeAsciiChrome\s*\(\s*error\b|`[^`]*\$\{[^}]*(?:Error|Err)\b)/;
    for (const file of ALL_SRC_FILES) {
      const r = rel(file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (ERR_TRUNC_RE.test(line)) {
          violations.push(`${r}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Found error/warning messages truncated via truncateDisplay() (wrap errors with wrap="wrap" instead):\n${violations.join('\n')}`,
    );
  });

  test('[Cat 3: AI Entry Consistency] Every card.followup.add passes replace:true and every note.qa.add passes title (#1336, #1337, #1380)', () => {
    const violations = [];
    for (const file of ALL_SRC_FILES) {
      const r = rel(file);
      const code = fs.readFileSync(file, 'utf8');
      for (const m of code.matchAll(/tryAction(?:<[^>]+>)?\s*\(\s*host\s*,\s*['"]card\.followup\.add['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
        if (!/\breplace\s*:\s*true\b/.test(m[1])) {
          const line = code.slice(0, m.index).split('\n').length;
          violations.push(`${r}:${line}: card.followup.add missing replace: true`);
        }
      }
      for (const m of code.matchAll(/tryAction(?:<[^>]+>)?\s*\(\s*host\s*,\s*['"]note\.qa\.add['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
        if (!/\btitle\s*:/.test(m[1])) {
          const line = code.slice(0, m.index).split('\n').length;
          violations.push(`${r}:${line}: note.qa.add missing title`);
        }
      }
    }
    assert.deepEqual(violations, [], `AI followup/note persistence consistency violations:\n${violations.join('\n')}`);
  });

  test('[Cat 5: Local Persistence] Zero raw fs.rename() calls outside host/atomic-write.ts (#1383)', () => {
    const violations = [];
    for (const file of ALL_SRC_FILES) {
      const r = rel(file);
      if (r === 'host/atomic-write.ts') continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (/\bawait\s+rename\s*\(/.test(line)) {
          violations.push(`${r}:${idx + 1}: raw rename() bypasses Windows EBUSY/EPERM retry -> ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Found raw fs.rename() calls outside host/atomic-write.ts:\n${violations.join('\n')}`,
    );
  });

  test('[Cat 3 & 4 Runtime] ReaderNotesDrawer.savePageAskToNote passes replace:true and reports partial failure truthfully (#1380)', async () => {
    const { savePageAskToNote } = await import('../src/views/sources/ReaderNotesDrawer.tsx');
    const calls = [];
    const host = {
      mode: 'embedded',
      snapshot: async () => null,
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === 'materials.pages.cards') return { ok: true, value: { cards: [{ deckId: 'd1', cardId: 'c1' }] } };
        if (name === 'card.followup.add') return { ok: true, value: { item: { id: 'fu-1' } } };
        if (name === 'note.qa.add') return { ok: false, error: { message: 'Disk quota exceeded' } };
        return { ok: false, error: { message: 'unhandled' } };
      },
      stream: async () => {
        throw new Error('unused');
      },
      close: async () => {},
    };
    const res = await savePageAskToNote({
      host,
      lang: 'zh',
      title: 'OS 讲义',
      page: 5,
      sourceId: '',
      documentId: 'doc-1',
      pageText: '',
      question: '什么是页表？',
      answer: '页表映射虚拟页到物理页框。',
      course: '操作系统',
    });
    const fuCall = calls.find((c) => c.name === 'card.followup.add');
    assert.ok(fuCall, 'must call card.followup.add');
    assert.equal(fuCall.args.replace, true, 'must pass replace: true');
    assert.equal(res.ok, true, 'partial save (followup persisted) must report ok:true with warning');
    assert.ok(
      res.message.includes('关联题卡讲解') && res.message.includes('写入学习笔记失败'),
      `expected explicit partial-failure message, got: ${res.message}`,
    );
  });

  test('[Cat 4: Multi-Write Guard Runtime] NoteEditorModal and AddFocusModal deduplicate retries after step-1 success, and BoardView tracks editApplied (#1381, #1382)', async () => {
    // 1) NoteEditorModal: step-1 note.create succeeds, step-2 note.save fails once -> surfaces error & does NOT call onSaved;
    //    retrying Ctrl+S skips note.create (1 call total) and completes note.save.
    resetTuiStore();
    const { NoteEditorModal } = await import('../src/views/notes/NoteEditorModal.tsx');
    let noteCreateCalls = 0;
    let noteSaveCalls = 0;
    const savedNotes = [];
    const noteHost = {
      mode: 'embedded',
      snapshot: async () => null,
      call: async (name) => {
        if (name === 'deck.get') {
          return { ok: true, value: { id: 'd1', title: 'OS', course: 'OS', cards: [{ id: 'c1', prompt: '什么是页表？' }] } };
        }
        if (name === 'note.create') {
          noteCreateCalls += 1;
          return { ok: true, value: { id: 'note-1381', title: 'Page Table', revision: 1, markdown: '' } };
        }
        if (name === 'note.save') {
          noteSaveCalls += 1;
          if (noteSaveCalls === 1) return { ok: false, error: { message: 'Disk full' } };
          return { ok: true, value: { id: 'note-1381', title: 'Page Table', revision: 2, markdown: '# Page Table\n\nBody\n' } };
        }
        return { ok: true, value: {} };
      },
      stream: async () => {},
      close: async () => {},
    };
    const noteH = createInkHarness(
      React.createElement(NoteEditorModal, {
        mode: 'create',
        host: noteHost,
        lang: 'zh',
        availableDecks: [{ id: 'd1', title: 'OS', course: 'OS' }],
        terminalRows: 34,
        terminalCols: 108,
        onClose: () => {},
        onSaved: (n) => savedNotes.push(n),
      }),
    );
    try {
      await noteH.waitFor((s) => s.includes('什么是页表'), 4000, 'NoteEditorModal loaded candidate card');
      await new Promise((r) => setTimeout(r, 30));
      noteH.write('Page Table');
      await new Promise((r) => setTimeout(r, 30));
      // Tab x3: title -> query -> cards -> markdown
      noteH.write('\t');
      await new Promise((r) => setTimeout(r, 20));
      noteH.write('\t');
      await new Promise((r) => setTimeout(r, 20));
      noteH.write('\t');
      await new Promise((r) => setTimeout(r, 30));
      noteH.write('Body text');
      await new Promise((r) => setTimeout(r, 30));
      // Attempt 1: Ctrl+S -> note.create succeeds, note.save fails -> error shown, onSaved NOT called
      noteH.write('\x13');
      await noteH.waitFor((s) => s.includes('Disk full'), 4000, 'NoteEditorModal shows note.save failure');
      assert.equal(noteCreateCalls, 1, 'step-1 note.create called once on attempt 1');
      assert.equal(noteSaveCalls, 1, 'step-2 note.save called once on attempt 1');
      assert.equal(savedNotes.length, 0, 'must not silently call onSaved when note.save fails');

      // Attempt 2: retry Ctrl+S -> must NOT re-call note.create, only retries note.save
      noteH.write('\x13');
      const deadline = Date.now() + 4000;
      while (savedNotes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(savedNotes.length, 1, 'retry completes note.save and invokes onSaved');
      assert.equal(noteCreateCalls, 1, 'NoteEditorModal caches created note and does NOT duplicate note.create on retry');
      assert.equal(noteSaveCalls, 2);
    } finally {
      noteH.cleanup();
    }

    // 2) AddFocusModal: step-1 source.add succeeds, step-2 course.save fails once -> retry skips source.add.
    resetTuiStore({ snapshot: { courses: [], sources: [], decks: [] } });
    const { AddFocusModal } = await import('../src/views/examprep/AddFocusModal.tsx');
    let sourceAddCalls = 0;
    let courseSaveCalls = 0;
    let lastCourseSaveArgs = null;
    const savedCounts = [];
    const focusHost = {
      mode: 'embedded',
      snapshot: async () => null,
      getLibraryRoot: () => process.cwd(),
      call: async (name, args) => {
        if (name === 'source.add') {
          sourceAddCalls += 1;
          return { ok: true, value: { id: 'src-1381' } };
        }
        if (name === 'course.save') {
          courseSaveCalls += 1;
          lastCourseSaveArgs = args;
          if (courseSaveCalls === 1) return { ok: false, error: { message: 'Temporary save failure' } };
          return { ok: true, value: { id: 'course-1' } };
        }
        return { ok: true, value: {} };
      },
      stream: async () => {},
      close: async () => {},
    };
    const focusH = createInkHarness(
      React.createElement(AddFocusModal, {
        host: focusHost,
        course: 'OS',
        existingTopics: [],
        width: 100,
        isActive: true,
        onSaved: (n) => savedCounts.push(n),
        onClose: () => {},
      }),
    );
    try {
      await focusH.waitFor((s) => s.includes('OS'), 4000, 'AddFocusModal mounted');
      await new Promise((r) => setTimeout(r, 30));
      focusH.write('Paging; Deadlock');
      await new Promise((r) => setTimeout(r, 30));
      // Tab from multiline rawText input to single-line topics field, then Enter invokes onSubmit -> handleSave().
      focusH.write('\t');
      await new Promise((r) => setTimeout(r, 40));
      focusH.write('\r');
      await focusH.waitFor((s) => s.includes('参考资料已入库') && s.includes('Temporary save'), 4000, 'AddFocusModal surfaces course.save error');
      assert.equal(sourceAddCalls, 1, 'step-1 source.add called once on attempt 1');
      assert.equal(courseSaveCalls, 1, 'step-2 course.save called once on attempt 1');
      assert.equal(savedCounts.length, 0);

      focusH.write('\r');
      const deadline = Date.now() + 4000;
      while (savedCounts.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(savedCounts.length, 1, 'retry completes course.save and calls onSaved');
      assert.equal(sourceAddCalls, 1, 'AddFocusModal caches created sourceId and does NOT duplicate source.add on retry');
      assert.equal(courseSaveCalls, 2);
      assert.ok(lastCourseSaveArgs?.guidanceSourceIds?.includes('src-1381'), 'retry preserves cached sourceId in guidanceSourceIds');
    } finally {
      focusH.cleanup();
    }

    const boardView = fs.readFileSync(path.join(SRC_ROOT, 'views/board/BoardView.tsx'), 'utf8');
    assert.ok(
      boardView.includes('editApplied') && boardView.includes('board.card.move'),
      'BoardView must track editApplied so board.card.move failure does not double-edit or lose partial sync (#1382)',
    );
  });

  test('[Cat 5 Runtime] saveBoard refuses to overwrite corrupt tui-board.json by default and backs up when forced (#1383)', async (t) => {
    const { boardFilePath, emptyBoard, saveBoard } = await import('../src/views/board/board-store.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1383-board-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = boardFilePath(dir);
    const corruptRaw = '{"version":1,"cards":[BROKEN';
    await writeFile(filePath, corruptRaw, 'utf8');

    await assert.rejects(
      saveBoard(dir, emptyBoard()),
      /refusing to overwrite|could not be read/i,
      'saveBoard must refuse to silently overwrite corrupt tui-board.json',
    );
    assert.equal(await readFile(filePath, 'utf8'), corruptRaw, 'corrupt tui-board.json must remain untouched');

    await saveBoard(dir, emptyBoard(), { force: true });
    const files = await readdir(dir);
    const bak = files.find((f) => f.startsWith('tui-board.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(bak, `expected corrupt backup before forced overwrite; files=${files.join(', ')}`);
    assert.equal(await readFile(path.join(dir, bak), 'utf8'), corruptRaw);
  });

  test('[Cat 1: Round-2 Key Conflicts Runtime] ExamSetup, GenerateView, and CoachNudgeModal route k to view action without child scroll/list conflicts (#1385, #1386, #1387)', async () => {
    // 1) ExamSetup: no stale lowercase 'r 继续未交卷考试' hint; pressing 'k' cycles kinds without moving VirtualList scope cursor up.
    resetTuiStore();
    const { ExamSetup } = await import('../src/views/exam/ExamSetup.tsx');
    const examSnap = {
      root: '/tmp/lib',
      focus: { course: 'OS', courses: ['OS'] },
      decks: [
        { id: 'd1', title: 'Deck Alpha', course: 'OS', count: 10 },
        { id: 'd2', title: 'Deck Beta', course: 'OS', count: 10 },
      ],
      exams: [],
      oralExams: [],
    };
    let startedArgs = null;
    const examH = createInkHarness(
      React.createElement(ExamSetup, {
        snapshot: examSnap,
        width: 108,
        height: 32,
        lang: 'zh',
        isActive: true,
        busy: false,
        error: null,
        resumableRun: { id: 'run-open', title: 'Unfinished Mock', mode: 'exam' },
        onStart: (val, scope) => { startedArgs = { val, scope }; },
        onResume: () => {},
        onOpenHistory: () => {},
      }),
    );
    try {
      const initFrame = await examH.waitFor((s) => s.includes('全部题型') && s.includes('Deck Alpha'), 4000, 'ExamSetup rendered');
      assert.ok(!initFrame.includes('r 继续未交卷考试'), 'ExamSetup must not display stale lowercase r hint (#1385)');
      await new Promise((r) => setTimeout(r, 30));
      // Move scope selection down twice (All -> OS course -> Deck Alpha, or next item), then press 'k'.
      examH.write('\x1b[B');
      await new Promise((r) => setTimeout(r, 40));
      examH.write('k');
      await examH.waitFor((s) => s.includes('单双均衡'), 4000, 'ExamSetup k cycles written kinds');
      await new Promise((r) => setTimeout(r, 40));
      // Press Enter to confirm which scope is selected: must NOT have jumped back up to index 0!
      examH.write('\r');
      const deadline = Date.now() + 2000;
      while (!startedArgs && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(startedArgs, 'Enter starts exam');
      assert.equal(startedArgs.val.kinds, 'balanced', 'k cycled kinds to balanced');
      assert.notEqual(startedArgs.scope?.key, 'all', 'k must NOT move VirtualList scope cursor back up to index 0');
    } finally {
      examH.cleanup();
    }

    // 2) GenerateView: pressing 'k' cycles question kind without moving VirtualList source cursor up.
    const { GenerateView } = await import('../src/views/generate/GenerateView.tsx');
    const genSnap = {
      root: '/tmp/lib',
      focus: { course: '', courses: ['OS'] },
      courses: [{ id: 'c-os', name: 'OS' }],
      sources: [
        { id: 's1', title: 'Lecture 1 Intro', course: 'OS', archived: false },
        { id: 's2', title: 'Lecture 2 Paging', course: 'OS', archived: false },
      ],
      decks: [],
      drafts: [],
      jobs: [],
    };
    resetTuiStore({ snapshot: genSnap });
    const genHost = {
      mode: 'embedded',
      snapshot: async () => genSnap,
      call: async () => ({ ok: true, value: {} }),
      stream: async () => {},
      close: async () => {},
    };
    const genH = createInkHarness(
      React.createElement(GenerateView, {
        host: genHost,
        snapshot: genSnap,
        width: 108,
        height: 32,
        isActive: true,
        onRefresh: async () => {},
      }),
    );
    try {
      await genH.waitFor((s) => s.includes('Lecture 1 Intro') && s.includes('Lecture 2 Paging'), 4000, 'GenerateView rendered');
      await new Promise((r) => setTimeout(r, 40));
      // Move cursor to source #2 (Lecture 2 Paging), press 'k' to cycle kind, then press Space to toggle selection on cursor item.
      genH.write('\x1b[B');
      await new Promise((r) => setTimeout(r, 40));
      genH.write('k');
      await genH.waitFor((s) => s.includes('多选'), 4000, 'GenerateView k cycles question kind');
      await new Promise((r) => setTimeout(r, 40));
      genH.write(' ');
      const afterToggle = await genH.waitFor((s) => /(?:☑|\[(?:✓|x|\*)\])\s*(?:\[TEXT\]\s*)?Lecture 2 Paging/.test(s), 4000, 'GenerateView cursor stayed on Lecture 2 Paging after k');
      assert.match(afterToggle, /(?:☑|\[(?:✓|x|\*)\])\s*(?:\[TEXT\]\s*)?Lecture 2 Paging/, 'pressing k must not move VirtualList cursor up to Lecture 1');
    } finally {
      genH.cleanup();
    }

    // 3) CoachNudgeModal: pressing 'k' triggers coach.reply 'got' instead of being eaten by ScrollView.
    resetTuiStore();
    const { CoachNudgeModal } = await import('../src/views/review/CoachNudgeModal.tsx');
    const replyCalls = [];
    const coachHost = {
      mode: 'embedded',
      snapshot: async () => null,
      call: async (name, args) => {
        if (name === 'coach.reply') {
          replyCalls.push(args);
          return {
            ok: true,
            value: {
              thread: [{ id: 'nudge-1386', type: 'nudge', runId: 'run-1', entryIndex: 0, point: 'P', explain: 'E', reply: 'got' }],
            },
          };
        }
        return { ok: true, value: {} };
      },
      stream: async () => {},
      close: async () => {},
    };
    const coachH = createInkHarness(
      React.createElement(CoachNudgeModal, {
        host: coachHost,
        run: { id: 'run-1', index: 0, total: 1, card: { id: 'c1', topic: 'Paging', prompt: 'Q' } },
        cardId: 'c1',
        width: 92,
        height: 24,
        isActive: true,
        initialNote: {
          id: 'nudge-1386',
          type: 'nudge',
          runId: 'run-1',
          entryIndex: 0,
          point: '混淆虚拟地址与物理地址',
          explain: Array.from({ length: 16 }, (_, i) => `第 ${i + 1} 行详细解析说明。`).join('\n'),
        },
        onClose: () => {},
      }),
    );
    try {
      await coachH.waitFor((s) => s.includes('混淆虚拟地址'), 4000, 'CoachNudgeModal rendered');
      await new Promise((r) => setTimeout(r, 40));
      coachH.write('k');
      const deadline = Date.now() + 4000;
      while (replyCalls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(replyCalls.length, 1, 'pressing k in CoachNudgeModal must invoke coach.reply');
      assert.deepEqual(replyCalls[0], { noteId: 'nudge-1386', reply: 'got' });
    } finally {
      coachH.cleanup();
    }

    const wrongBook = fs.readFileSync(path.join(SRC_ROOT, 'views/wrongbook/WrongBookView.tsx'), 'utf8');
    assert.ok(
      /input\s*===\s*['"] ['"]\s*&&\s*activePane\s*===\s*['"]left['"]/.test(wrongBook),
      'WrongBookView Space multi-select must be gated to activePane === "left" (#1387)',
    );
  });

  test('[Cat 2: Scrollability] Scrollable MarkdownViews wire focus/scrollTop and ExamRunner wraps MCQ options (#1390)', () => {
    // Note: Modal.tsx raw useWindowSize ban (#1392) is enforced codebase-wide via TypeScript AST
    // in packages/studyhub-tui/tests/p4-release-docs-guard.test.mjs (test #1).
    const review = fs.readFileSync(path.join(SRC_ROOT, 'views/review/ReviewView.tsx'), 'utf8');
    assert.ok(
      /markdown=\{postAnswerMarkdown\}[\s\S]{0,240}isActive=\{(?:cardScopeActive|mainActive) && revealed\}/.test(review),
      'ReviewView postAnswerMarkdown MarkdownView must enable scrolling after reveal (#1390)',
    );

    const deckManage = fs.readFileSync(path.join(SRC_ROOT, 'views/library/DeckManageModal.tsx'), 'utf8');
    assert.ok(
      /markdown=\{previewMarkdown\}[\s\S]{0,240}scrollTop=\{previewScrollTop\}/.test(deckManage),
      'DeckManageModal preview MarkdownView must wire previewScrollTop (#1390)',
    );

    const examRunner = fs.readFileSync(path.join(SRC_ROOT, 'views/exam/ExamRunner.tsx'), 'utf8');
    assert.ok(
      !/truncateDisplay\s*\(\s*opt\.text/.test(examRunner),
      'ExamRunner MCQ options must wrap instead of truncating opt.text (#1390)',
    );
  });

  test('[Cat 3: AI Stream Abort] Every view calling host.streamComplete() passes an AbortController signal (#1393)', () => {
    const violations = [];
    for (const file of ALL_SRC_FILES) {
      const r = rel(file);
      if (r.startsWith('host/') || r.startsWith('types/')) continue;
      const code = fs.readFileSync(file, 'utf8');
      if (!/streamComplete\s*\(/.test(code)) continue;
      if (!/AbortController/.test(code) || !/\bsignal\s*:/.test(code)) {
        violations.push(`${r}: calls streamComplete() without AbortController signal`);
      }
    }
    assert.deepEqual(violations, [], `Streaming AI views missing AbortController cleanup:\n${violations.join('\n')}`);
  });

  test('[Cat 4: Round-2 Multi-Write] ModelsTab, DeckManageModal, and shell/actions handle step-2 failures truthfully (#1394)', () => {
    const modelsTab = fs.readFileSync(path.join(SRC_ROOT, 'views/settings/ModelsTab.tsx'), 'utf8');
    assert.ok(
      modelsTab.includes('reasoningEffort: openaiEffort') && !modelsTab.includes("'binding.set'"),
      'ModelsTab must save OpenAI config and reasoningEffort in one single atomic desktop.config.save write (#1394 / #1354 P3-b)',
    );
    const deckManage = fs.readFileSync(path.join(SRC_ROOT, 'views/library/DeckManageModal.tsx'), 'utf8');
    assert.ok(
      deckManage.includes("'draft.delete'"),
      'DeckManageModal must clean up orphan edit draft if draft.save fails during rename (#1394)',
    );
    const shellActions = fs.readFileSync(path.join(SRC_ROOT, 'shell/actions.ts'), 'utf8');
    assert.ok(
      shellActions.includes('focusRes') && shellActions.includes('!focusRes.ok'),
      'shell/actions.ts createCourse must inspect focus.set failure (#1394)',
    );
  });

  test('[Cat 5 Runtime] desktop config-store refuses to overwrite corrupt desktop.json by default and backs up when forced (#1388)', async (t) => {
    const { createConfigStore } = await import('../../studyhub-desktop/adapters/storage/config-store.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1388-cfg-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = createConfigStore({ env: { DSH_HOME: dir }, home: dir, documentsDir: path.join(dir, 'docs') });
    await fs.promises.mkdir(path.dirname(store.configPath), { recursive: true });
    const corruptRaw = '{"mode":"openai","openai":{"apiKey":"sk-secret"BROKEN';
    await writeFile(store.configPath, corruptRaw, 'utf8');

    await assert.rejects(
      store.save({ mode: 'openai' }),
      /refusing to overwrite|could not be read/i,
      'config-store.save must refuse to overwrite corrupt desktop.json',
    );
    await assert.rejects(
      store.confirmLibraryPlace(),
      /JSON|Unexpected|Expected/i,
      'config-store.confirmLibraryPlace must reject on corrupt desktop.json instead of overwriting with defaults',
    );
    assert.equal(await readFile(store.configPath, 'utf8'), corruptRaw, 'corrupt desktop.json must remain intact');

    await store.save({ mode: 'openai' }, { force: true });
    const files = await readdir(path.dirname(store.configPath));
    const bak = files.find((f) => f.startsWith('desktop.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(bak, `expected corrupt backup before forced overwrite; files=${files.join(', ')}`);
    assert.equal(await readFile(path.join(path.dirname(store.configPath), bak), 'utf8'), corruptRaw);
  });

  test('[Cat 5 Runtime] lib/update-check.js and lib/usage-frequency.js back up corrupt files before overwriting (#1389)', async (t) => {
    const [{ createUsageFrequency, usageFrequencyPath }, { setUpdatePreferences, updateStatePath }] = await Promise.all([
      import('../../../lib/usage-frequency.js'),
      import('../../../lib/update-check.js'),
    ]);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1389-persist-'));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    t.after(async () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      await rm(dir, { recursive: true, force: true });
    });

    // 1) lib/update-check.js: backs up corrupt update.json before persisting new preference.
    const updateTarget = updateStatePath();
    await fs.promises.mkdir(path.dirname(updateTarget), { recursive: true });
    const corruptUpdateRaw = '{"autoCheck":true,BROKEN';
    await writeFile(updateTarget, corruptUpdateRaw, 'utf8');

    const updatedView = await setUpdatePreferences({ autoCheck: false });
    assert.equal(updatedView.autoCheck, false, 'update-check must persist new preference cleanly after corrupt recovery');
    const updateFiles = await readdir(path.dirname(updateTarget));
    const updateBak = updateFiles.find((f) => f.startsWith('update.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(updateBak, `expected update.json.corrupt-*.bak backup; files=${updateFiles.join(', ')}`);
    assert.equal(await readFile(path.join(path.dirname(updateTarget), updateBak), 'utf8'), corruptUpdateRaw);
    assert.equal(JSON.parse(await readFile(updateTarget, 'utf8')).autoCheck, false);

    // 2) lib/usage-frequency.js: backs up corrupt usage-frequency.json before persisting new state.
    const target = usageFrequencyPath();
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const corruptRaw = '{"enabled":true,BROKEN';
    await writeFile(target, corruptRaw, 'utf8');

    const uf = createUsageFrequency();
    await uf.set({ enabled: true });
    const files = await readdir(path.dirname(target));
    const bak = files.find((f) => f.startsWith('usage-frequency.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(bak, `expected usage-frequency.json.corrupt-*.bak backup; files=${files.join(', ')}`);
    assert.equal(await readFile(path.join(path.dirname(target), bak), 'utf8'), corruptRaw);
  });
});
