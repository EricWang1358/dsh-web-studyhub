import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { parseTree, walkTree } from '../scripts/qa/css-tools.mjs';
import { typeCounts } from '../scripts/qa/type-weight-counts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/* #1079: 313 strong declarations (650) and a medium (550) that the Han fallback fonts draw as full bold left every label, row title and caption
   at one weight, and the small 12px type carried whole sentences. The rule (ui/DESIGN.md › Type):
     strong  = a page title, a card or section title, the one number a block is about;
     medium  = a row title, a field label, a tab, a button;
     regular = a description, meta, a counts sentence, a hint.
     size    = explanatory text is --fs-sm (13px) or more; --fs-xs (12px) is for badges, key caps, counts and dense tables.
   This test counts both per CSS file and lets the numbers only fall. */

/* Today's count, file by file (only files with something left to lower). Lower a number when you sweep; never raise one. Files that are not here
   have a strong count of 0 and a small-type count of 0. */
const BASELINE = {
  'ui/audio-dashboard.css': { strong: 1, xs: 0 },
  'ui/base.css': { strong: 4, xs: 0 },
  'ui/board/board.css': { strong: 15, xs: 0 },
  'ui/book/book-ai.css': { strong: 1, xs: 0 },
  'ui/book/book-bar.css': { strong: 1, xs: 0 },
  'ui/book/book-confusables.css': { strong: 1, xs: 0 },
  'ui/book/book-plan.css': { strong: 1, xs: 0 },
  'ui/book/book-sample.css': { strong: 1, xs: 0 },
  'ui/book/book.css': { strong: 3, xs: 0 },
  'ui/case-result.css': { strong: 1, xs: 0 },
  'ui/charts/charts.css': { strong: 2, xs: 0 },
  'ui/coach.css': { strong: 2, xs: 0 },
  'ui/companions/companions.css': { strong: 2, xs: 0 },
  'ui/components/components.css': { strong: 11, xs: 0 },
  'ui/components/feedback.css': { strong: 1, xs: 0 },
  'ui/components/fields.css': { strong: 2, xs: 0 },
  'ui/components/overlays.css': { strong: 1, xs: 0 },
  'ui/course-settings.css': { strong: 1, xs: 0 },
  'ui/coverage/coverage.css': { strong: 1, xs: 0 },
  'ui/custom-readiness.css': { strong: 1, xs: 0 },
  'ui/daily-plan.css': { strong: 2, xs: 0 },
  'ui/document-preview/links/links.css': { strong: 1, xs: 0 },
  'ui/document-preview/marks/marks.css': { strong: 1, xs: 0 },
  'ui/document-preview/practice/practice.css': { strong: 2, xs: 0 },
  'ui/document-preview/reader/reader-slim.css': { strong: 1, xs: 0 },
  'ui/document-preview/reader/reader.css': { strong: 5, xs: 0 },
  'ui/document-preview/translation/translation.css': { strong: 2, xs: 0 },
  'ui/draft.css': { strong: 1, xs: 0 },
  'ui/exam-coach.css': { strong: 1, xs: 0 },
  'ui/exam-prep/exam-prep.css': { strong: 2, xs: 0 },
  'ui/exam-setup.css': { strong: 1, xs: 0 },
  'ui/first-run/first-run.css': { strong: 1, xs: 0 },
  'ui/focus-intake.css': { strong: 1, xs: 0 },
  'ui/focus.css': { strong: 1, xs: 0 },
  'ui/followup.css': { strong: 1, xs: 0 },
  'ui/generate-form.css': { strong: 1, xs: 0 },
  'ui/guided-study/guided-study.css': { strong: 4, xs: 0 },
  'ui/home-tiers.css': { strong: 1, xs: 0 },
  'ui/host/studyhub.css': { strong: 1, xs: 0 },
  'ui/jev.css': { strong: 3, xs: 0 },
  'ui/markdown.css': { strong: 3, xs: 0 },
  'ui/marker-install.css': { strong: 3, xs: 0 },
  'ui/mineru-install.css': { strong: 2, xs: 0 },
  'ui/mineru.css': { strong: 2, xs: 0 },
  'ui/oral-exam.css': { strong: 1, xs: 0 },
  'ui/outline/outline.css': { strong: 1, xs: 0 },
  'ui/review/question.css': { strong: 3, xs: 0 },
  'ui/review/session.css': { strong: 1, xs: 0 },
  'ui/review/source-split.css': { strong: 1, xs: 0 },
  'ui/review-results.css': { strong: 1, xs: 0 },
  'ui/settings.css': { strong: 1, xs: 0 },
  'ui/setup-checklist.css': { strong: 1, xs: 0 },
  'ui/shell.css': { strong: 3, xs: 0 },
  'ui/skeleton.css': { strong: 6, xs: 0 },
  'ui/study-map/catalog.css': { strong: 2, xs: 0 },
  'ui/study-map/next-step.css': { strong: 1, xs: 0 },
  'ui/task-card.css': { strong: 1, xs: 0 },
  'ui/tasks/compact-card.css': { strong: 1, xs: 0 },
  'ui/tasks/plan-table.css': { strong: 1, xs: 0 },
  'ui/tasks/task-console.css': { strong: 4, xs: 0 },
  'ui/token-usage.css': { strong: 1, xs: 0 },
  'ui/tour/tour.css': { strong: 1, xs: 0 },
  'ui/update.css': { strong: 1, xs: 0 },
  'ui/views.css': { strong: 2, xs: 0 },
  'ui/workflows.css': { strong: 1, xs: 0 },
  'ui/wrongbook.css': { strong: 2, xs: 0 },
};

test('--fw-medium is 500, not 550: the Han fallback fonts only have 400 and 700, and 550 rounds up to bold (#1079)', async () => {
  const tokens = await readFile(join(root, 'ui/tokens.css'), 'utf8');
  const { declarations } = parseCss(tokens);
  const fwMedium = declarations.filter((d) => d.prop === '--fw-medium');
  const fwStrong = declarations.filter((d) => d.prop === '--fw-strong');
  assert.deepEqual(fwMedium.map((d) => d.value), ['500'], 'a medium of 500 is a real medium in Inter and the regular face in Microsoft YaHei; 550 draws every Han label as full bold');
  assert.deepEqual(fwStrong.map((d) => d.value), ['650']);
  const tree = parseTree(tokens, { comments: true });
  const mediumComments = [];
  walkTree(tree, (node) => {
    if (node.kind === 'rule' && node.decls.some((d) => d.prop === '--fw-medium')) {
      for (const child of node.children) {
        if (child.kind === 'comment') mediumComments.push(child.prelude);
      }
    }
  });
  assert.ok(mediumComments.some((comment) => /#1079/.test(comment)), 'the token says why (a comment next to --fw-medium that names #1079)');
});

test('strong weight and small type may only fall, file by file (#1079)', async (t) => {
  const { files, total } = await typeCounts();
  for (const [file, row] of Object.entries(files)) {
    const base = BASELINE[file] || { strong: 0, xs: 0 };
    assert.ok(row.strong <= base.strong, `${file}: ${row.strong} --fw-strong, baseline ${base.strong}. A title is strong; a row title, label, tab or button is --fw-medium; a description is --fw-regular (ui/DESIGN.md › Type).`);
    assert.ok(row.xs <= base.xs, `${file}: ${row.xs} --fs-xs on a non-badge selector, baseline ${base.xs}. Explanatory text is --fs-sm (13px) or more (ui/DESIGN.md › Type).`);
  }
  for (const file of Object.keys(BASELINE)) assert.ok(files[file], `${file} is in the baseline but is not a stylesheet any more: delete the entry`);
  t.diagnostic(`strong ${total.strong}, medium ${total.medium}, regular ${total.regular}, xs on non-badge selectors ${total.xs}`);
});

test('strong is under half of the 313 of 2026-11-17 (#1079)', async (t) => {
  const { total } = await typeCounts();
  t.diagnostic(`strong ${total.strong}; the target is under ${Math.ceil(313 / 2)}`);
  assert.ok(total.strong < Math.ceil(313 / 2), `strong is ${total.strong}; the stylesheet set has to stay under ${Math.ceil(313 / 2)}`);
});
