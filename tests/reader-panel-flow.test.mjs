import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { addNode, answerNode, emptyThread } from '../ui/document-preview/ask-thread.js';

/* The reader's learning panel after the shortening: the first-level questions send at once, the top-up form starts filled in and keeps its kind and number
   behind 更多设置 (with the way to 设置), and every place that needs a model offers the gate with its button instead of a plain line. */

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/i18n.js';
  export { LearningPanel } from './ui/document-preview/DocumentLearning.jsx';
  export { ReaderModelContext } from './ui/document-preview/ReaderModelGate.jsx';
  export { OutlineAssistView } from './ui/document-preview/reader/OutlineAssist.jsx';
  export { default as TranslationBlock } from './ui/document-preview/translation/TranslationBlock.jsx';
  export { TranslationMenu } from './ui/document-preview/translation/TranslationMenu.jsx';
  export { ModelSettingsContext } from './ui/ModelErrorNote.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const lib = module.exports;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const withServices = (value, element) => React.createElement(lib.ReaderModelContext.Provider, { value }, element);
const render = (element, services = null) => renderToStaticMarkup(services ? withServices(services, element) : element);

const selection = { sourceId: 's1', documentId: 'doc', revision: 'r1', quote: 'We ship logs to ELK.', start: 0, end: 20 };
const panel = (extra = {}) => ({ capture: { quote: selection.quote }, resolution: { status: 'resolved', selection }, question: '', thread: emptyThread(),
  deckId: 'd', decks: [{ id: 'd', title: 'Deck' }], kind: 'quiz', count: 10, askReady: true, generateReady: true, modelReady: true, jobs: [], now: 0, call() {}, saveReady: true, ...extra });
const gone = { model: { ready: false, reason: 'no-route' }, openModelSettings() {}, openSettings() {} };

test('the first-level questions are buttons that ask on their own, and say so', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.LearningPanel, panel({ onQuick() {} })));
  assert.match(out, /role="group"[^>]*aria-label="快捷提问"/);
  for (const chip of ['没听懂', '举个例子', '为什么', '和什么有区别']) assert.match(text(out), new RegExp(chip), chip);
  // The tooltips name the exact question that goes out, and no longer promise a second press.
  assert.match(out, /点击即发送：「这段我没听懂，请按原文顺序讲一下。」/);
  assert.doesNotMatch(out, /会填入|按「依据原文回答」后才会发送/);
});

test('the chips wait while a model is not there or an answer is coming', () => {
  lib.setUiLanguage('zh');
  const chip = out => /<button[^>]*>(?:<[^>]+>)*没听懂/.exec(out)?.[0] || '';
  assert.doesNotMatch(chip(render(React.createElement(lib.LearningPanel, panel({ onQuick() {} })))), /disabled/);
  assert.match(chip(render(React.createElement(lib.LearningPanel, panel({ onQuick() {}, askReady: false })))), /disabled/);
  const asking = addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
  assert.match(chip(render(React.createElement(lib.LearningPanel, panel({ onQuick() {}, thread: asking })))), /disabled/);
});

test('the top-up form keeps its kind and number behind 更多设置, which says what they are and where to change them', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.LearningPanel, panel({ deckNote: '已选这份资料唯一的题组。' })), { openSettings() {} });
  const fold = out.slice(out.indexOf('更多设置') - 120);
  assert.match(out, /<summary[^>]*>[\s\S]*?更多设置[\s\S]*?单选测验 · 10 题/, 'the fold says what it holds');
  assert.ok(out.indexOf('更多设置') > out.indexOf('补充到现有题组'), 'it sits under the deck');
  assert.ok(out.indexOf('更多设置') < out.indexOf('生成、审核并补充题目'), 'and above the button');
  assert.match(text(fold), /题型/); assert.match(text(fold), /题数/);
  assert.match(text(fold), /题型和题数取自设置里的出题偏好；在这里改，不会改动设置/);
  assert.match(fold, /<button[^>]*>(?:<[^>]+>)*前往设置/);
  assert.match(text(out), /已选这份资料唯一的题组。/, 'the reason for the guessed deck is said');
  // Without a way to open Settings there is no link to nowhere.
  assert.doesNotMatch(render(React.createElement(lib.LearningPanel, panel()), { openSettings: undefined }), /前往设置/);
  assert.doesNotMatch(render(React.createElement(lib.LearningPanel, panel({ deckNote: '' }))), /已选这份资料/);
});

test('with no model the panel shows the gate with its button, not a plain line', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.LearningPanel, panel({ modelReady: false, askReady: false, generateReady: false })), gone);
  assert.match(text(out), /还没有可用的 AI 模型/);
  assert.match(text(out), /提问和补题需要先配置模型/);
  assert.match(out, /<button[^>]*>(?:<[^>]+>)*前往设置/);
  assert.doesNotMatch(text(out), /连接模型后可提问和补题/);
  // The gate is in the open: above the forms, where the learner is looking.
  assert.ok(out.indexOf('还没有可用的 AI 模型') < out.indexOf('针对这段原文提问'));
  // A ready model shows none of it.
  assert.doesNotMatch(render(React.createElement(lib.LearningPanel, panel()), gone), /还没有可用的 AI 模型/);
});

test('the gate offers the settings handler of the app when the reader was not given one', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.ModelSettingsContext.Provider, { value() {} },
    React.createElement(lib.LearningPanel, panel({ modelReady: false, askReady: false, generateReady: false }))));
  assert.match(out, /<button[^>]*>(?:<[^>]+>)*前往设置/);
  const none = render(React.createElement(lib.LearningPanel, panel({ modelReady: false, askReady: false, generateReady: false })));
  assert.doesNotMatch(none, /前往设置/, 'no handler anywhere: no button that goes nowhere');
});

test('translation, a paragraph\'s translation and the AI outline offer the same gate when there is no model', () => {
  lib.setUiLanguage('zh');
  const outline = render(React.createElement(lib.OutlineAssistView, { state: { phase: 'nomodel' }, onDiscard() {} }), gone);
  assert.match(text(outline), /还没有可用的 AI 模型/); assert.match(text(outline), /让 AI 整理目录需要先配置模型/);
  assert.match(outline, /<button[^>]*>(?:<[^>]+>)*前往设置/);
  assert.match(text(outline), /知道了/, 'the way to dismiss it stays');
  const block = render(React.createElement(lib.TranslationBlock, { state: 'error', target: 'zh', error: { code: 'model' }, onDismiss() {} }), gone);
  assert.match(text(block), /翻译需要先在设置里连接模型/);
  assert.match(block, /<button[^>]*>(?:<[^>]+>)*前往设置/);
  assert.doesNotMatch(block, /重试/, 'a retry cannot help before a model is there');
  const menu = render(React.createElement(lib.TranslationMenu, { open: true, onOpenChange() {}, scopes: [], target: 'zh', modelAvailable: false, hasTranslations: false }), gone);
  assert.match(text(menu), /翻译需要先在设置里连接模型/);
  assert.match(menu, /<button[^>]*>(?:<[^>]+>)*前往设置/);
});

test('English: the fold, the gate and the reasons are English', () => {
  lib.setUiLanguage('en');
  try {
    const out = render(React.createElement(lib.LearningPanel, panel({ deckNote: 'The only deck this material is used by.', onQuick() {}, modelReady: false })), gone);
    assert.doesNotMatch(out, han, 'no Chinese anywhere, attributes included');
    assert.match(text(out), /More settings/); assert.match(text(out), /Go to settings/);
    const outline = render(React.createElement(lib.OutlineAssistView, { state: { phase: 'nomodel' }, onDiscard() {} }), gone);
    assert.doesNotMatch(outline, han);
    const block = render(React.createElement(lib.TranslationBlock, { state: 'error', target: 'zh', error: { code: 'model' }, onDismiss() {} }), gone);
    assert.doesNotMatch(block, han);
    const answered = answerNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' }), 'n1', 'a');
    assert.doesNotMatch(render(React.createElement(lib.LearningPanel, panel({ thread: answered, annotateReady: true, onMode() {}, onKeep() {} }))), han);
  } finally { lib.setUiLanguage('zh'); }
});
