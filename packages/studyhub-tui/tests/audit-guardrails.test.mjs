// Permanent automated static guardrails for the 5-category systematic TUI audit (#1374-#1383).
// Every check scans packages/studyhub-tui/src/ so regressions immediately fail CI.
// node --test tests/audit-guardrails.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

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

  test('[Cat 1: Key Conflicts] AiHelpDrawer uses opaque capture and modal footer hints (#1376)', () => {
    const code = fs.readFileSync(path.join(SRC_ROOT, 'views/review/AiHelpDrawer.tsx'), 'utf8');
    assert.ok(code.includes('useModalFooterHints('), 'AiHelpDrawer must register its hints via useModalFooterHints');
    assert.ok(/useInputCapture\s*\(\s*true\s*\)/.test(code), 'AiHelpDrawer must hold opaque useInputCapture(true) while mounted');
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

  test('[Cat 2: Truncation] Zero truncateDisplay() calls slicing error messages (#1354 D5, #1379)', () => {
    const violations = [];
    for (const file of ALL_SRC_FILES) {
      const r = rel(file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (/truncateDisplay\s*\(\s*(?:error|errorText|errorMsg|subError|failure)\b/.test(line)) {
          violations.push(`${r}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Found error messages truncated via truncateDisplay() (wrap errors with wrap="wrap" instead):\n${violations.join('\n')}`,
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

  test('[Cat 4: Multi-Write Guard] NoteEditorModal, AddFocusModal, and BoardView deduplicate retries after step-1 success (#1381, #1382)', () => {
    const noteEditor = fs.readFileSync(path.join(SRC_ROOT, 'views/notes/NoteEditorModal.tsx'), 'utf8');
    assert.ok(noteEditor.includes('createdNoteRef'), 'NoteEditorModal must cache created note across retries (#1381)');
    assert.ok(
      /if\s*\(\s*!saveRes\.ok\s*\|\|\s*!saveRes\.value\s*\)/.test(noteEditor),
      'NoteEditorModal must surface note.save failure instead of silently calling onSaved (#1381)',
    );

    const addFocus = fs.readFileSync(path.join(SRC_ROOT, 'views/examprep/AddFocusModal.tsx'), 'utf8');
    assert.ok(addFocus.includes('createdSourceIdRef'), 'AddFocusModal must cache created sourceId across retries (#1381)');

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
});
