import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* #668 (the UI scoring of 2026-11-04): 「删除草稿」 stood beside 「保存并校验」 and 「发布并开始练」, and 「删除」 beside 「归档」 in the task console, both as red outlined buttons with the same weight as the
   primary action. Now the row has the primary action and one secondary; the dangerous one is the item of a ⋯ menu (danger colour), one step away, and what it does afterwards is unchanged (the
   draft asks in its dialog, a task record leaves at once with 撤销). Static markup in both languages. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { default as DraftBar } from './ui/DraftBar.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as TaskMore } from './ui/tasks/TaskMore.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const noop = () => {};
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({ attrs: match[1], label: text(match[2]) }));
const cardOf = (id) => ({ id, kind: 'flashcard', topic: 't', prompt: `p${id}`, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x' });
const draft = { id: 'd1', title: 'T', draftVersion: 3, cards: [cardOf('c1'), cardOf('c2')], editorial: { requested: 2, generation: { sourceIds: ['s'], kind: 'quiz' } } };
const draftPage = (language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.Draft, { data: { sources: [{ id: 's', title: 'S' }], decks: [], drafts: [draft], jobs: [], modelReady: true, runs: [] },
  draft, draftLoaded: JSON.stringify(draft), setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false, setJsonMode: noop, openDraft: noop, onOpenPublished: noop, onStartPublished: noop,
  clearRecovery: noop, setPage: noop, setModal: noop, blankCard: noop, patchCard: noop, parseDraft: JSON.parse, topUpDraft: noop }), { data: { sources: [], decks: [], drafts: [draft], jobs: [] } })));
const barOf = (html) => { const at = html.indexOf('data-draft-bar'); return html.slice(html.lastIndexOf('<div', at), html.indexOf('</div></div>', at) + 12); };

test('draft page: the bar has the save and the publish button and a ⋯ menu; there is no 删除草稿 button beside the primary action', () => {
  const bar = barOf(draftPage());
  assert.ok(bar.includes('sticky-actions'), 'the bar is the draft page\'s one action bar');
  const labels = buttons(bar).map((button) => button.label);
  assert.ok(labels.includes('保存并校验') && labels.includes('发布并开始练 →'), labels.join('|'));
  assert.ok(!labels.includes('删除草稿'), `no 删除草稿 in the row: ${labels.join('|')}`);
  const more = buttons(bar).find((button) => /aria-haspopup="menu"/.test(button.attrs));
  assert.ok(more, 'a menu button');
  assert.match(more.attrs, /aria-label="更多"/);
  assert.match(bar, /data-draft-more/);
  assert.match(bar, /data-tour="draft-more"/, 'the finder and the tour can point at it');
  assert.doesNotMatch(draftPage(), /sh-btn--danger[^>]*>删除草稿|>删除草稿<\/button>/, 'and nowhere else on the page either');
});

test('draft page: the open menu has 删除草稿 in the danger colour, one step from the bar; English says the same', () => {
  const open = renderToStaticMarkup(inApp(m, React.createElement(m.DraftBar, { publishLabel: '发布并开始练 →', onSave: noop, onPublish: noop, onDelete: noop, defaultMenuOpen: true }), { data: {} }));
  const item = buttons(open).find((button) => /role="menuitem"/.test(button.attrs));
  assert.equal(item.label, '删除草稿');
  assert.match(item.attrs, /is-danger/);
  const english = inLanguage('en', () => renderToStaticMarkup(inApp(m, React.createElement(m.DraftBar, { publishLabel: 'Publish and practise →', onSave: noop, onPublish: noop, onDelete: noop, defaultMenuOpen: true }), { data: {} })));
  assert.equal(buttons(english).find((button) => /role="menuitem"/.test(button.attrs)).label, 'Delete draft');
  assert.match(english, /aria-label="More"/);
  assert.ok(buttons(english).some((button) => button.label === 'Save & validate'));
});

test('draft page: a draft that was deleted or published elsewhere cannot be deleted from the menu either', () => {
  const open = renderToStaticMarkup(inApp(m, React.createElement(m.DraftBar, { publishLabel: 'x', onSave: noop, onPublish: noop, onDelete: noop, deleteDisabled: true, defaultMenuOpen: true }), { data: {} }));
  assert.match(buttons(open).find((button) => /role="menuitem"/.test(button.attrs)).attrs, /disabled/);
});

test('draft page: choosing 删除草稿 asks in the same dialog as before (the confirmation does not change)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('ui/Draft.jsx', 'utf8');
  assert.match(source, /<DeleteDraftDialog draft=\{draft\}/);
  assert.match(source, /onDelete=\{\(\) => setDeletingId\(draft\.id\)\}/, 'the menu item opens the dialog, it deletes nothing itself');
});

const iso = (minutes) => new Date(Date.UTC(2026, 9, 5, 10, minutes)).toISOString();
const consoleOf = (jobs, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs, archivedJobs: [], drafts: [], decks: [] }, openers: { resultOf: () => null } }),
  { data: { jobs }, app: { lib: { taskFocus: null } } })));
const headOf = (html) => html.slice(html.indexOf('class="tc-head__actions"'), html.indexOf('aria-label="概览"'));

test('task console: the header row has no 删除 button; ⋯ opens 删除 in the danger colour (a finished task and a past day of 为你定制)', () => {
  const done = [{ id: 'gen-1', status: 'complete', deckTitle: '架构的语境性', requestedTotal: 15, savedCount: 15, startedAt: iso(40), finishedAt: iso(50) }];
  const head = headOf(consoleOf(done));
  const labels = buttons(head).map((button) => button.label);
  assert.ok(labels.includes('归档'), labels.join('|'));
  assert.ok(!labels.includes('删除'), `no 删除 beside 归档: ${labels.join('|')}`);
  assert.ok(buttons(head).some((button) => /aria-haspopup="menu"/.test(button.attrs) && /aria-label="更多操作"/.test(button.attrs)), 'the menu button');
  assert.match(head, /data-tour="tasks-more"/);
  const open = renderToStaticMarkup(inApp(m, React.createElement(m.TaskMore, { day: false, onDelete: noop, defaultOpen: true }), { data: {} }));
  const item = buttons(open).find((button) => /role="menuitem"/.test(button.attrs));
  assert.equal(item.label, '删除任务记录');
  assert.match(item.attrs, /is-danger/);
  const day = renderToStaticMarkup(inApp(m, React.createElement(m.TaskMore, { day: true, onDelete: noop, defaultOpen: true }), { data: {} }));
  assert.match(text(day), /删除这一天/);
  assert.match(text(day), /只保留最近 14 天/);
  const past = [{ id: 'coach:2026-10-01', type: 'coach-daily', date: '2026-10-01', status: 'complete', today: false, startedAt: iso(0),
    coachDaily: { date: '2026-10-01', batches: [], metrics: {}, tokens: { input: 0, output: 0, cache: 0 }, paused: false, limits: null } }];
  assert.ok(!buttons(headOf(consoleOf(past))).some((button) => /删除/.test(button.label)), 'a past day has no delete button either');
  const english = inLanguage('en', () => renderToStaticMarkup(inApp(m, React.createElement(m.TaskMore, { day: false, onDelete: noop, defaultOpen: true }), { data: {} })));
  assert.equal(buttons(english).find((button) => /role="menuitem"/.test(button.attrs)).label, 'Delete task record');
});

test('task console: a running task has neither the button nor the menu (a running task is never deleted)', () => {
  const running = [{ id: 'audio-1', type: 'audio-import', filename: '录音一', status: 'running', phase: 'proofread', startedAt: iso(2), members: [{ filename: 'a.mp3', status: 'running', steps: {} }] }];
  assert.doesNotMatch(headOf(consoleOf(running)), /aria-haspopup="menu"/);
});
