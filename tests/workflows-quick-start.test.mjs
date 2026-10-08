/* 学习流 quick start: the recommended topic is already in the box, so starting is one click; the page says before starting that the course can only be changed
   afterwards, and that the skeleton option calls the model once more. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`export { default as Workflows } from './ui/Workflows.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const { Workflows, setUiLanguage } = m;
const step = { id: 's1', kind: 'lesson', title: '讲解', instructions: '', content: '', next: '$next', retry: '$stay', count: 10 };
const listing = { components: [{ kind: 'lesson', title: '讲解', prompt: 'p', description: 'd' }], templates: [], sessions: [], topics: [], skeletons: [],
  groups: { groups: [] }, limit: 5, suggested: { id: 'sg', title: '建议流程', description: '先讲后练', steps: [step] } };
const course = { course: 'OS', courses: [{ name: 'OS' }] };
const render = (data, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(Workflows, { data: { root: 'r', modelReady: true, ...data }, initialListing: listing })); } finally { setUiLanguage('zh'); } };
const input = (html) => html.match(/<input[^>]*aria-label="(?:想学什么|What do you want to learn\?)"[^>]*>/)?.[0] || '';
const goButton = (html) => html.match(/<button[^>]*class="[^"]*wf-quick-go[^"]*"[^>]*>/)?.[0] || '';
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the box opens with the recommended next topic, so the one click that starts is enabled', () => {
  const html = render({ next: { deckTitle: '行为型模式', topic: 'Memento' }, focus: course });
  assert.match(input(html), /value="行为型模式 · Memento"/);
  assert.doesNotMatch(goButton(html), /disabled/);
  assert.match(text(html), /已填好推荐的下一个主题/);
});

test('without a recommendation it opens with the course, and with neither it stays empty and the button waits', () => {
  assert.match(input(render({ focus: course })), /value="OS 的核心概念"/);
  const empty = render({ focus: { course: null, courses: [] } });
  assert.match(input(empty), /value=""/);
  assert.match(goButton(empty), /disabled/);
  assert.doesNotMatch(text(empty), /已填好推荐的下一个主题/, 'nothing was filled in, so nothing is said about it');
});

test('before starting, the page says which course it will use and that changing it is a step after starting', () => {
  const html = text(render({ next: { deckTitle: '行为型模式', topic: 'Memento' }, focus: course }));
  assert.match(html, /会在当前课程「OS」的资料里选；想换课程，开始后在下一页点「换课程」/);
});

test('the skeleton option says it calls the model once more, and only appears when there is a model', () => {
  const html = render({ focus: course });
  assert.match(text(html), /会在后台多调用一次模型/);
  assert.doesNotMatch(text(render({ focus: course, modelReady: false })), /多调用一次模型/);
});

test('English: the new lines are translated', () => {
  const html = text(render({ next: { deckTitle: 'Patterns', topic: 'Memento' }, focus: course }, 'en'));
  assert.doesNotMatch(html.replace(/OS|建议流程|先讲后练|讲解/g, ''), /[㐀-鿿]/);
  assert.match(html, /already filled in/i);
  assert.match(html, /one more model call/i);
});
