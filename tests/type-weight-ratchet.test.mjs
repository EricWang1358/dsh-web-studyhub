import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  'ui/answer-card.css': { strong: 2, xs: 2 },
  'ui/app/app-shell.css': { strong: 0, xs: 1 },
  'ui/audio-dashboard.css': { strong: 3, xs: 15 },
  'ui/audio-import.css': { strong: 1, xs: 0 },
  'ui/audio-settings.css': { strong: 0, xs: 1 },
  'ui/base.css': { strong: 2, xs: 0 },
  'ui/blog-notes.css': { strong: 0, xs: 2 },
  'ui/board/board.css': { strong: 24, xs: 25 },
  'ui/book/book-ai.css': { strong: 1, xs: 0 },
  'ui/book/book-bar.css': { strong: 1, xs: 1 },
  'ui/book/book-confusables.css': { strong: 1, xs: 0 },
  'ui/book/book-kit.css': { strong: 1, xs: 0 },
  'ui/book/book-plan.css': { strong: 1, xs: 0 },
  'ui/book/book-sample.css': { strong: 1, xs: 0 },
  'ui/book/book-toc.css': { strong: 1, xs: 2 },
  'ui/book/book.css': { strong: 12, xs: 2 },
  'ui/canvas/canvas.css': { strong: 0, xs: 1 },
  'ui/case-result.css': { strong: 4, xs: 6 },
  'ui/case-study.css': { strong: 4, xs: 2 },
  'ui/charts/charts.css': { strong: 7, xs: 3 },
  'ui/coach.css': { strong: 2, xs: 0 },
  'ui/companions/companions.css': { strong: 2, xs: 5 },
  'ui/components/components.css': { strong: 18, xs: 0 },
  'ui/components/disclosure.css': { strong: 0, xs: 1 },
  'ui/components/feedback.css': { strong: 3, xs: 1 },
  'ui/components/fields.css': { strong: 3, xs: 0 },
  'ui/components/overlays.css': { strong: 3, xs: 2 },
  'ui/components/secret-key.css': { strong: 0, xs: 1 },
  'ui/components/select.css': { strong: 2, xs: 0 },
  'ui/course-active.css': { strong: 2, xs: 0 },
  'ui/course-field.css': { strong: 3, xs: 2 },
  'ui/course-method-card.css': { strong: 0, xs: 3 },
  'ui/course-settings.css': { strong: 3, xs: 0 },
  'ui/coverage/coverage.css': { strong: 4, xs: 12 },
  'ui/custom-readiness.css': { strong: 1, xs: 1 },
  'ui/daily-plan.css': { strong: 0, xs: 3 },
  'ui/DailyRecap.css': { strong: 0, xs: 4 },
  'ui/document-preview/document-preview.css': { strong: 6, xs: 1 },
  'ui/document-preview/links/links.css': { strong: 3, xs: 3 },
  'ui/document-preview/marks/marks.css': { strong: 2, xs: 1 },
  'ui/document-preview/original-file.css': { strong: 0, xs: 1 },
  'ui/document-preview/peek/peek.css': { strong: 0, xs: 1 },
  'ui/document-preview/practice/practice.css': { strong: 6, xs: 10 },
  'ui/document-preview/practice/section-practice.css': { strong: 0, xs: 2 },
  'ui/document-preview/reader/reader-slim.css': { strong: 4, xs: 1 },
  'ui/document-preview/reader/reader.css': { strong: 12, xs: 11 },
  'ui/document-preview/rename.css': { strong: 0, xs: 1 },
  'ui/document-preview/translation/translation.css': { strong: 6, xs: 8 },
  'ui/draft-shortfall.css': { strong: 1, xs: 0 },
  'ui/draft.css': { strong: 2, xs: 0 },
  'ui/exam-coach.css': { strong: 1, xs: 0 },
  'ui/exam-prep/exam-prep.css': { strong: 6, xs: 3 },
  'ui/exam-setup.css': { strong: 3, xs: 0 },
  'ui/exam.css': { strong: 1, xs: 0 },
  'ui/first-run/first-run.css': { strong: 4, xs: 0 },
  'ui/focus-intake.css': { strong: 1, xs: 1 },
  'ui/focus.css': { strong: 1, xs: 0 },
  'ui/followup.css': { strong: 1, xs: 0 },
  'ui/generate-form.css': { strong: 4, xs: 0 },
  'ui/generation-path.css': { strong: 0, xs: 1 },
  'ui/generation-transparency.css': { strong: 0, xs: 4 },
  'ui/graph.css': { strong: 1, xs: 8 },
  'ui/guided-study/guided-study.css': { strong: 2, xs: 4 },
  'ui/hand-off/hand-off.css': { strong: 1, xs: 2 },
  'ui/home-tiers.css': { strong: 1, xs: 0 },
  'ui/host/studyhub.css': { strong: 1, xs: 0 },
  'ui/import-hub.css': { strong: 1, xs: 0 },
  'ui/inbox-preview.css': { strong: 0, xs: 2 },
  'ui/inbox.css': { strong: 1, xs: 0 },
  'ui/jev.css': { strong: 9, xs: 2 },
  'ui/large-documents.css': { strong: 3, xs: 3 },
  'ui/live-class.css': { strong: 4, xs: 3 },
  'ui/manage.css': { strong: 1, xs: 0 },
  'ui/markdown.css': { strong: 4, xs: 2 },
  'ui/marker-install.css': { strong: 5, xs: 0 },
  'ui/mineru-install.css': { strong: 2, xs: 0 },
  'ui/mineru.css': { strong: 6, xs: 11 },
  'ui/oral-exam.css': { strong: 2, xs: 0 },
  'ui/outline/outline.css': { strong: 2, xs: 1 },
  'ui/review/question.css': { strong: 4, xs: 3 },
  'ui/review/session.css': { strong: 2, xs: 0 },
  'ui/review/source-split.css': { strong: 1, xs: 1 },
  'ui/review-results.css': { strong: 3, xs: 0 },
  'ui/settings.css': { strong: 6, xs: 3 },
  'ui/setup-checklist.css': { strong: 2, xs: 1 },
  'ui/shell.css': { strong: 4, xs: 1 },
  'ui/side-groups.css': { strong: 1, xs: 0 },
  'ui/skeleton.css': { strong: 13, xs: 13 },
  'ui/source-picker.css': { strong: 1, xs: 2 },
  'ui/sources.css': { strong: 0, xs: 1 },
  'ui/study-map/catalog.css': { strong: 4, xs: 0 },
  'ui/study-map/desk.css': { strong: 3, xs: 0 },
  'ui/study-map/next-step.css': { strong: 2, xs: 0 },
  'ui/task-card.css': { strong: 2, xs: 5 },
  'ui/tasks/compact-card.css': { strong: 1, xs: 1 },
  'ui/tasks/plan-table.css': { strong: 3, xs: 6 },
  'ui/tasks/request-trace.css': { strong: 2, xs: 4 },
  'ui/tasks/task-console.css': { strong: 10, xs: 31 },
  'ui/token-usage.css': { strong: 2, xs: 1 },
  'ui/tour/tour.css': { strong: 2, xs: 0 },
  'ui/update.css': { strong: 4, xs: 2 },
  'ui/usage.css': { strong: 3, xs: 1 },
  'ui/views.css': { strong: 4, xs: 0 },
  'ui/workflow-scope.css': { strong: 2, xs: 0 },
  'ui/workflows.css': { strong: 7, xs: 0 },
  'ui/wrongbook.css': { strong: 3, xs: 0 },
};

/* Files that open pull requests were still editing when the sweep ran (#1091, #1097). They keep their numbers until those merge, then follow up. */
const FOLLOW_UP = new Set([
  'ui/components/components.css', 'ui/focus-intake.css', 'ui/generate-form.css', 'ui/generate-home.css', 'ui/generation-transparency.css',
  'ui/source-picker.css', 'ui/course-active.css', 'ui/import-hub.css', 'ui/sources.css',
]);

test('--fw-medium is 500, not 550: the Han fallback fonts only have 400 and 700, and 550 rounds up to bold (#1079)', async () => {
  const tokens = await readFile(join(root, 'ui/tokens.css'), 'utf8');
  assert.match(tokens, /--fw-medium:\s*500;/, 'a medium of 500 is a real medium in Inter and the regular face in Microsoft YaHei; 550 draws every Han label as full bold');
  assert.match(tokens, /--fw-strong:\s*650;/);
  assert.match(tokens, /#1079/, 'the token says why (a comment that names #1079)');
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
