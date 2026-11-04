import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { draftView, seedView } from './helpers/coverage-view.mjs';

/* #669 and #670 (the UI scoring of 2026-11-04): the draft page asked for the publication first and the questions started below the second screen; and the rows of the questions were not alike (the
   first one's number stood alone on its line, the others' beside the question, with a lot of air). Now the page reads coverage, then the questions, then 生成详情, and ends with the action bar,
   which sticks to the bottom of the view; every question is ONE row (number, question cut at two lines, kind at the end). The measured part (the first question on the first screen, the bar in view
   at every scroll position, rows within 72px) is tests/draft-layout-browser.test.mjs. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const noop = () => {};
const css = async () => (await readFile(new URL('../ui/draft.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const card = (id, prompt, extra = {}) => ({ id, kind: 'quiz', topic: 't', prompt, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x', options: [], citations: [], ...extra });
const LONG = '关于「间隔重复与遗忘曲线」，哪一项最准确地概括了这句话：「间隔重复的核心做法是在快要忘记之前安排下一次复习，从而用较少的次数维持长期记忆，这样复习负担不会随着卡片数量增加而失控。」？';
const draft = { id: 'd1', title: 'T', draftVersion: 3, cards: [card('c1', LONG), card('c2', '短题？'), card('c3', LONG, { kind: 'multi' }), card('c4', '短题二？', { kind: 'open' })],
  editorial: { requested: 4, generation: { sourceIds: ['s'], kind: 'quiz' }, reviewedCards: {} } };
const page = (language = 'zh') => {
  m.setUiLanguage(language);
  try {
    m.forgetCoverage(); seedView(m, draftView({ draftId: 'd1', draftVersion: 3, covered: ['r1.p1', 'r1.p2', 'r1.p3'] }));
    return renderToStaticMarkup(inApp(m, React.createElement(m.Draft, { data: { sources: [{ id: 's', title: 'S' }], decks: [], drafts: [draft], jobs: [], modelReady: true, runs: [] },
      draft, draftLoaded: JSON.stringify(draft), setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false, setJsonMode: noop, openDraft: noop, onOpenPublished: noop, onStartPublished: noop,
      clearRecovery: noop, setPage: noop, setModal: noop, blankCard: noop, patchCard: noop, parseDraft: JSON.parse, topUpDraft: noop }), { data: { sources: [{ id: 's', title: 'S' }], decks: [], drafts: [draft], jobs: [] } }));
  } finally { m.setUiLanguage('zh'); }
};

test('#669: the page reads coverage, then the questions, then the details of the generation, and the bar is the last thing on it', () => {
  const html = page();
  const at = (needle) => html.indexOf(needle);
  assert.ok(at('data-coverage-summary') > 0, 'the coverage is there');
  assert.ok(at('data-coverage-summary') < at('draft-edit-heading'), 'coverage first');
  assert.ok(at('draft-edit-heading') < at('draft-card'), 'then the questions');
  assert.ok(at('draft-card') < at('draft-generation-details'), '生成详情 comes after the questions, not before them');
  assert.ok(at('draft-generation-details') < at('data-draft-bar'), 'and the bar ends the page');
  assert.equal(html.split('data-draft-bar').length - 1, 1, 'one bar');
  assert.equal(html.slice(at('data-draft-bar')).split('draft-card').length - 1, 0, 'nothing of the questions comes after the bar');
  assert.ok(html.indexOf('</section>', at('data-draft-bar')) > 0 && html.slice(at('data-draft-bar')).split('<h2').length === 1, 'no heading after it');
});

test('#669: the bar says what the draft holds on its left, keeps the primary button on the right, and has no box of its own around the buttons at the top', () => {
  const html = page();
  const bar = html.slice(html.indexOf('data-draft-bar') - 40);
  assert.match(bar, /当前草稿 <strong>4<\/strong> 题/);
  assert.ok(bar.indexOf('当前草稿') < bar.indexOf('保存并校验') && bar.indexOf('保存并校验') < bar.indexOf('发布并开始练'), 'status, save, then the primary action last');
  assert.doesNotMatch(html.slice(0, html.indexOf('data-coverage-summary')), /发布并开始练/, 'no publish button above the coverage any more');
  assert.doesNotMatch(html, /class="draft-count"/);
});

test('#669: the bar sticks to the BOTTOM of the view and is opaque', async () => {
  const sheet = await css();
  const start = sheet.indexOf('.sticky-actions {'), rule = sheet.slice(start, sheet.indexOf('}', start));
  assert.match(rule, /position:\s*sticky/);
  assert.match(rule, /bottom:\s*0/);
  assert.doesNotMatch(rule, /(?<![-\w])top:/, 'it no longer sticks under the top bar');
  assert.match(rule, /background:\s*var\(--bg-raised\)/, 'opaque: the page scrolls under it');
});
