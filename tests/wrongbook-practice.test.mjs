/* 错题与待巩固: practising one topic is one click on its group (not one 练 per question), the retrain button says what it takes (every mistake of the page),
   and with a filter on there is a second button for just what the filter shows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`export { WrongBookView } from './ui/WrongBook.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const { WrongBookView, setUiLanguage } = m;
const noop = () => {};
const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末综合卷04｜90题' }, { id: 'd2', course: 'PE', title: 'Platform Engineering｜期末综合卷02｜90题' }];
const row = (cardId, deckId, topic, prompt, assessment = 'graded') => ({ deckId, deckTitle: decks.find((d) => d.id === deckId).title, cardId, topic, prompt, assessment, lastGrade: 1,
  lastAt: '2026-10-01T10:00:00Z', kind: 'quiz' });
const items = [row('c1', 'd4', '保护状态', '熔断器？'), row('c2', 'd4', '集成收益', '集成收益？'), row('c3', 'd4', '组织与架构', '平台团队？', 'self'),
  row('c4', 'd2', '保护状态', '半开状态？'), row('c5', 'd2', '恢复探测', '探测依赖？')];
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop,
  items, counts: { total: 5, graded: 4, self: 1, oral: 0, rubric: 0 }, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
  onReload: noop, onPage: noop, recs: null, coach: null, details: {}, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop,
  onGenerate: async () => ({}), onOpenSettings: noop, busy: false };
const render = (extra = {}) => renderToStaticMarkup(React.createElement(WrongBookView, { ...base, ...extra }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const buttons = (html) => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []);
const labelled = (html, pattern) => buttons(html).filter((tag) => pattern.test(text(tag)));

test('every group has a button that practises the whole group, folded or open', () => {
  setUiLanguage('zh');
  const html = render();
  const heads = html.match(/<div class="wb-group-head">[\s\S]*?<\/div><\/div>/g) || [];
  assert.equal(heads.length, 2, 'two decks have mistakes');
  for (const head of heads) assert.match(head, /练这一组/);
  assert.match(html, /aria-label="练这一组：期末综合卷04"/);
  assert.equal(labelled(html, /练这一组/).length, 2);
  assert.equal(labelled(render({ initial: { groups: 'all' } }), /练这一组/).length, 2, 'open groups too');
  assert.equal(labelled(render({ initial: { groupBy: 'topic' } }), /练这一组/).length, 4, 'and by topic: one per topic');
});

test('the group button is not offered while the page is busy', () => {
  assert.ok(labelled(render({ busy: true }), /练这一组/).every((tag) => /disabled/.test(tag)));
  assert.ok(labelled(render(), /练这一组/).every((tag) => !/disabled/.test(tag)));
});

test('the retrain button says it takes every mistake of the page, not what a filter shows', () => {
  setUiLanguage('zh');
  const plain = text(render());
  assert.match(plain, /开始重练 · 全部 5 题/);
  assert.doesNotMatch(plain, /开始重练 \(/);
  assert.doesNotMatch(plain, /练筛选的/, 'no filter, no second button');
  const filtered = render({ initial: { filter: { status: 'self' } } });
  assert.match(text(filtered), /开始重练 · 全部 5 题/, 'the filter does not change what the main button practises');
  assert.match(text(filtered), /练筛选的 1 道/);
  assert.equal(labelled(filtered, /练筛选的/).length, 1);
});

test('the second button counts what the filter shows, and is not there when the filter shows nothing or everything', () => {
  setUiLanguage('zh');
  assert.match(text(render({ initial: { filter: { deck: 'd4' } } })), /练筛选的 3 道/);
  assert.match(text(render({ initial: { filter: { query: '状态' } } })), /练筛选的 2 道/);
  assert.doesNotMatch(text(render({ initial: { filter: { query: '没有这个词' } } })), /练筛选的/, 'nothing shown: the page offers 清除筛选 instead');
  assert.doesNotMatch(text(render({ initial: { filter: { status: 'graded', deck: '' } }, items: items.filter((row) => row.assessment === 'graded'), counts: { total: 4, graded: 4, self: 0, oral: 0, rubric: 0 } })),
    /练筛选的/, 'the filter lets everything through: it would say the same as the main button');
});

test('English: the new buttons are translated', () => {
  setUiLanguage('en');
  try {
    const html = render({ initial: { filter: { deck: 'd4' } } });
    assert.doesNotMatch(text(html).replace(/期末综合卷0\d/g, ''), /\p{Script=Han}/u);
    assert.match(text(html), /Practise this group/);
    assert.match(text(html), /Start retraining · all 5/);
    assert.match(text(html), /Practise the 3 filtered/);
  } finally { setUiLanguage('zh'); }
});

test('the consent note points to the setting with a real link, not with a path to look for', () => {
  setUiLanguage('zh');
  const opened = [];
  const html = render({ initial: { askConsent: true }, coach: { enabled: true, consent: null, ready: 0, readyCards: [], failedCards: [], tasks: [] }, onSettings: (section) => opened.push(section) });
  assert.match(text(html), /要让 AI 为错题备变式题吗/);
  assert.doesNotMatch(text(html), /设置 › 学习画像与导览/);
  assert.equal(labelled(html, /前往设置/).length, 1);
  const without = render({ initial: { askConsent: true }, coach: { enabled: true, consent: null, ready: 0, readyCards: [], failedCards: [], tasks: [] } });
  assert.equal(labelled(without, /前往设置/).length, 0, 'a page that cannot open Settings draws no dead link');
});
