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
const label = (html) => /top-status-label">([^<]*)</.exec(html)?.[1]?.replaceAll('&#x27;', "'");

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
  assert.equal(label(bar({ data, connection: { running: true }, language: 'en' })), 'In background');
  assert.equal(label(bar({ data, busy: true, language: 'en' })), 'Working…');
  assert.doesNotMatch(label(bar({ data, busy: true })), /保存/, 'every action takes the bar, not only a save');
});

/* The long sentence is the project Tooltip's (the status is its focusable anchor), never a title attribute: the words reach keyboard and touch too. */
const tip = (html) => /<span[^>]*role="tooltip"[^>]*>([^<]*)<\/span>/.exec(html)?.[1];
const anchor = (html) => /<span[^>]*class="top-status[^"]*"[^>]*>/.exec(html)?.[0] || '';
const TRANSIENT = 'Failed to fetch';

test('the labels are short enough to fit a narrow pane; the long sentence is the Tooltip', () => {
  const data = { root: '/lib', inbox: [], model: { ready: true } };
  const failed = bar({ data, connection: { syncIssue: '读取失败' } }), running = bar({ data, connection: { running: true } });
  assert.equal(tip(failed), '学习库读不出来，正在重试：读取失败');
  assert.equal(tip(running), '有后台任务在进行（转换、转写、出题等）');
  assert.ok(!tip(bar({ data })), 'a steady bar has no Tooltip words');
  assert.doesNotMatch(anchor(bar({ data })), /tabindex/, 'and nothing to focus');
  for (const html of [failed, running]) {
    assert.match(anchor(html), /tabindex="0"/, 'the status with words is focusable');
    assert.match(anchor(html), /aria-describedby=/);
    assert.doesNotMatch(html, /top-status[^>]*\stitle=/, 'no title attribute on the status');
  }
  assert.equal(tip(bar({ data, connection: { syncIssue: TRANSIENT } })), '连接中断，正在重试…');
  assert.ok(!tip(bar({ data, busy: true })), '正在处理… says it all');
});

test('every status label stays at seven characters or fewer in Chinese and at most 18 in English, the transient one included', () => {
  const data = { root: '/lib', inbox: [], model: { ready: true } }, noModel = { ...data, model: { ready: false } };
  const states = [{ data }, { data: noModel }, { data: null }, { data, busy: true }, { data, connection: { running: true } }, { data, connection: { running: true, publishing: true } },
    { data, connection: { syncIssue: '读取失败' } }, { data, connection: { syncIssue: TRANSIENT } }];
  for (const state of states) {
    const zh = label(bar(state)), en = label(bar({ ...state, language: 'en' }));
    assert.ok([...zh].length <= 7, `zh「${zh}」`);
    assert.ok([...en].length <= 18, `en "${en}"`);
    assert.doesNotMatch(en, han, `en "${en}" has no Chinese`);
  }
  assert.equal(label(bar({ data, connection: { syncIssue: TRANSIENT } })), '重新连接中…');
  assert.equal(label(bar({ data, connection: { syncIssue: TRANSIENT }, language: 'en' })), 'Reconnecting…');
});

test('English: a failed read is not called offline, a running job is not the busy word, and the Tooltip words are English with the transport\'s own messages', () => {
  const data = { root: '/lib', inbox: [], model: { ready: true } };
  const en = (state) => bar({ data, ...state, language: 'en' });
  assert.equal(label(en({ connection: { syncIssue: '读取失败' } })), "Library error");
  assert.equal(label(en({ connection: { running: true } })), 'In background');
  assert.equal(label(en({ busy: true })), 'Working…');
  assert.equal(tip(en({ connection: { running: true } })), 'Background tasks are running (conversion, transcription, question generation…)');
  for (const message of ['StudyHub 还没有启动好（DSH 可能刚重启）。等几秒再点一次。', 'StudyHub 的请求没有成功，也没有拿到具体原因。可以再试一次。',
    'StudyHub 只对这台电脑上的 DSH 主人开放；通过远程访问打开的浏览器不能使用它。StudyHub is only available to the owner of this DSH, not to remote-access browsers.']) {
    const words = tip(en({ connection: { syncIssue: message } }));
    assert.match(words, /^Cannot read the library, retrying: /);
    assert.doesNotMatch(words, han, message);
  }
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
