/* 「加入复习全书」 on the page (static zh and en, M3): the button says 加入复习全书, or 已加入 · 撤回 once the book holds the follow-up; the small 自动加入复习全书
   switch shows the setting; the practice page's Q&A shows neither while it does not know the course has a book. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookQaButton, BookQaAuto } from './ui/book/BookQaButton.jsx';
  export { default as ExplanationFollowup } from './ui/ExplanationFollowup.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {};
const services = { call: async () => ({ followupIds: [], courses: [] }), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const book = ids => ({ ids: new Set(ids), courses: new Set(['SA']), ready: true, add: async () => {}, remove: async () => {} });

test('the button: 加入复习全书, then 已加入 · 撤回; the auto switch shows the setting', () => {
  const refOf = { deckId: 'd', cardId: 'c', followupId: 'f1' };
  assert.match(textOf(render(h(ui.BookQaButton, { refOf, book: book([]) }))), /^加入复习全书$/);
  assert.match(render(h(ui.BookQaButton, { refOf, book: book(['f1']) })), /data-book-qa="added"[^>]*>[\s\S]*已加入 · 撤回/);
  assert.match(render(h(ui.BookQaAuto, { mode: 'auto', onChange: noop })), /role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/);
  assert.doesNotMatch(render(h(ui.BookQaAuto, { mode: 'manual', onChange: noop })), /checked=""/);
  assert.match(textOf(render(h(ui.BookQaAuto, { mode: 'manual', onChange: noop }))), /自动加入复习全书/);
  english(() => {
    assert.equal(textOf(render(h(ui.BookQaButton, { refOf, book: book([]) }))), 'Add to the review book');
    assert.equal(textOf(render(h(ui.BookQaButton, { refOf, book: book(['f1']) }))), 'Added · Take back');
    assert.match(textOf(render(h(ui.BookQaAuto, { mode: 'auto', onChange: noop }))), /Add to the review book automatically/);
  });
});

test('the practice page offers nothing about the book until it knows the course has one', () => {
  const run = { deckId: 'd', card: { id: 'c' }, solution: { followups: [{ id: 'f1', question: 'Why?', answer: 'Because.' }] } };
  const html = render(h(ui.ExplanationFollowup, { run, readOnly: true, bookQa: { course: 'SA', mode: 'manual', onMode: noop } }));
  assert.match(html, /Why\?/);
  assert.doesNotMatch(html, /加入复习全书/, 'the list of books is read first');
});
