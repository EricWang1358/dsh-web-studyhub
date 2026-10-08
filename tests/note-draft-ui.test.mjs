import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* The AI draft of a note is a main button of the note, not a control inside the publishing fold: it says what it makes (a public article, not a study note),
   what makes the draft be refused after the tokens are spent, what it is expected to use, and, without a model, what to do about that. */

const m = await loadUi(`
  export { default as NoteDraft } from './ui/NoteDraft.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const note = { id: 'n1', title: '学习笔记', status: 'draft', cards: [{ cardId: 'c1' }] };
const ready = { ready: true, reason: 'ok', label: '' }, none = { ready: false, reason: 'no-route', label: '' };
const draw = (props, language = 'zh') => {
  m.setUiLanguage(language);
  try {
    const services = { call: async () => ({}), act: async () => undefined, busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {} };
    return renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: services }, React.createElement(m.NoteDraft, { note, model: ready, onStart() {}, ...props })));
  } finally { m.setUiLanguage('zh'); }
};

test('the draft button is the primary button of the block, with the estimate beside it', () => {
  const out = draw();
  assert.match(out, /<button[^>]*class="[^"]*primary[^"]*"[^>]*>(?:<[^>]+>)*AI 起草解析/);
  assert.match(out, /data-token-estimate/, 'what it is expected to use is shown before the click');
  assert.doesNotMatch(out, /<details/, 'not inside a fold');
});

test('before the click it says what the draft is: a public article with no course in it, and what gets it refused after the tokens are spent', () => {
  const out = text(draw());
  assert.match(out, /可以公开发布的通用文章/);
  assert.match(out, /不写课程、课件或个人信息/);
  assert.match(out, /「课件」「讲义」「PPT」「本课程」或文件路径/);
  assert.match(out, /已用的用量不退/);
});

test('without a model the button waits and the gate says why, with the way to the settings', () => {
  const out = draw({ model: none, onModelSettings() {} });
  assert.match(out, /<button[^>]*disabled[^>]*>(?:<[^>]+>)*AI 起草解析/);
  assert.match(text(out), /还没有可用的 AI 模型/);
  assert.match(text(out), /AI 起草需要先配置模型；也可以自己写/);
  assert.match(out, /<button[^>]*>(?:<[^>]+>)*打开模型设置/);
  assert.doesNotMatch(out, /data-token-estimate/, 'no estimate for a call that cannot be made');
});

test('while a draft is being written, or when the note is busy, the button is off and says what is happening', () => {
  assert.match(draw({ running: true }), /<button[^>]*disabled[^>]*>(?:<[^>]+>)*AI 起草解析/);
  assert.match(text(draw({ running: true })), /AI 正在起草这篇笔记/);
  assert.match(draw({ disabled: true }), /<button[^>]*disabled[^>]*>(?:<[^>]+>)*AI 起草解析/);
});

test('English: nothing is left in Chinese', () => {
  assert.doesNotMatch(draw({}, 'en'), han);
  assert.doesNotMatch(draw({ model: none, onModelSettings() {} }, 'en'), han);
  assert.doesNotMatch(draw({ running: true }, 'en'), han);
  assert.match(text(draw({}, 'en')), /general article that is fine to publish/);
});
