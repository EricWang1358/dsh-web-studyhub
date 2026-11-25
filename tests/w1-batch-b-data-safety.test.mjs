import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { default as CardEditor, finalizeCardFields, isCardEditorDirty } from './ui/board/CardEditor.jsx';
  export { reconcileFocusTopicsOnCourseChange } from './ui/FocusIntakeDialog.jsx';
  export { mergePendingRuleDraft } from './ui/course-rules/CourseRulesEditor.jsx';
  export { mergePendingNotationDraft } from './ui/course-rules/CourseNotationEditor.jsx';
  export { default as CourseSettingsDialog } from './ui/CourseSettings.jsx';
  export { publishAndPractice, readRecoveryMap, putDraftStash, dropDraftStash, pickRecoveryFor } from './ui/app/use-drafts.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

/* ---------- W1-03: CardEditor saves pending checklist item & label inputs ---------- */

test('W1-03: CardEditor counts pending checklist itemInput / labelInput as dirty and includes them on save', () => {
  const card = { id: 'c1', title: '复习 OS', note: '', due: '', plannedDate: '', labels: ['OS'], checklist: [{ id: 'i1', text: '看第1章', done: false }] };
  const draft = { title: '复习 OS', note: '', due: '', plannedDate: '', labels: ['OS'], checklist: [{ id: 'i1', text: '看第1章', done: false }] };

  assert.equal(m.isCardEditorDirty({ draft, card, itemInput: '', labelInput: '' }), false);
  assert.equal(m.isCardEditorDirty({ draft, card, itemInput: '做课后题', labelInput: '' }), true, 'pending checklist text makes editor dirty');
  assert.equal(m.isCardEditorDirty({ draft, card, itemInput: '', labelInput: '期中' }), true, 'pending label text makes editor dirty');

  const fields = m.finalizeCardFields({ draft, card, itemInput: '  做课后题  ', labelInput: '期中, 重点' });
  assert.deepEqual(fields.labels, ['OS', '期中', '重点']);
  assert.equal(fields.checklist.length, 2);
  assert.equal(fields.checklist[1].text, '做课后题');
  assert.equal(fields.checklist[1].done, false);
});

/* ---------- W1-06: FocusIntakeDialog preserves newly entered/extracted topics across course edits ---------- */

test('W1-06: reconcileFocusTopicsOnCourseChange keeps newly added/extracted topics without leaking old course topics', () => {
  // User typed/extracted topics while course was empty, then starts typing a new course name "OS"
  const afterTypingName = m.reconcileFocusTopicsOnCourseChange({
    topicsText: '死锁避免; 虚拟内存',
    previousExisting: [],
    nextExisting: [],
  });
  assert.deepEqual(afterTypingName.merged, ['死锁避免', '虚拟内存']);
  assert.equal(afterTypingName.addedCount, 2);

  // User started on Course A (which had "进程调度"), added "死锁避免", then switched to Course B (which has "B+树")
  const afterSwitchingCourse = m.reconcileFocusTopicsOnCourseChange({
    topicsText: '进程调度; 死锁避免',
    previousExisting: ['进程调度'],
    nextExisting: ['B+树'],
  });
  assert.deepEqual(afterSwitchingCourse.merged, ['B+树', '死锁避免'], 'keeps newly added topic and merges into Course B without leaking Course A existing topics');
  assert.equal(afterSwitchingCourse.addedCount, 1);
});

/* ---------- W1-08 & W1-29: CourseRules/Notation pending draft merge & CourseSettings merge primary/guard ---------- */

test('W1-08: mergePendingRuleDraft & mergePendingNotationDraft merge valid pending inputs and flag invalid incomplete drafts', () => {
  const rOk = m.mergePendingRuleDraft(['守则1'], '  题干必须带场景  ');
  assert.equal(rOk.status, 'merged');
  assert.deepEqual(rOk.next, ['守则1', '题干必须带场景']);

  const rDup = m.mergePendingRuleDraft(['守则1'], '守则1');
  assert.equal(rDup.status, 'invalid');

  const nOk = m.mergePendingNotationDraft([], { canonical: '一致收敛', symbol: '=>', aliases: 'uniform', meaning: '一致逼近' });
  assert.equal(nOk.status, 'merged');
  assert.equal(nOk.next.length, 1);
  assert.equal(nOk.next[0].canonical, '一致收敛');

  const nMissingName = m.mergePendingNotationDraft([], { canonical: '', symbol: '=>', aliases: '', meaning: '说明' });
  assert.equal(nMissingName.status, 'invalid', 'non-empty notation fields missing canonical name must be flagged, not silently dropped');
});

test('W1-29: CourseSettingsDialog opened with mergeFrom has single primary CTA and guards pending mergeIds', async () => {
  m.setUiLanguage('zh');
  const courses = [
    { id: 'c1', name: '操作系统', exam: {}, focusTopics: [] },
    { id: 'c2', name: '操作系统（旧）', exam: {}, focusTopics: [] },
  ];
  const html = renderToStaticMarkup(withServices(h(m.CourseSettingsDialog, {
    courseId: 'c1',
    mergeFrom: ['c2'],
    data: { courses, sources: [], decks: [], focus: { courseId: 'c1', courses } },
    onClose: noop,
  })));
  const primaryBtns = [...html.matchAll(/<button[^>]*sh-btn--primary[^>]*>([\s\S]*?)<\/button>/g)].map((hit) => hit[1].replace(/<[^>]+>/g, ''));
  assert.equal(primaryBtns.length, 1, `merge confirmation must not render two primary buttons, got: ${JSON.stringify(primaryBtns)}`);
  assert.match(primaryBtns[0], /确认合并/);

  const src = await readFile(new URL('../ui/CourseSettings.jsx', import.meta.url), 'utf8');
  assert.match(src, /mergeIds\.length > 0/, 'hasPendingNested includes mergeIds.length > 0');
});

/* ---------- W1-14: use-term-marking error handling (no silent .catch(() => {})) ---------- */

test('W1-14: use-term-marking rolls back cache and notifies on mark/unmark failure instead of swallowing errors', async () => {
  const src = await readFile(new URL('../ui/review/use-term-marking.js', import.meta.url), 'utf8');
  const markSlice = src.slice(src.indexOf('callRef.current("course.terms.mark"'), src.indexOf('const persistUnmark'));
  assert.doesNotMatch(markSlice, /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/, 'persistMark must not silently swallow errors');
  assert.match(markSlice, /notify/, 'persistMark notifies learner on persistence failure');

  const unmarkSlice = src.slice(src.indexOf('callRef.current("course.terms.unmark"'), src.indexOf('const notifyLimit'));
  assert.doesNotMatch(unmarkSlice, /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/, 'persistUnmark must not silently swallow errors');
  assert.match(unmarkSlice, /notify/, 'persistUnmark notifies learner on persistence failure');
});

/* ---------- W1-23: Draft per-id stash preservation & publishAndPractice after-navigation guard ---------- */

test('W1-23: per-draft stash preserves other drafts on open and restores same draft; publishAndPractice clears recovery and skips ghost review.start after leaving', async () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v); },
    removeItem: (k) => { mem.delete(k); },
  };
  const d1 = { id: 'd1', title: 'Draft 1', draftVersion: 1, cards: [{ id: 'c1', prompt: 'Edited 1' }] };
  const d1Orig = { id: 'd1', title: 'Draft 1', draftVersion: 1, cards: [{ id: 'c1', prompt: 'Orig 1' }] };
  const d2 = { id: 'd2', title: 'Draft 2', draftVersion: 1, cards: [{ id: 'c2', prompt: 'Orig 2' }] };

  m.putDraftStash('/lib', { draft: d1, draftText: JSON.stringify(d1, null, 2), jsonMode: false, draftLoaded: JSON.stringify(d1Orig) }, storage);
  // Opening clean d2 must NOT erase d1's stash
  m.dropDraftStash('/lib', 'd2', storage);
  const mapAfterD2 = m.readRecoveryMap('/lib', storage);
  assert.ok(mapAfterD2.d1, 'draft 1 stash survives opening clean draft 2');
  assert.deepEqual(m.pickRecoveryFor('/lib', d1Orig, storage)?.draft.cards[0].prompt, 'Edited 1', 're-opening draft 1 recovers its unsaved edits');
  assert.equal(m.pickRecoveryFor('/lib', d2, storage), null);

  // publishAndPractice when user navigated away mid-flight: clears recovery unconditionally, does NOT start ghost review.start
  const calls = [];
  let cleared = 0;
  await m.publishAndPractice({
    call: async (action, args) => {
      calls.push([action, args]);
      if (action === 'draft.publish.quick') return { id: 'published-d1' };
      return { id: 'ghost-run', total: 5 };
    },
    act: async (action, args, after) => {
      calls.push([action, args]);
      const res = action === 'draft.save' ? { ...args.deck, draftVersion: 2 } : { id: 'published-d1' };
      await after?.(res, { isCurrent: () => false });
      return res;
    },
    toast: { success: noop },
    draft: d1,
    save: false,
    clearRecovery: () => { cleared += 1; },
    enterRun: () => { throw new Error('must not enterRun after navigation'); },
    setPage: noop,
    practice: {},
  });
  assert.equal(cleared, 1, 'clearRecovery runs even when user navigated away so dead recovery banner is removed');
  assert.equal(calls.some(([action]) => action === 'review.start'), false, 'must not spawn a ghost 0-answered review run after user navigated away');
});
