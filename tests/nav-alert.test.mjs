/* #655: the sidebar's one attention dot (ui/nav-alert.js). A dot only for something the learner has to act on now, on one row at most, with a
   reason in its Tooltip. The three cases the issue names: an empty library (no dot), questions due today (回到题目), a task that did not finish
   (任务, carried by 「更多」 while it is closed). The browser walk of the empty library is tests/nav-groups-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`export * from './ui/nav-alert.js'; export { NavItem, NavFold, ResumeNavItem } from './ui/SideNav.jsx';
  export { NAV_DEFAULTS, groupOf } from './ui/nav-order.js'; export { setUiLanguage, ui } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const html = (type, props) => renderToStaticMarkup(React.createElement(type, props));
const dots = (markup) => (markup.match(/class="nav-alert"/g) || []).length;

test('an empty library has no dot at all: nothing waits for the learner yet', () => {
  assert.equal(m.navAlert({}), null);
  assert.equal(m.navAlert({ failedTasks: 0, due: 0, boardDue: 0, page: 'library' }), null);
  assert.equal(m.navAlertText(null), '');
  // Nonsense counts (a snapshot still loading) are no reason either.
  assert.equal(m.navAlert({ failedTasks: undefined, due: NaN, boardDue: -2 }), null);
  // The rows themselves draw no dot without a reason: the 「从这里开始」 markers of 3.7 are gone.
  assert.equal(dots(html(m.NavItem, { glyph: 'library', label: '学习库', purpose: '每次打开先看这里' })), 0);
  assert.equal(dots(html(m.ResumeNavItem, { hasDecks: false, ready: true })), 0);
});

test('questions due today put the dot on 回到题目, which starts them, with the count as its reason', () => {
  const alert = m.navAlert({ due: 7, page: 'library' });
  assert.deepEqual(alert, { id: 'review', kind: 'due', count: 7 });
  assert.equal(m.navAlertText(alert), '今天有 7 道题到期复习');
  const row = html(m.ResumeNavItem, { hasDecks: true, ready: true, alert: m.navAlertText(alert) });
  assert.equal(dots(row), 1);
  assert.match(row, /role="tooltip"[^>]*>今天有 7 道题到期复习\n/, 'the reason is the first line of the Tooltip');
  // On the practice page itself there is nothing to point at.
  assert.equal(m.navAlert({ due: 7, page: 'review' }), null);
});

test('a task that did not finish wins over due questions, and 「更多」 carries its dot while 任务 is folded away', () => {
  const alert = m.navAlert({ failedTasks: 2, due: 7, boardDue: 3, page: 'library' });
  assert.deepEqual(alert, { id: 'tasks', kind: 'failed', count: 2 }, 'one dot, the most pressing');
  const reason = m.navAlertText(alert);
  assert.equal(reason, '2 个任务没有完成，点开看原因');
  assert.notEqual(m.groupOf(m.NAV_DEFAULTS, 'tasks'), 'main', '任务 is in 「更多」 by default');
  const closed = html(m.NavFold, { id: 'more', glyph: 'more', label: '更多', purpose: '其余的功能', alert: reason, open: false, onToggle() {} });
  assert.equal(dots(closed), 1, 'the closed fold shows it');
  assert.match(closed, /role="tooltip"[^>]*>2 个任务没有完成，点开看原因\n其余的功能/);
  // Once the learner is on 任务, the next thing in line takes the dot.
  assert.deepEqual(m.navAlert({ failedTasks: 2, due: 7, page: 'tasks' }), { id: 'review', kind: 'due', count: 7 });
  assert.deepEqual(m.navAlert({ boardDue: 3, page: 'library' }), { id: 'board', kind: 'board', count: 3 });
  assert.equal(m.navAlertText({ kind: 'board', count: 3 }), '待办里有 3 项已逾期或今天截止');
});

test('every reason has its English', () => {
  m.setUiLanguage('en');
  try {
    for (const alert of [{ kind: 'failed', count: 2 }, { kind: 'due', count: 7 }, { kind: 'board', count: 3 }]) assert.doesNotMatch(m.navAlertText(alert), han, alert.kind);
  } finally { m.setUiLanguage('zh'); }
});
