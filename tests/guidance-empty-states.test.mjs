/* Step 2 of the guidance plan, the copy half: an empty area says which of the three reasons it is empty for (从没有过 / 清空了 /
   筛选后没有, ui/empty-reasons.js), and the mailbox's empty state has one way on instead of a sentence alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export { EMPTY_REASONS, emptyReason } from './ui/empty-reasons.js';
  export { default as Inbox } from './ui/Inbox.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const noop = () => {};
const han = /[\u3400-\u9fff]/;

/** The mailbox panel, open, with an empty inbox. */
function mailbox({ language = 'zh', onOpenTasks } = {}) {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(m.Inbox, {
      inbox: { unread: 0, items: [] }, busy: false, onOpen: noop, onReadAll: noop, onOpenTasks, defaultOpen: true,
    }));
  } finally { m.setUiLanguage('zh'); }
}

test('the three reasons, and the filter wins when a filter is what emptied the area', () => {
  assert.equal(m.emptyReason(), 'never', 'nothing said, nothing ever put here');
  assert.equal(m.emptyReason({ cleared: true }), 'cleared');
  assert.equal(m.emptyReason({ filtered: true }), 'filtered');
  assert.equal(m.emptyReason({ filtered: true, cleared: true }), 'filtered', 'widening the filter is the one thing that brings the rows back');
  assert.deepEqual(Object.values(m.EMPTY_REASONS).sort(), ['cleared', 'filtered', 'never']);
});

test('an empty inbox says what lands there and offers the one way on, and no second primary action', () => {
  const zh = mailbox({ onOpenTasks: noop });
  assert.match(zh, /信箱是空的/);
  assert.match(zh, /的结果会放在这里/, 'what this place holds');
  assert.match(zh, /sh-btn--quiet[^"]*"[^>]*>看后台任务</, 'the one way on is the quiet button, not a second primary');
  assert.doesNotMatch(zh, /sh-btn--primary/, 'the bar has no primary action');
});

test('the mailbox adds no action when the page has no way to the jobs page', () => {
  assert.doesNotMatch(mailbox(), /看后台任务/);
  assert.match(mailbox(), /信箱是空的/, 'the sentence stays');
});

test('in English the empty inbox and its way on are English', () => {
  const en = mailbox({ language: 'en', onOpenTasks: noop });
  assert.match(en, /The inbox is empty/);
  assert.match(en, /Open Jobs/);
  assert.doesNotMatch(/The inbox is empty|Open Jobs/.exec(en)[0], han);
});
