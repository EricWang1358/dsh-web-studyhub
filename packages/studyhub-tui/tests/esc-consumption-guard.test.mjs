// Static guardrail for #1429 (follow-up of the #1429/#1438/#1446 review):
// A legacy `useScopedInput as useInput` handler that branches on `key.escape` MUST declare
// consumption by returning `true`. A bare `return;` reports "not handled", so the same
// keystroke continues down the dispatcher to the shell's global Esc handler, which folds the
// docked-but-unfocused assistant panel — i.e. one Esc both clears a page filter AND hides
// the dock.
//
// Rule enforced here: for every if-statement in src/**/*.tsx whose condition inspects
// `key.escape`, the trailing statement of its then-branch must be `return true`.
// Run: node --test tests/esc-consumption-guard.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

function listSources(dir = SRC_ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every Esc-handling if-branch that ends in a bare `return;`, per file. */
export function findUnconsumedEscBranches() {
  const violations = [];
  for (const file of listSources()) {
    const code = fs.readFileSync(file, 'utf8');
    if (!code.includes('key.escape')) continue;
    const sf = ts.createSourceFile(
      file,
      code,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isIfStatement(node) && /\bkey\.escape\b/.test(node.expression.getText(sf))) {
        const body = node.thenStatement;
        if (ts.isBlock(body)) {
          const last = body.statements[body.statements.length - 1];
          if (last && ts.isReturnStatement(last) && !last.expression) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            violations.push(`${path.relative(SRC_ROOT, file)}:${line} → ${node.expression.getText(sf).replace(/\s+/g, ' ')}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

// The pages/subcomponents named in the review. Kept explicit so a regression is reported by name
// and this guardrail can never pass vacuously.
const REVIEWED_ESC_SITES = [
  'views/audio/AudioView.tsx',
  'views/book/BookView.tsx',
  'views/dashboard/DashboardView.tsx',
  'views/examcoach/ExamCoachView.tsx',
  'views/examprep/ExamPrepView.tsx',
  'views/generate/DraftEditor.tsx',
  'views/generate/GenerateView.tsx',
  'views/notes/NotesView.tsx',
  'views/skeleton/SkeletonView.tsx',
  'views/tasks/TasksView.tsx',
  'views/wrongbook/WrongBookView.tsx',
  'views/sources/DocumentReader.tsx',
  'views/review/RoundSummary.tsx',
  'views/review/NextStepFollowupBar.tsx',
  'views/settings/ModelsTab.tsx',
];

describe('#1429 Esc consumption guardrail (legacy useInput handlers)', () => {
  test('every `key.escape` if-branch in src/ ends in `return true` (declares consumption)', () => {
    const violations = findUnconsumedEscBranches();
    assert.deepEqual(
      violations,
      [],
      `Esc branches must return true, otherwise the key also reaches the shell's dock-folding handler:\n  ${violations.join('\n  ')}`,
    );
  });

  test('all sites named in the review are really covered by the rule (non-vacuous)', () => {
    const missing = [];
    for (const rel of REVIEWED_ESC_SITES) {
      const full = path.join(SRC_ROOT, rel);
      assert.ok(fs.existsSync(full), `${rel} must exist`);
      const code = fs.readFileSync(full, 'utf8');
      if (!code.includes('key.escape')) missing.push(rel);
    }
    assert.deepEqual(missing, [], `these files no longer branch on key.escape, so the guardrail is vacuous for them: ${missing.join(', ')}`);
  });

  test('DraftEditor keeps a single Ctrl+S save path shared by the modal footer and both multi-line inputs', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'views/generate/DraftEditor.tsx'), 'utf8');
    assert.match(src, /const saveEditCard = useCallback/, 'DraftEditor must extract saveEditCard()');
    const editCardSection = src.slice(src.indexOf("overlay === 'edit-card' && selectedCard"));
    const inputsWithSubmit = editCardSection.match(/onSubmit=\{saveEditCard\}/g) ?? [];
    assert.equal(inputsWithSubmit.length, 2, 'both edit-card multi-line TextInputs must pass onSubmit={saveEditCard}');
  });
});
