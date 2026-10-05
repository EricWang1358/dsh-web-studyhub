import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// 2.6.1: a running DSH sub-agent showed "等待模型开始输出…" for as long as it ran, whether it was thinking (reasoning is only counted, never shown) or
// its model gave no text before the end. The empty body now says which: waiting, thinking (with how much), or "working, nothing to show yet".
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as OutputPanel } from './ui/tasks/OutputPanel.jsx';
  export { waitState, waitNote, QUIET_AFTER_MS } from './ui/tasks/output-wait.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const NOW = Date.UTC(2026, 9, 5, 10, 0, 0);
const sub = { callId: 'c1', kind: 'translate', status: 'running', runner: 'subagent', startedAt: new Date(NOW).toISOString(), childId: 'child-1' };
const direct = { ...sub, runner: 'direct', childId: null };

test('waitState: text beats everything; reasoning means thinking; a quiet sub-agent is working; the rest waits', () => {
  assert.equal(m.QUIET_AFTER_MS, 20000);
  assert.equal(m.waitState({ call: sub, text: 'x', reasoning: 500, elapsedMs: 999999 }), 'text');
  assert.equal(m.waitState({ call: sub, text: '', reasoning: 120, elapsedMs: 1000 }), 'thinking');
  assert.equal(m.waitState({ call: sub, text: '', reasoning: 0, elapsedMs: 5000 }), 'waiting', 'a sub-agent just started is simply starting');
  assert.equal(m.waitState({ call: sub, text: '', reasoning: 0, elapsedMs: m.QUIET_AFTER_MS }), 'working');
  assert.equal(m.waitState({ call: sub, text: '', reasoning: 0, elapsedMs: 300000 }), 'working');
  assert.equal(m.waitState({ call: direct, text: '', reasoning: 0, elapsedMs: 300000 }), 'waiting', 'only a sub-agent is known to finish without streaming text');
  assert.equal(m.waitState({ call: sub, text: '', reasoning: 0, elapsedMs: NaN }), 'waiting');
});

test('waitNote words each state, in both languages', () => {
  m.setUiLanguage('zh');
  assert.equal(m.waitNote('waiting', 0), '等待模型开始输出…');
  assert.match(m.waitNote('thinking', 1234), /模型正在思考（已思考约 1,?234 字）/);
  assert.equal(m.waitNote('working', 0), '子代理正在工作，完成前这里可能没有文字；完整内容在 DSH 会话里。');
  m.setUiLanguage('en');
  try {
    assert.equal(m.waitNote('waiting', 0), 'Waiting for the model to start writing…');
    assert.match(m.waitNote('thinking', 1234), /^The model is thinking \(about 1,?234 characters so far\)/);
    assert.match(m.waitNote('working', 0), /^The sub-agent is working; there may be no text here until it finishes\. The full content is in the DSH session\.$/);
  } finally { m.setUiLanguage('zh'); }
});

test('the panel of a sub-agent that has been quiet for a minute stops claiming it waits for the model', () => {
  const html = (call, language = 'zh') => {
    m.setUiLanguage(language);
    try { return renderToStaticMarkup(inApp(m, React.createElement(m.OutputPanel, { jobId: 'j1', call, active: true }), { data: {}, app: { host: {} } })); } finally { m.setUiLanguage('zh'); }
  };
  const fresh = html({ ...sub, startedAt: new Date().toISOString() });
  assert.match(fresh, /等待模型开始输出/);
  const old = html({ ...sub, startedAt: new Date(Date.now() - 90000).toISOString() });
  assert.match(old, /子代理正在工作，完成前这里可能没有文字；完整内容在 DSH 会话里/);
  assert.doesNotMatch(old, /等待模型开始输出/);
  assert.match(html({ ...sub, startedAt: new Date(Date.now() - 90000).toISOString() }, 'en'), /The sub-agent is working; there may be no text here until it finishes/);
  assert.match(html({ ...direct, startedAt: new Date(Date.now() - 90000).toISOString() }), /等待模型开始输出/, 'a direct call keeps waiting: it does stream');
});
