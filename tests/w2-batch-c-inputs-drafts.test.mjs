import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('W2-14: Board inline inputs guard IME on Esc, support Ctrl+Enter in memo edit, lock NewColumn, and use try/finally in Composer', () => {
  const composerSrc = read('ui/board/Composer.jsx');
  assert.match(composerSrc, /try \{\s*const parts = splitDraft\(raw\);[\s\S]*?\} finally \{\s*setSending\(false\);\s*\}/, 'Composer submit uses try/finally');
  assert.match(composerSrc, /event\.key === 'Escape' && !isImeComposing\(event\)/, 'Composer Esc guards IME');

  const memosSrc = read('ui/board/TodayMemos.jsx');
  assert.equal((memosSrc.match(/event\.nativeEvent\?\.isComposing \|\| event\.isComposing \|\| event\.keyCode === 229/g) || []).length, 2, 'TodayMemos guards IME in both new and edit textareas');
  assert.match(memosSrc, /submitEdit\(event, memo\)/, 'TodayMemos edit textarea supports Ctrl/Cmd+Enter submit');

  const boardSrc = read('ui/Board.jsx');
  assert.match(boardSrc, /event\.key === "Escape" && !\(event\.nativeEvent\?\.isComposing \|\| event\.isComposing \|\| event\.keyCode === 229\)/, 'Column rename Esc guards IME');
  assert.match(boardSrc, /const \[submitting, setSubmitting\] = useState\(false\);/, 'NewColumn tracks submitting state');
  assert.match(boardSrc, /busy=\{submitting\} disabled=\{!name\.trim\(\)\}/, 'NewColumn submit button uses busy lock');
  assert.match(boardSrc, /lock=\{submitting\}/, 'NewColumn cancel button uses lock');
});

test('W2-15: BookEditor preserves concurrent typing during save, locks editor during revert, and restores version on discard', () => {
  const src = read('ui/book/BookEditor.jsx');
  assert.match(src, /const submitted = draft;/, 'save snapshots submitted draft text');
  assert.match(src, /if \(kept && \(submitted === null \|\| typed\.current === submitted\)\) setDraft\(base\.current\.text\);/, 'settle preserves newer typing made during async save');
  assert.match(src, /base\.current = \{ file, version: book\.files\[file\]\?\.version \?\? 0, text: fileText\(book, file\) \};\s*setDraft\(base\.current\.text\);/, '放弃改动 restores base.current.version to server version');
  assert.match(src, /readOnly=\{reverting\}/, 'CodeMirror is readOnly while reverting');
});

test('W2-03: ExamCoachPage uses string drafts for numbers and persists Step 3 edits on add/delete family and stage switch', () => {
  const src = read('ui/ExamCoachPage.jsx');
  assert.match(src, /const \[remainingDraft, setRemainingDraft\] = useState\(null\);/, 'uses local string draft for remainingMinutes');
  assert.match(src, /const \[quotaDrafts, setQuotaDrafts\] = useState\(\{\}\);/, 'uses local string drafts for family quota');
  assert.match(src, /const \[timeDrafts, setTimeDrafts\] = useState\(\{\}\);/, 'uses local string drafts for family timeBudgetSec');
  assert.match(src, /function resolveSpecWithDrafts/, 'merges unblurred numeric drafts before saving');
  assert.doesNotMatch(src, /operations:\s*\[\{\s*type:\s*'(?:add|delete)'/, 'add/delete family saves merged taskFamilies instead of wiping pending edits via operations');
  assert.match(src, /const leavingConfigure = stage === 'configure' && configureDirty;/, 'stage switch flushes pending Step 3 edits');
});

test('W2-16: CaseWorkspace uses local drafts for CriteriaEditor keyPoints/marks and CasePaper numeric settings', () => {
  const src = read('ui/CaseWorkspace.jsx');
  assert.match(src, /const \[readingDraft, setReadingDraft\] = useState\(null\);/, 'CasePaper keeps readingMinutes string draft');
  assert.match(src, /const \[perMarkDraft, setPerMarkDraft\] = useState\(null\);/, 'CasePaper keeps minutesPerMark string draft');
  assert.match(src, /const finalPerMark = perMarkDraft !== null/, 'CasePaper start() flushes unblurred drafts');
  assert.match(src, /const \[keyPointDrafts, setKeyPointDrafts\] = useState\(\{\}\);/, 'CriteriaEditor keeps raw keyPoints string draft');
  assert.match(src, /const \[markDrafts, setMarkDrafts\] = useState\(\{\}\);/, 'CriteriaEditor keeps marks string draft');
});

test('W2-17: GenerationTransparency preserves raw typing spaces/newlines and allows clearing quota inputs before blur', () => {
  const src = read('ui/GenerationTransparency.jsx');
  assert.match(src, /const \[quotaDrafts, setQuotaDrafts\] = React\.useState\(\{\}\);/, 'keeps per-kind quota string drafts');
  assert.match(src, /const \[moduleDrafts, setModuleDrafts\] = React\.useState\(\{\}\);/, 'keeps module instruction string drafts');
  assert.match(src, /const \[templateDraft, setTemplateDraft\] = React\.useState\(null\);/, 'keeps templateName string draft');
  assert.match(src, /if \(raw !== ''\) updateKindQuota\(k, raw\);/, 'clearing quota input does not immediately snap to 0');
});

test('W2-18: BlogNotes decouples CSDN copy from focus theft, demotes NoteDraft primary while editing, guards card leave, and locks actions', () => {
  const blogSrc = read('ui/BlogNotes.jsx');
  assert.match(blogSrc, /catch \(error\) \{ if \(live\(\)\) toast\.error\(errorMessage\(error\)\); \}/, 'perform formats errors with errorMessage');
  assert.match(blogSrc, /demotePrimary=\{editing \|\| dirty\}/, 'demotes NoteDraft primary button while editing/dirty');
  assert.match(blogSrc, /草稿已保存并打开 CSDN，但未能自动复制内容，请手动复制 Markdown。\{0\}/, 'CSDN flow still opens tab and informs user if clipboard fails');
  assert.match(blogSrc, /onClick=\{\(\) => guardLeave\(\(\) => onOpenCard\(ref\)\)\}/, 'related card jump uses guardLeave');
  assert.match(blogSrc, /disabled=\{!home\.trim\(\)\} lock=\{busy\}/, 'save CSDN home validates non-empty and locks while busy');
  assert.match(blogSrc, /disabled=\{!newTitle\.trim\(\) \|\| !picked\.length\} lock=\{busy\}/, 'create note draft locks while busy');

  const draftSrc = read('ui/NoteDraft.jsx');
  assert.match(draftSrc, /variant=\{demotePrimary \? 'secondary' : 'primary'\}/, 'NoteDraft demotes button variant when demotePrimary is true');
});
