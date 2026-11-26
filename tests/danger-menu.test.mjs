import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

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
  assert.ok(labels.includes('保存并校验') && labels.includes('发布并开始练'), labels.join('|'));
  assert.ok(!labels.includes('删除草稿'), `no 删除草稿 in the row: ${labels.join('|')}`);
  const more = buttons(bar).find((button) => /aria-haspopup="menu"/.test(button.attrs));
  assert.ok(more, 'a menu button');
  assert.match(more.attrs, /aria-label="更多"/);
  assert.match(bar, /data-draft-more/);
  assert.match(bar, /data-tour="draft-more"/, 'the finder and the tour can point at it');
  assert.doesNotMatch(draftPage(), /sh-btn--danger[^>]*>删除草稿|>删除草稿<\/button>/, 'and nowhere else on the page either');
});

test('draft page: the open menu has 删除草稿 in the danger colour, one step from the bar; English says the same', () => {
  const open = renderToStaticMarkup(inApp(m, React.createElement(m.DraftBar, { publishLabel: '发布并开始练', onSave: noop, onPublish: noop, onDelete: noop, defaultMenuOpen: true }), { data: {} }));
  const item = buttons(open).find((button) => /role="menuitem"/.test(button.attrs));
  assert.equal(item.label, '删除草稿');
  assert.match(item.attrs, /is-danger/);
  const english = inLanguage('en', () => renderToStaticMarkup(inApp(m, React.createElement(m.DraftBar, { publishLabel: 'Publish and practise', onSave: noop, onPublish: noop, onDelete: noop, defaultMenuOpen: true }), { data: {} })));
  assert.equal(buttons(english).find((button) => /role="menuitem"/.test(button.attrs)).label, 'Delete draft');
  assert.match(english, /aria-label="More"/);
  assert.ok(buttons(english).some((button) => button.label === 'Save & validate'));
});

test('draft page: a draft that was deleted or published elsewhere cannot be deleted from the menu either', () => {
  const open = renderToStaticMarkup(inApp(m, React.createElement(m.DraftBar, { publishLabel: 'x', onSave: noop, onPublish: noop, onDelete: noop, deleteDisabled: true, defaultMenuOpen: true }), { data: {} }));
  assert.match(buttons(open).find((button) => /role="menuitem"/.test(button.attrs)).attrs, /disabled/);
});

test('draft page: choosing 删除草稿 asks in the same dialog as before (the confirmation does not change)', async () => {
  await withBrowserGlobals(async () => {
    const ui = await loadInteractiveUi(`
      export { AppContext } from './ui/app/app-context.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { default as Draft } from './ui/Draft.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `);
    const { AppContext, StudyServicesContext, Draft, setUiLanguage } = ui.exports;
    const h = ui.React.createElement;
    setUiLanguage('zh');
    const actCalls = [];
    let recoveryCleared = 0;
    const pages = [];
    const data = { root: '/lib', revision: 1, sources: [{ id: 's', title: 'S' }], decks: [], drafts: [draft], jobs: [], modelReady: true, runs: [] };
    const study = {
      call: async () => ({ status: 'ok' }),
      act: async (action, args) => {
        actCalls.push({ action, args });
        return { ok: true };
      },
      busy: false,
      notify: noop,
      askInChat: noop,
      host: {},
      openSettings: noop,
      navigate: noop,
      openModal: noop,
    };
    const app = {
      language: 'zh',
      host: {},
      data,
      canChat: false,
      core: { call: study.call, act: study.act, busy: false, notify: noop, setError: noop },
      settingsEntry: { setCourseSettings: noop, openSettings: noop, openModelSettings: noop },
      tour: { tourResume: null, sampleBusy: false, startTour: noop, loadSampleOnly: noop, setRemovingSample: noop },
    };
    const mounted = ui.mount(() => h(
      StudyServicesContext.Provider,
      { value: study },
      h(
        AppContext.Provider,
        { value: app },
        h(Draft, {
          data,
          draft,
          draftLoaded: JSON.stringify(draft),
          setDraft: noop,
          draftText: '',
          setDraftText: noop,
          jsonMode: false,
          setJsonMode: noop,
          openDraft: noop,
          onOpenPublished: noop,
          onStartPublished: noop,
          clearRecovery: () => { recoveryCleared += 1; },
          setPage: (p) => pages.push(p),
          setModal: noop,
          blankCard: noop,
          patchCard: noop,
          parseDraft: JSON.parse,
          topUpDraft: noop,
        }),
      ),
    ));
    try {
      assert.equal(mounted.find((n) => n.type === 'dialog'), null, 'no confirmation dialog before clicking menu');
      assert.equal(actCalls.length, 0);

      const openDeleteDialog = async () => {
        const moreBtn = mounted.find((n) => n.type === 'button' && n.props?.['aria-haspopup'] === 'menu');
        assert.ok(moreBtn, 'draft action bar has ⋯ menu trigger');
        await mounted.act(() => click(moreBtn));
        const deleteItem = mounted.find((n) => n.type === 'button' && n.props?.role === 'menuitem' && ui.textOf(n).includes('删除草稿'));
        assert.ok(deleteItem, 'menu shows 删除草稿 item');
        await mounted.act(() => click(deleteItem));
      };

      // Step 1: choosing 删除草稿 opens DeleteDraftDialog without deleting immediately.
      await openDeleteDialog();
      const dialog = mounted.find((n) => n.type === 'dialog');
      assert.ok(dialog, 'DeleteDraftDialog opens after selecting 删除草稿');
      const dialogText = ui.textOf(dialog);
      assert.match(dialogText, /永久删除草稿「T」？/);
      assert.match(dialogText, /会删除：这份草稿里还没发布的 2 道题/);
      assert.match(dialogText, /会保留：出题用的资料/);
      assert.deepEqual(actCalls.filter((c) => c.action === 'draft.delete'), [], 'opening dialog does not call draft.delete');

      // Step 2: cancelling closes the dialog cleanly without calling draft.delete.
      const cancelBtn = mounted.find((n) => n.type === 'button' && ui.textOf(n) === '保留', dialog);
      assert.ok(cancelBtn, 'dialog offers 保留 cancel button');
      await mounted.act(() => click(cancelBtn));
      assert.equal(mounted.find((n) => n.type === 'dialog'), null, 'cancelling closes DeleteDraftDialog');
      assert.deepEqual(actCalls.filter((c) => c.action === 'draft.delete'), [], 'cancelling does not call draft.delete');

      // Step 3: re-opening and confirming sends draft.delete with draftVersion and navigates back to library.
      await openDeleteDialog();
      const reopened = mounted.find((n) => n.type === 'dialog');
      assert.ok(reopened, 'DeleteDraftDialog reopens on second attempt');
      const confirmBtn = mounted.find((n) => n.type === 'button' && ui.textOf(n).includes('永久删除草稿'), reopened);
      assert.ok(confirmBtn, 'dialog offers 永久删除草稿 confirm button');
      await mounted.act(() => click(confirmBtn));
      assert.deepEqual(
        actCalls.filter((c) => c.action === 'draft.delete'),
        [{ action: 'draft.delete', args: { id: 'd1', draftVersion: 3 } }],
        'confirming calls draft.delete with id and draftVersion',
      );
      assert.equal(mounted.find((n) => n.type === 'dialog'), null, 'dialog closes after delete succeeds');
      assert.equal(recoveryCleared, 1, 'clears recovery state after delete');
      assert.deepEqual(pages, ['library'], 'navigates back to library after delete');
    } finally {
      mounted.unmount();
      setUiLanguage('zh');
    }
  });
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
