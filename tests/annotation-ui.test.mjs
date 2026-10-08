import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { addNode, answerNode, emptyThread } from '../ui/document-preview/ask-thread.js';
import { annotationLinks, threadFromItems } from '../ui/document-preview/annotation/model.js';
import { groupPassageLinks } from '../ui/document-preview/selection.js';
import { buildLinkModel, groupTitle } from '../ui/document-preview/links/link-model.js';

/* 阅读 / 批注 in the learning panel and the reader's list: the mode switch, the note under the ask box, keeping a thread, the marks and the
   restored thread. Every explanation the interface owes the learner is a Tooltip (hover and keyboard focus, hidden by default). */

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/i18n.js';
  export { LearningPanel } from './ui/document-preview/DocumentLearning.jsx';
  export { default as AskThread, refusal } from './ui/document-preview/AskThread.jsx';
  export { default as PassageLinksPanel, linkTitleWords } from './ui/document-preview/links/PassageLinksPanel.jsx';
  export { default as StaleAnnotations } from './ui/document-preview/annotation/StaleAnnotations.jsx';
  export { default as Markdown } from './ui/Markdown.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const lib = module.exports;
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const selection = { sourceId: 's1', documentId: 'doc', revision: 'r1', quote: 'We ship logs to ELK.', start: 0, end: 20 };
const panel = (extra = {}) => ({ capture: { quote: selection.quote }, resolution: { status: 'resolved', selection }, question: '', thread: emptyThread(),
  deckId: 'd', decks: [{ id: 'd', title: 'Deck' }], askReady: true, generateReady: true, modelReady: true, jobs: [], now: 0, call() {}, saveReady: true,
  annotateReady: true, onMode() {}, onKeep() {}, onDeleteThread() {}, ...extra });
const answered = () => answerNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: '没听懂', label: '没听懂' }), 'n1', '这段在讲 [[ELK]]。');
/** The tooltips of a markup: [{ id, text }] and the elements that point at them. */
/* A tooltip is the last child of its anchor's wrapper, so it ends at the first two closing spans in a row. */
const tips = markup => [...markup.matchAll(/<span id="([^"]+)" role="tooltip"[^>]*>([\s\S]*?)<\/span><\/span>/g)].map(match => ({ id: match[1], text: text(match[2]) }));
const describedBy = (markup, id) => markup.split(/(?=<)/).filter(piece => piece.includes(`aria-describedby="${id}"`) || piece.includes(` ${id}"`) && piece.includes('aria-describedby'));
const anchored = (markup, tip) => describedBy(markup, tip.id).length > 0;

test('the switch is there, names both modes and explains them on hover and focus', () => {
  lib.setUiLanguage('zh');
  const out = render(lib.LearningPanel, panel());
  assert.match(out, /role="group"[^>]*aria-label="阅读与批注"/);
  assert.match(out, /aria-pressed="true"[^>]*>阅读<\/button>/); assert.match(out, /aria-pressed="false"[^>]*>批注<\/button>/);
  const tip = tips(out).find(item => /阅读：回答只在阅读器打开期间保留/.test(item.text));
  assert.ok(tip, 'the explanation exists');
  assert.match(tip.text, /关闭阅读器就会丢失/); assert.match(tip.text, /批注：每条回答都和这段原文一起保存，再选中这段时会回来/);
  assert.ok(anchored(out, tip), 'and the switch is tied to it');
  assert.match(out, /<button[^>]*tabindex="0"[^>]*aria-pressed="true"|<button[^>]*aria-pressed="true"[^>]*tabindex="0"/, 'the active segment can be focused');
  assert.doesNotMatch(out, /title="[^"]*批注/, 'no title attribute carries it');
  // Without the capability, or without a way to change it, there is no switch and no note.
  for (const extra of [{ annotateReady: false }, { onMode: undefined }]) assert.doesNotMatch(render(lib.LearningPanel, panel(extra)), /阅读与批注|阅读模式/);
});

test('the note under the ask box stays visible and says what 阅读 does; 批注 says it keeps', () => {
  lib.setUiLanguage('zh');
  const read = text(render(lib.LearningPanel, panel()));
  assert.match(read, /阅读模式：问答只在阅读器打开时保留。要留下来，点「存为批注」或切到批注。/);
  const annotate = text(render(lib.LearningPanel, panel({ mode: 'annotate' })));
  assert.match(annotate, /批注模式：每条回答都会和这段原文一起保存。/); assert.doesNotMatch(annotate, /阅读模式/);
  const markup = render(lib.LearningPanel, panel());
  assert.ok(markup.indexOf('阅读模式') > markup.indexOf('</form>') && markup.indexOf('阅读模式') < markup.indexOf('ask-thread') + markup.length, 'it sits right under the ask form');
  assert.doesNotMatch(markup.slice(markup.indexOf('阅读模式') - 80, markup.indexOf('阅读模式')), /hidden/, 'it is not hidden');
});

test('a thread can be kept with one click, and says where it will come back', () => {
  lib.setUiLanguage('zh');
  const out = render(lib.LearningPanel, panel({ thread: answered() }));
  assert.match(out, /<button[^>]*>(?:<[^>]+>)*存为批注/);
  const tip = tips(out).find(item => /把这组问答和这段原文一起存下来/.test(item.text));
  assert.ok(tip); assert.match(tip.text, /批注模式下再次选中这段，它们会回来，原文里也会标出这段/); assert.ok(anchored(out, tip));
  // Without the capability there is no button to promise anything.
  assert.doesNotMatch(render(lib.LearningPanel, panel({ thread: answered(), annotateReady: false })), /存为批注/);
  // Kept: it says so, and in 批注 mode it can be deleted.
  const kept = render(lib.LearningPanel, panel({ thread: answered(), savedIds: new Set(['n1']) }));
  assert.match(text(kept), /已存为批注/); assert.doesNotMatch(text(kept), /删除这组批注/);
  assert.match(text(render(lib.LearningPanel, panel({ thread: answered(), savedIds: new Set(['n1']), mode: 'annotate' }))), /删除这组批注/);
  assert.match(text(render(lib.LearningPanel, panel({ thread: answered(), keepError: '暂时无法保存为批注。' }))), /暂时无法保存为批注/);
});

test('a thread restored from kept items is shown as kept, with its path heading', () => {
  lib.setUiLanguage('zh');
  const items = [{ id: 'a', key: 'k', parentId: null, question: 'q', label: '没听懂', answer: '讲 [[ELK]]', status: 'resolved' }, { id: 'b', key: 'k', parentId: 'a', term: 'ELK', question: 'q2', answer: '是日志栈', status: 'resolved' }];
  const out = render(lib.LearningPanel, panel({ thread: threadFromItems(items), savedIds: new Set(['a', 'b']), mode: 'annotate' }));
  assert.match(out, /<h4 class="ask-node__title">没听懂 › ELK<\/h4>/);
  assert.match(text(out), /已存为批注/); assert.match(out, /md-term--asked/, 'the term that was asked is marked, so a click finds it');
});

test('the quick questions say which question they send, and that clicking sends it', () => {
  lib.setUiLanguage('zh');
  const out = render(lib.LearningPanel, panel());
  const found = tips(out);
  for (const question of ['这段我没听懂，请按原文顺序讲一下。', '请依据这段原文举一个例子。', '为什么会这样？请依据这段原文回答。', '这里的内容和什么容易混淆？有什么区别？']) {
    const tip = found.find(item => item.text.includes(`点击即发送：「${question}」`));
    assert.ok(tip, question); assert.doesNotMatch(tip.text, /按「依据原文回答」/); assert.ok(anchored(out, tip), question);
  }
  const quiz = found.find(item => /补充到现有题组/.test(item.text) && /不会自动出题/.test(item.text));
  assert.ok(quiz && anchored(out, quiz));
  // The anchors are the buttons themselves, so they take the keyboard focus.
  assert.equal((out.match(/<button[^>]*aria-describedby="[^"]+"[^>]*>(?:没听懂|举个例子|为什么|和什么有区别|出题考我)/g) || []).length, 5);
});

test('an answer to a term offers quick follow-ups that say they send at once', () => {
  lib.setUiLanguage('zh');
  const thread = answerNode(addNode(answered(), { id: 'n2', parentId: 'n1', question: 'x', term: 'ELK' }), 'n2', '是日志栈');
  const out = render(lib.AskThread, { thread, onAsk() {}, onRetry() {}, onToggle() {} });
  assert.ok(tips(out).some(item => /接着这条回答问：「请再简单一点，用更口语的话说。」。点击即发送/.test(item.text)));
  assert.ok(tips(out).some(item => /接着这条回答问：「请依据这段原文举一个例子。」。点击即发送/.test(item.text)));
});

test('a marked term explains itself on hover and focus: only this passage, opens under, nothing asked until the click', () => {
  lib.setUiLanguage('zh');
  const out = render(lib.Markdown, { text: '用 [[ELK]]。', onTerm() {} });
  const tip = tips(out)[0];
  assert.match(tip.text, /只用选中的这段原文解释这个词；答案会开在这条回答下面。点击前不会提问/);
  assert.match(out, /<button[^>]*aria-describedby="[^"]+"[^>]*>ELK<\/button>/, 'the term itself is the focusable anchor');
  assert.ok(anchored(out, tip));
});

test('the limit messages say why the limits exist, on hover and focus, and the message itself can be focused', () => {
  lib.setUiLanguage('zh');
  for (const reason of ['depth', 'nodes']) {
    const why = lib.refusal(reason);
    assert.match(why.text, /问中问最多 3 层|已有 8 条/); assert.equal(why.why, '每次提问都会调用一次模型，限制层数和条数是为了控制用量。');
    const out = render(lib.AskThread, { thread: answered(), notice: why.text, noticeWhy: why.why, onAsk() {}, onRetry() {}, onToggle() {} });
    const tip = tips(out).find(item => item.text.includes('每次提问都会调用一次模型'));
    assert.ok(tip && anchored(out, tip));
    assert.match(out, /<p class="ask-thread__notice" role="status" tabindex="0"[^>]*aria-describedby/);
  }
  assert.equal(lib.refusal('busy').why, '');
});

test('annotated passages are marked like the linked ones: one link per passage, a kind of its own, a way back into the thread', () => {
  lib.setUiLanguage('zh');
  const items = [{ id: 'a', key: 's1|0|20', parentId: null, question: '没听懂', label: '没听懂', answer: '讲 [[ELK]]', status: 'resolved', selection },
    { id: 'b', key: 's1|0|20', parentId: 'a', question: 'q', answer: 'b', status: 'resolved', selection }];
  const groups = groupPassageLinks(annotationLinks(items));
  const model = buildLinkModel(groups);
  assert.equal(model.groups.length, 1); assert.equal(model.groups[0].kind, 'annotation'); assert.equal(model.groups[0].counts.annotation, 1);
  assert.equal(groupTitle(model.groups[0], lib.linkTitleWords()), '批注 1');
  const opened = [];
  const out = render(lib.PassageLinksPanel, { model, focusedKey: model.groups[0].key, onFocus() {}, onOpen() {}, onAnnotation: link => opened.push(link) });
  assert.match(text(out), /批注/); assert.match(text(out), /2 条问答/); assert.match(text(out), /打开问答/);
  assert.doesNotMatch(out, /\[\[/, 'the markers never leak into the list');
  assert.match(out, /data-kind="annotation"/);
});

test('passages kept for an older revision are listed with a plain note and can be cleared; nothing is dropped', () => {
  lib.setUiLanguage('zh');
  const stale = [{ revision: 'old', count: 3, threads: [{ key: 'k', quote: 'We ship logs', question: '没听懂', nodes: 3 }] }];
  const out = render(lib.StaleAnnotations, { stale, onClear() {} });
  assert.match(text(out), /原文已更新 · 3 条批注/); assert.match(text(out), /原文已更新，需要重新定位/); assert.match(text(out), /We ship logs/); assert.match(text(out), /清除旧版本批注/);
  assert.equal(render(lib.StaleAnnotations, { stale: [] }), '');
});

test('English: the switch, the note, the keeping and every explanation are English', () => {
  lib.setUiLanguage('en');
  try {
    let thread = answerNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: 'I did not get it', label: 'I did not get it' }), 'n1', 'About [[ELK]].');
    thread = answerNode(addNode(thread, { id: 'n2', parentId: 'n1', question: 'x', term: 'ELK' }), 'n2', 'A stack.');
    const markup = render(lib.LearningPanel, panel({ thread, notice: 'x', noticeWhy: lib.refusal('depth').why }));
    assert.doesNotMatch(markup, han, 'no Chinese anywhere, attributes included');
    const out = text(markup);
    for (const phrase of ['Read', 'Annotation', 'Read mode: answers are kept only while the reader is open. To keep them, press “Keep as annotation” or switch to Annotation.', 'Keep as annotation',
      'Keeps these questions and answers together with this passage.', 'Every question calls the model once; the limits keep the usage down.',
      'Read: answers are kept only while the reader is open; closing the reader loses them.', 'Annotation: every answer is kept with the passage and comes back when you select it again.',
      'Sends at once: “I didn\'t get this passage. Please walk me through it in the order of the source.”', 'Nothing is generated automatically.',
      'Explains this word using only the selected passage; the answer opens under this one. Nothing is asked until you click.']) assert.ok(out.includes(phrase), phrase);
    assert.match(render(lib.LearningPanel, panel({ mode: 'annotate' })), /Annotation mode: every answer is kept with this passage\./);
    const kept = text(render(lib.LearningPanel, panel({ thread, savedIds: new Set(['n1', 'n2']), mode: 'annotate' })));
    assert.match(kept, /Kept as annotation/); assert.match(kept, /Delete these annotations/);
    assert.doesNotMatch(render(lib.StaleAnnotations, { stale: [{ revision: 'o', count: 1, threads: [{ key: 'k', quote: 'quote', question: 'q', nodes: 1 }] }], onClear() {} }), han);
  } finally { lib.setUiLanguage('zh'); }
});
