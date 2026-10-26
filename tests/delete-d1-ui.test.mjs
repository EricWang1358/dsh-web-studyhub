import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// 3.7.0 D1 in static markup, in both languages: the one draft-delete dialog (what goes, what stays, what stops; 保留 first), the 删除 of a 待发布 row, the
// second action of a toast (永久删除… after an archive) and the 归档 of a finished job card.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as DeleteDraftDialog } from './ui/DeleteDraftDialog.jsx';
  export { HomeDrafts } from './ui/study-map/HomeActivity.jsx';
  export { Toast } from './ui/components/Feedback.jsx';
  export { noticeToToast } from './ui/ActionFeedback.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const card = (id) => ({ id, kind: 'flashcard', topic: 't', prompt: `p${id}`, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x' });
const draft = (extra = {}) => ({ id: 'd1', title: '架构思维', draftVersion: 3, cards: [card('c1'), card('c2'), card('c3')], editorial: { requested: 3, generated: 3, completedParts: 1, parts: 1, failures: [] }, ...extra });
const inLanguage = (language, render) => { m.setUiLanguage(language); try { return render(); } finally { m.setUiLanguage('zh'); } };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
const writing = { id: 'gen-1', draftId: 'd1', status: 'running' };

test('the draft dialog names the draft, what goes for good, what stays, and (only when something works on it) what stops; 保留 comes first', () => {
  const html = renderToStaticMarkup(React.createElement(m.DeleteDraftDialog, { draft: draft(), onClose: noop }));
  assert.match(html, /永久删除草稿「架构思维」？/);
  assert.match(text(html), /会删除：这份草稿里还没发布的 3 道题，删除后不能撤销。/);
  assert.match(text(html), /会保留：出题用的资料，以及已经发布的题组。/);
  assert.doesNotMatch(html, /任务会停止/);
  const footer = html.match(/<footer[^>]*>(.*)<\/footer>/s)[1];
  assert.ok(footer.indexOf('>保留<') < footer.indexOf('>永久删除草稿<'), 'cancel (保留) first');
  assert.match(footer, /sh-btn--quiet[^>]*>保留</);
  assert.match(footer, /sh-btn--danger[^>]*>永久删除草稿</);
  assert.match(renderToStaticMarkup(React.createElement(m.DeleteDraftDialog, { draft: draft(), data: { jobs: [writing] }, onClose: noop })), /正在为这份草稿工作的任务会停止。/);
  assert.match(renderToStaticMarkup(React.createElement(m.DeleteDraftDialog, { draft: draft({ cards: [card('c1')] }), onClose: noop })), /还没发布的 1 道题/);
  const en = inLanguage('en', () => renderToStaticMarkup(React.createElement(m.DeleteDraftDialog, { draft: draft({ title: 'Week 3' }), data: { jobs: [writing] }, onClose: noop })));
  assert.match(en, /Permanently delete draft “Week 3”\?/);
  assert.match(en, />Keep</);
  assert.doesNotMatch(text(en), han);
});

test('an edit of a published deck says only the unpublished changes go and the deck with its published questions stays; the draft is named as its row names it', () => {
  const data = { decks: [{ id: 'deck-1', title: '期中复习', count: 12 }], jobs: [] };
  for (const extra of [{ editingDeckId: 'deck-1' }, { editorial: { repairOfDeckId: 'deck-1' } }, { mergeTargetId: 'deck-1' }]) {
    const html = text(renderToStaticMarkup(React.createElement(m.DeleteDraftDialog, { draft: draft({ title: '期中复习', ...extra }), data, onClose: noop })));
    assert.match(html, /会删除：对「期中复习」还没发布的修改，删除后不能撤销。/, JSON.stringify(extra));
    assert.match(html, /会保留：题组「期中复习」和它已发布的 12 道题，以及出题用的资料。/);
    assert.doesNotMatch(html, /还没发布的 3 道题/, 'not the false line');
  }
  const en = inLanguage('en', () => text(renderToStaticMarkup(React.createElement(m.DeleteDraftDialog, { draft: draft({ title: 'Midterm', editingDeckId: 'deck-1' }), data: { decks: [{ id: 'deck-1', title: 'Midterm', count: 12 }] }, onClose: noop }))));
  assert.doesNotMatch(en, han);
});

test('a draft whose publication check is running cannot be deleted yet: the confirm waits and says why, and nothing claims a job stops', () => {
  const html = renderToStaticMarkup(React.createElement(m.DeleteDraftDialog, { draft: draft(), data: { jobs: [{ id: 'pub-1', type: 'draft-publish', draftId: 'd1', status: 'running' }] }, onClose: noop }));
  assert.match(text(html), /这份草稿正在后台做发布检查，检查结束后才能删除。/);
  assert.doesNotMatch(html, /任务会停止/);
  const footer = html.match(/<footer[^>]*>(.*)<\/footer>/s)[1];
  assert.match(footer, /<button[^>]*disabled=""[^>]*>永久删除草稿</, 'the confirm is disabled');
});

test('a 待发布 row has a quiet 删除 named by its draft (it opens the same dialog), in both languages', () => {
  const render = () => renderToStaticMarkup(inApp(m, React.createElement(m.HomeDrafts, { drafts: [draft()], data: { jobs: [], drafts: [draft()], decks: [], sources: [] },
    modelReady: true, openDraft: noop, topUpDraft: noop, defaultOpen: true }), { data: {} }));
  const zh = render();
  assert.match(zh, /<button[^>]*class="[^"]*draft-delete[^"]*"[^>]*aria-label="删除草稿「架构思维」"[^>]*>删除<\/button>/);
  assert.doesNotMatch(zh, /sh-btn--primary[^>]*>删除</, 'never the primary');
  const en = inLanguage('en', render);
  assert.match(en, /aria-label="Delete draft “架构思维”"[^>]*>Delete</);
});

test('a notice can carry a second quiet action (永久删除… after an archive) next to 撤销', () => {
  const toast = m.noticeToToast({ text: '已归档「期中」', undo: true, timeout: 8000, action: { label: '撤销', run: noop }, secondary: { label: '永久删除…', run: noop } }, false);
  assert.equal(toast.secondary.label, '永久删除…');
  const html = renderToStaticMarkup(React.createElement(m.Toast, { tone: 'success', action: toast.action, secondary: toast.secondary }, '已归档「期中」'));
  assert.ok(html.indexOf('>撤销<') < html.indexOf('>永久删除…<'), '撤销 first');
  assert.match(html, /sh-toast__secondary/);
  assert.equal((html.match(/<button/g) || []).length, 2);
});
