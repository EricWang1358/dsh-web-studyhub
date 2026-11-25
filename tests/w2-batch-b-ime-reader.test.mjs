import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keysElsewhere } from '../ui/review/session-logic.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('W2-11: usePinQuestion does not steal focus from [data-own-keys] regions on feedback arrival', () => {
  const pinSrc = read('ui/review/usePinQuestion.js');
  assert.match(pinSrc, /import \{ keysElsewhere \} from "\.\/session-logic\.js";/, 'imports keysElsewhere');
  assert.match(pinSrc, /if \(keysElsewhere\(active, reviewBodyRef\.current\)\) return;/, 'checks keysElsewhere before focusing feedback');

  // Verify keysElsewhere directly with synthetic DOM-like objects
  const readerPane = { contains: () => false };
  const activeInReader = { closest: (sel) => (sel.includes('[data-own-keys]') ? readerPane : null) };
  assert.equal(keysElsewhere(activeInReader, {}), true, 'focus in split reader counts as elsewhere');

  const reviewOwner = { contains: () => true };
  const activeInInlineQuestion = { closest: () => reviewOwner };
  assert.equal(keysElsewhere(activeInInlineQuestion, {}), false, 'focus inside inline question is not elsewhere');
});

test('W2-05: CoachSection guards IME, clears drafts only on confirmed save, and keeps duplicate preference text', () => {
  const src = read('ui/settings/CoachSection.jsx');
  assert.match(src, /const isImeComposing = \(event\) => Boolean\(event\.nativeEvent\?\.isComposing \|\| event\.isComposing \|\| event\.keyCode === 229\);/);
  assert.equal((src.match(/if \(isImeComposing\(event\)\) return;/g) || []).length, 3, 'all 3 CoachSection inputs guard IME');
  assert.match(src, /setPreferences\(\[\.\.\.preferences, trimmedDraft\], \(\) => setDraftPref\(''\)\)/, 'draftPref cleared only in success callback');
  assert.match(src, /addBullet\(\{[\s\S]*?refs: \[\] \}, \(\) => setDraftBullet\(''\)\)/, 'draftBullet cleared only in success callback');
  assert.match(src, /updateBullet\(\{ id: editingId, text: trimmedEdit \}, \(\) => cancelEdit\(\)\)/, 'edit mode closed only in success callback');
  assert.match(src, /if \(preferences\.includes\(trimmedDraft\)\) \{\s*setPrefHint\(ui\('这条偏好已经记过了。'\)\);\s*return;\s*\}/, 'duplicate preference preserves input with hint');
});

test('W2-06: DocumentLearning askInside returns false on refusal so FollowUp preserves user input', () => {
  const docSrc = read('ui/document-preview/DocumentLearning.jsx');
  assert.match(docSrc, /if \(plan\.action === 'refuse'\) \{ const why = refusal\(plan\.reason\); say\(why\.text, why\.why\); return false; \}/, 'askInside returns false on refusal');
  assert.match(docSrc, /if \(!text\.trim\(\)\) return false;/, 'askInside returns false on blank text');

  const threadSrc = read('ui/document-preview/AskThread.jsx');
  assert.match(threadSrc, /if \(onAsk\(\{ parentId: node\.id, question: trimmed \}\) !== false\) setText\(''\);/, 'FollowUp clears input only when onAsk does not refuse');
});

test('W2-07: useReaderMarks isolates batch cleanup errors from generate success and QueueChip restores focus in compact mode', () => {
  const marksSrc = read('ui/document-preview/marks/useReaderMarks.jsx');
  assert.match(marksSrc, /const job = await call\('generate', request\);\s*await onBatchStarted\?\.\(job\);\s*try \{\s*await marksCall\('delete'/, 'startBatch notifies onBatchStarted before cleanup and catches delete errors');
  assert.match(marksSrc, /但待出题清单没能清空/, 'warns when queue cleanup fails after generate succeeds');
  assert.match(marksSrc, /const dismissStaleMark = async id => \{\s*if \(!id\) return;\s*try \{/, 'dismissStaleMark catches errors');
  assert.match(marksSrc, /const remove = async ids => \{\s*if \(!ids\.length\) return;\s*try \{/, 'remove catches errors');

  const popSrc = read('ui/components/Popover.jsx');
  assert.match(popSrc, /returnFocusRef/, 'Popover accepts returnFocusRef');
  assert.match(popSrc, /returnFocusRef\?\.current \|\| triggerRef\.current/, 'Popover falls back to returnFocusRef');

  const chipSrc = read('ui/document-preview/marks/QueueChip.jsx');
  assert.match(chipSrc, /returnFocusRef=\{compactReturnFocusRef\}/, 'QueueChip passes compact focus fallback ref');
});

test('W2-12: BookAsk and BookSelectBar guard IME and adapt desktop tooltip copy via hasChatHost', () => {
  const askSrc = read('ui/book/BookAsk.jsx');
  assert.match(askSrc, /hasChatHost\(host\)/, 'BookAsk checks hasChatHost');
  assert.match(askSrc, /写进这个知识点，或复制提示词/, 'BookAsk provides desktop copy-prompt tooltip');
  assert.match(askSrc, /event\.nativeEvent\?\.isComposing \|\| event\.isComposing \|\| event\.keyCode === 229/, 'AskForm Ctrl+Enter guards IME');
  assert.match(askSrc, /event\.key === 'Escape' && !event\.defaultPrevented && !event\.isComposing && event\.keyCode !== 229/, 'BookAsk Esc guards IME');

  const barSrc = read('ui/book/BookSelectBar.jsx');
  assert.match(barSrc, /hasChatHost\(studyHost\)/, 'BookSelectBar checks hasChatHost');
  assert.match(barSrc, /先配置模型才能弄懂；复制提示词不需要模型。/, 'BookSelectBar provides desktop copy-prompt tooltip');
  assert.match(barSrc, /event\.isComposing \|\| event\.keyCode === 229/, 'BookSelectBar Esc guards IME');
});

test('W2-13: BookToc Esc guards IME and open dialogs/overlays in both search box and slide-over', async () => {
  const tocSrc = read('ui/book/BookToc.jsx');
  assert.match(tocSrc, /event\.defaultPrevented \|\| event\.nativeEvent\?\.isComposing \|\| event\.isComposing \|\| event\.keyCode === 229/, 'handleSearchKeyDown guards IME and defaultPrevented');
  assert.match(tocSrc, /document\.querySelector\('dialog\[open\], \[role="dialog"\], \.sh-pop__popup:not\(\[data-closed\]\), \.sh-menu, \.sh-popover'\)/, 'narrow BookToc Esc yields to open dialogs/overlays');
});
