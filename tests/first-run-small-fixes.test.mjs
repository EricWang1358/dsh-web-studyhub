/* The first run's small fixes (onboarding wave 2, slice D1): with no model the top bar does not say 已连接 (that word is about the library), and a way back
   that leads to the page the learner is already on is dropped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as AppTopbar } from './ui/app/AppTopbar.jsx';
  export { withoutSelfReturn } from './ui/learning-navigation.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const noop = () => {};
const han = /[\u3400-\u9fff]/;
const bar = ({ data = { root: '/lib', inbox: [] }, connection = {}, busy = false, language = 'zh' } = {}) => {
  m.setUiLanguage(language);
  try {
    const app = { nav: { navigate: noop }, inbox: { openInboxItem: noop },
      core: { call: noop, act: noop, busy, notify: noop, setError: noop, quick: {}, quickApi: { failures: {} } },
      connection: { binding: { root: '/lib' }, running: false, publishing: false, syncIssue: '', ...connection },
      settingsEntry: { setSettingsFocus: noop, openModelSettings: noop } };
    return renderToStaticMarkup(inApp(m, React.createElement(m.AppTopbar, { title: '学习库' }), { data: data || {}, app: { ...app, data } }));
  } finally { m.setUiLanguage('zh'); }
};
const label = (html) => /top-status-label">([^<]*)</.exec(html)?.[1];

test('with no usable model the top bar says 还没配模型, not 学习库已连接; with a model nothing changes', () => {
  assert.equal(label(bar({ data: { root: '/lib', inbox: [], model: { ready: false, reason: 'no-route' } } })), '还没配模型');
  assert.equal(label(bar({ data: { root: '/lib', inbox: [], modelReady: false } })), '还没配模型', 'the older flag says the same');
  assert.equal(label(bar({ data: { root: '/lib', inbox: [], model: { ready: true, label: 'DeepSeek' } } })), '学习库已连接');
  assert.equal(label(bar({ data: { root: '/lib', inbox: [] } })), '学习库已连接', 'a host that does not report the model is not accused');
  assert.equal(label(bar({ data: null })), '没有连上学习库');
});

test('the words keep their place in a narrow pane (not the steady state) and the dot is not the green one', () => {
  const none = bar({ data: { root: '/lib', inbox: [], model: { ready: false } } }), ready = bar({ data: { root: '/lib', inbox: [], model: { ready: true } } });
  assert.doesNotMatch(none, /top-status idle/, 'the label is not folded into its dot');
  assert.match(ready, /top-status idle/, 'the steady state still is');
  assert.doesNotMatch(none, /dot is-online/);
  assert.match(ready, /dot is-online/);
});

test('a failing library keeps its own words before the model is mentioned, busy work too', () => {
  const data = { root: '/lib', inbox: [], model: { ready: false } };
  assert.equal(label(bar({ data, connection: { syncIssue: '读取失败' } })), '读不出学习库');
  assert.equal(label(bar({ data, busy: true })), '正在处理…');
});

test('any running job (PDF, audio, index, translation, not only questions) is a background task; only publishing is named', () => {
  const data = { root: '/lib', inbox: [], model: { ready: true } };
  assert.equal(label(bar({ data, connection: { running: true } })), '后台处理中');
  assert.equal(label(bar({ data, connection: { running: true, publishing: true } })), '正在发布…');
  assert.doesNotMatch(label(bar({ data, connection: { running: true } })), /生成/, 'not every job generates questions');
  assert.equal(label(bar({ data, connection: { running: true }, language: 'en' })), 'Working…');
  assert.equal(label(bar({ data, busy: true, language: 'en' })), 'Working…');
  assert.doesNotMatch(label(bar({ data, busy: true })), /保存/, 'every action takes the bar, not only a save');
});

const hover = (html) => /class="top-status[^"]*"[^>]*title="([^"]*)"/.exec(html)?.[1] || /title="([^"]*)"[^>]*class="top-status/.exec(html)?.[1];

test('the labels are short enough to fit a narrow pane; the long sentence is the hover text', () => {
  const data = { root: '/lib', inbox: [], model: { ready: true } };
  const failed = bar({ data, connection: { syncIssue: '读取失败' } }), running = bar({ data, connection: { running: true } });
  assert.match(hover(failed), /^学习库读不出来，正在重试：读取失败$/);
  assert.match(hover(running), /^有后台任务在进行（转换、转写、出题等）$/);
  assert.equal(hover(bar({ data })), undefined, 'a steady bar has no hover');
  assert.match(hover(bar({ data, connection: { syncIssue: '读取失败' }, language: 'en' })), /^Cannot read the library, retrying: 读取失败$/, 'the host\'s own error follows, whatever the language');
  assert.match(hover(bar({ data, connection: { running: true }, language: 'en' })), /^Background tasks are running$/);
  assert.equal(label(bar({ data, connection: { syncIssue: '读取失败' }, language: 'en' })), 'Library offline');
  for (const html of [failed, running, bar({ data: { ...data, model: { ready: false } } })]) assert.ok([...label(html)].length <= 7, `${label(html)} stays short`);
});

test('in English the top bar has no Chinese', () => {
  const html = bar({ data: { root: '/lib', inbox: [], model: { ready: false } }, language: 'en' });
  assert.equal(label(html), 'No model yet');
  assert.doesNotMatch(label(html), han);
});

test('a way back to the page the learner is on is dropped; any other stays, and so does a reader dialog', () => {
  const library = { page: 'library' }, sources = { page: 'sources' }, reader = { page: 'library', modal: { sourceId: 's' } };
  assert.deepEqual(m.withoutSelfReturn([library], 'library'), [], 'a first import remembered the library and generating landed on it');
  assert.deepEqual(m.withoutSelfReturn([sources, library], 'library'), [sources], 'only the last one, which is the way back shown');
  assert.deepEqual(m.withoutSelfReturn([sources], 'library'), [sources], 'a way back to another page stays');
  assert.deepEqual(m.withoutSelfReturn([reader], 'library'), [reader], 'a reader dialog is part of the place it leads to');
  const trail = [sources];
  assert.equal(m.withoutSelfReturn(trail, 'library'), trail, 'nothing to drop: the same list, so nothing re-renders');
  assert.deepEqual(m.withoutSelfReturn([], 'library'), []);
});
