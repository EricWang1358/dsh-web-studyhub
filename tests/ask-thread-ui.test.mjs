import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { addNode, answerNode, emptyThread, failNode, toggleNode } from '../ui/document-preview/ask-thread.js';

/* The learning panel's ask area: quick questions, the passage with its fold, and the thread of answers with clickable
   terms and the answers asked inside them. */

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/i18n.js';
  export { default as DocumentLearning, LearningPanel } from './ui/document-preview/DocumentLearning.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const lib = module.exports;
const render = props => renderToStaticMarkup(React.createElement(lib.LearningPanel, props));
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const selection = { sourceId: 's1', documentId: 'doc', revision: 'r1', quote: 'We ship logs to ELK.', start: 0, end: 20 };
const panel = (extra = {}) => ({ capture: { quote: selection.quote }, resolution: { status: 'resolved', selection }, question: '', thread: emptyThread(),
  deckId: 'd', decks: [{ id: 'd', title: 'Deck' }], askReady: true, generateReady: true, modelReady: true, jobs: [], now: 0, call() {}, saveReady: true, ...extra });
const built = () => {
  let thread = answerNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: '没听懂' }), 'n1', '这段在讲 [[ELK]] 和 [[日志]]。');
  return answerNode(addNode(thread, { id: 'n2', parentId: 'n1', question: 'what is ELK', term: 'ELK' }), 'n2', 'ELK 是 [[Kibana]] 的上游。');
};

test('the ask box offers quick questions that send at once, and a jump to the quiz form', () => {
  lib.setUiLanguage('zh');
  const out = render(panel());
  for (const chip of ['没听懂', '举个例子', '为什么', '和什么有区别', '出题考我']) assert.match(text(out), new RegExp(chip), chip);
  assert.match(out, /role="group"[^>]*aria-label="快捷提问"/);
  assert.equal((out.match(/<button[^>]*type="button"[^>]*>(?:<[^>]+>)*(?:没听懂|举个例子|为什么|和什么有区别|出题考我)/g) || []).length, 5, 'none of them submits the form');
  assert.ok(out.indexOf('快捷提问') < out.indexOf('依据原文回答'), 'the chips sit above the ask button');
});

test('answers: terms are buttons, a child opens under its parent with the path as its heading', () => {
  lib.setUiLanguage('zh');
  const out = render(panel({ thread: built() }));
  assert.match(out, /<h4 class="ask-node__title">没听懂<\/h4>/);
  assert.match(out, /<h4 class="ask-node__title">没听懂 › ELK<\/h4>/);
  assert.ok(out.indexOf('没听懂 › ELK') > out.indexOf('这段在讲'), 'the child comes after the parent answer');
  assert.ok(out.indexOf('data-ask-node="n2"') > out.indexOf('data-ask-node="n1"') && out.lastIndexOf('</section>') > out.indexOf('data-ask-node="n2"'), 'and inside it');
  assert.equal((out.match(/class="[^"]*md-term/g) || []).length, 3);
  assert.match(out, /md-term md-term--asked"[^>]*>ELK</, 'a term that already has an answer says so');
  assert.doesNotMatch(out, /\[\[/);
  assert.match(out, /data-depth="2"/);
  assert.match(out, /placeholder="接着问这一条"/);
  assert.match(text(out), /再简单点/, 'a child offers quick follow-ups');
  assert.equal((text(render(panel({ thread: answerNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' }), 'n1', 'a') }))).match(/再简单点/g) || []).length, 0, 'the first answer does not');
});

test('a pending answer holds its place; a failed one shows the reason and a retry', () => {
  lib.setUiLanguage('zh');
  const pending = render(panel({ thread: addNode(emptyThread(), { id: 'n1', parentId: null, question: '没听懂' }) }));
  assert.match(pending, /class="ask-node__pending muted" role="status"/);
  assert.match(pending, /<textarea[^>]*disabled/);
  const failed = render(panel({ thread: failNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' }), 'n1', 'offline') }));
  assert.match(text(failed), /offline/); assert.match(text(failed), /重试/);
});

test('a folded answer keeps its content in the page but hidden, and the toggle says what it opens', () => {
  lib.setUiLanguage('zh');
  const out = render(panel({ thread: toggleNode(built(), 'n2') }));
  assert.match(out, /id="ask-n2-body"[^>]*hidden/);
  assert.match(out, /aria-expanded="false"[^>]*aria-controls="ask-n2-body"|aria-controls="ask-n2-body"[^>]*aria-expanded="false"/);
});

test('a refusal is a plain sentence after the answers', () => {
  lib.setUiLanguage('zh');
  const out = render(panel({ thread: built(), notice: '问中问最多 3 层。' }));
  assert.ok(out.indexOf('ask-thread__notice') > out.indexOf('data-ask-node="n2"'));
});

test('a long passage is clamped with a fold toggle; a short one has none', () => {
  lib.setUiLanguage('zh');
  const long = render(panel({ capture: { quote: '很长的原文。'.repeat(60) } }));
  assert.match(long, /<button[^>]*aria-expanded="false"[^>]*aria-controls="study-passage-quote"[^>]*>(?:<[^>]+>)*展开/);
  assert.doesNotMatch(render(panel()), /aria-controls="study-passage-quote"/);
});

test('English: every new piece of the ask area is English', () => {
  lib.setUiLanguage('en');
  try {
    let thread = answerNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: 'I did not get it' }), 'n1', 'About [[ELK]].');
    thread = answerNode(addNode(thread, { id: 'n2', parentId: 'n1', question: 'what is ELK', term: 'ELK' }), 'n2', 'A stack.');
    const markup = render(panel({ thread, capture: { quote: 'Long passage. '.repeat(30) }, notice: 'x' }));
    assert.doesNotMatch(markup.replace(/<[^>]+>/g, m => m), han, 'no Chinese anywhere, attributes included');
    const out = text(markup);
    assert.match(out, /I did not get it/); assert.match(out, /Give an example/); assert.match(out, /Quiz me/);
    assert.match(out, /Simpler/); assert.match(out, /Expand/);
    assert.match(markup, /placeholder="Ask more about this one"/);
    assert.match(markup, /aria-label="Ask about (?:“|&quot;)ELK(?:”|&quot;)"/);
  } finally { lib.setUiLanguage('zh'); }
});
