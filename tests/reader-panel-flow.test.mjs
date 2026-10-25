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
  export { ModelSettingsContext } from './ui/ModelErrorNote.jsx';
  export { default as PdfPageBar, pageBoxKey } from './ui/document-preview/reader/PdfPageBar.jsx';
  export { default as QuickIntents, PAGE_INTENTS, PASSAGE_INTENTS } from './ui/document-preview/QuickIntents.jsx';
  export { pageHandOffInput } from './ui/document-preview/PageAsk.jsx';
  export { hintClosed, closeHint, forgetClosedHints, READER_HINTS } from './ui/document-preview/reader/hints.js';
  export { askRequest, retryOf, pageDraftKey } from './ui/document-preview/ask-request.js';
  export { StudyServicesContext } from './ui/study-context.jsx';`, resolveDir: process.cwd() },
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

/* #456: in 原始 PDF the panel asks about the current page. It says which page, never shows an old selection, offers a free question box
   and the thread, and leaves what needs a passage (chips, 批注, 补充到现有题组) to 阅读. */
const pageScope = (extra = {}) => ({ kind: 'page', page: 3, sourceId: 'p3', empty: false, ...extra });
const pagePanel = (extra = {}) => panel({ capture: { quote: 'An old selection from 阅读' }, scope: pageScope(),
  resolution: { status: 'resolved', scope: 'page', selection: { documentId: 'doc', revision: 'r1', sourceId: 'p3', page: 3 } }, ...extra });

test('原始 PDF: the panel names the page, has a free question box, and shows no old selection', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.LearningPanel, pagePanel({ question: '这一页讲了什么？', onQuick() {} })));
  assert.match(text(out), /正在问：第 3 页/);
  assert.doesNotMatch(out, /An old selection/, 'the stale quote is not shown');
  assert.doesNotMatch(out, /study-passage__quote/);
  assert.match(text(out), /针对这一页提问/);
  assert.match(out, /<textarea[^>]*placeholder="输入或粘贴问题/);
  assert.match(out, /<button[^>]*type="submit"[^>]*>(?:<[^>]+>)*依据这一页回答/);
  assert.doesNotMatch(out, /disabled=""[^>]*>(?:<[^>]+>)*依据这一页回答/, 'a typed question can be sent');
  assert.doesNotMatch(out, />没听懂<|>出题考我<|<label>补充到现有题组|>存为批注</, 'what needs a passage stays in 阅读 (a page has chips of its own)');
  assert.match(text(out), /看原页/, 'figures are pointed to 看原页');
});

test('原始 PDF: an empty box, a missing model, a page without text and a cut page each say so', () => {
  lib.setUiLanguage('zh');
  assert.match(render(React.createElement(lib.LearningPanel, pagePanel())), /disabled=""[^>]*>(?:<[^>]+>)*依据这一页回答/);
  const gate = render(React.createElement(lib.LearningPanel, pagePanel({ question: 'q', modelReady: false, askReady: false })), gone);
  assert.match(gate, /<button[^>]*>(?:<[^>]+>)*前往设置|设置/);
  const blank = render(React.createElement(lib.LearningPanel, pagePanel({ scope: pageScope({ empty: true, sourceId: '' }), resolution: null })));
  assert.match(text(blank), /第 3 页没有保存文字（多半是扫描页或图片页）：换一页再问/);
  assert.doesNotMatch(blank, /<textarea/, 'nothing to ask from a page without text');
  const cut = render(React.createElement(lib.LearningPanel, pagePanel({ pageCut: { page: 3, chars: 9000, used: 8000, truncated: true } })));
  assert.match(text(cut), /回答只读了前 8000 字（共 9000 字）；后面的内容请在「阅读」里选中再问/);
  const stale = render(React.createElement(lib.LearningPanel, pagePanel({ question: 'q', resolution: { status: 'stale' } })));
  assert.match(text(stale), /这份资料刚更新过：关掉阅读器再打开，就能接着问这一页/);
});

test('原始 PDF: the page controls step, take a typed number and say the total', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.PdfPageBar, { page: 1, total: 12, onPage() {} }));
  assert.match(out, /aria-label="原始 PDF 翻页"/);
  assert.match(out, /<button[^>]*disabled=""[^>]*aria-label="上一页"|<button[^>]*aria-label="上一页"[^>]*disabled=""/, 'no page before the first');
  assert.match(out, /<input[^>]*type="number"[^>]*aria-label="页码"|<input[^>]*aria-label="页码"[^>]*type="number"/);
  assert.match(text(out), /\/ 12 页/);
  const inPanel = render(React.createElement(lib.LearningPanel, pagePanel({ pageTotal: 3, onPage() {} })));
  assert.match(inPanel, /class="study-page-ask__step"/, 'the panel turns pages too (a narrow panel covers the controls)');
  assert.match(inPanel, /<button[^>]*disabled=""[^>]*aria-label="下一页"|<button[^>]*aria-label="下一页"[^>]*disabled=""/, 'page 3 of 3 has no next page');
  const last = render(React.createElement(lib.PdfPageBar, { page: 12, total: 12, onPage() {} }));
  assert.match(last, /<button[^>]*disabled=""[^>]*aria-label="下一页"|<button[^>]*aria-label="下一页"[^>]*disabled=""/, 'no page after the last');
});

test('原始 PDF: the reading panel keeps its 补题 job cards on screen and nothing else; without jobs it draws nothing', () => {
  lib.setUiLanguage('zh');
  const job = { operationId: 'op1', id: 'j1', status: 'running', stageCode: 'writing', deckId: 'd', selection, count: 2, startedAt: new Date(0).toISOString() };
  const out = render(React.createElement(lib.LearningPanel, panel({ jobsOnly: true, jobs: [job], onCancel() {}, onRetry() {}, onDismiss() {} })));
  assert.match(out, /data-jobs-only="true"/);
  assert.match(out, /class="selection-jobs"/, 'the job card is there');
  assert.doesNotMatch(out, /study-passage__quote|<textarea|补充到现有题组/, 'the passage and the forms wait for 阅读');
  assert.equal(render(React.createElement(lib.LearningPanel, panel({ jobsOnly: true, jobs: [] }))), '');
});

test('原始 PDF: Escape in the page box puts the page back and stays in the reader; Enter applies it', () => {
  const event = key => { const seen = { key, prevented: false, stopped: false }; return Object.assign(seen, { preventDefault() { seen.prevented = true; }, stopPropagation() { seen.stopped = true; } }); };
  const calls = [];
  const escape = event('Escape');
  assert.equal(lib.pageBoxKey(escape, { apply: () => calls.push('apply'), reset: () => calls.push('reset') }), true);
  assert.deepEqual(calls, ['reset']); assert.ok(escape.prevented && escape.stopped, 'like FindBar: the reader dialog never sees this Escape');
  const enter = event('Enter');
  lib.pageBoxKey(enter, { apply: () => calls.push('apply'), reset: () => calls.push('reset') });
  assert.deepEqual(calls, ['reset', 'apply']); assert.ok(enter.prevented && !enter.stopped);
  const other = event('5');
  assert.equal(lib.pageBoxKey(other, { apply() {}, reset() {} }), false); assert.ok(!other.prevented && !other.stopped);
});

test('原始 PDF: a refused page question is said beside the page, which stays the page asked about (重试 asks about it again)', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.LearningPanel, pagePanel({ question: 'q', pageRefusal: { status: 'stale' } })));
  assert.match(text(out), /正在问：第 3 页/);
  assert.match(text(out), /这份资料刚更新过：关掉阅读器再打开，就能接着问这一页/);
  assert.doesNotMatch(text(out), /这段引用需要在当前原文中重新选择/, 'never the wording of a selection');
  assert.match(text(out), /可以复制，粘贴进问题框/, 'a selection made inside the PDF can be pasted in');
});

test('English: the page panel and the page controls are English', () => {
  lib.setUiLanguage('en');
  try {
    for (const extra of [{ question: 'q' }, { scope: pageScope({ empty: true }) }, { pageCut: { chars: 9000, used: 8000, truncated: true } }, { resolution: { status: 'missing' } }]) {
      const out = render(React.createElement(lib.LearningPanel, pagePanel(extra)), gone);
      assert.doesNotMatch(out.replace(/An old selection from 阅读/g, ''), han, JSON.stringify(extra));
    }
    assert.match(text(render(React.createElement(lib.LearningPanel, pagePanel()))), /Asking about page 3/);
    assert.doesNotMatch(render(React.createElement(lib.PdfPageBar, { page: 2, total: 5, onPage() {} })), han);
  } finally { lib.setUiLanguage('zh'); }
});

/* #456 PR 2: preset questions for a page, and 发给主会话 where the built-in answer cannot help (a figure, a scanned page). */
const services = { askInChat: async () => 'filled', notify() {}, call: async () => ({}), act: async () => undefined, busy: false, host: {}, openSettings() {}, navigate() {}, openModal() {} };
const withStudy = element => React.createElement(lib.StudyServicesContext.Provider, { value: services }, element);
const pageHandOff = { title: 'Scheduling', page: 3, text: 'Page 3 line 1 explains part 3.' };

test('原始 PDF: four preset chips say 这一页 and ask at once with their own intent; the chips of a passage are unchanged', () => {
  lib.setUiLanguage('zh');
  const out = render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {} })));
  assert.match(out, /role="group"[^>]*aria-label="快捷提问"/);
  for (const chip of ['讲解这一页', '翻译这一页', '按知识点拆分这一页', '提取这一页的公式与代码']) assert.match(text(out), new RegExp(chip), chip);
  assert.match(out, /点击即发送：「请按原文顺序讲解这一页。」/, 'the hover says the exact question that is sent');
  assert.doesNotMatch(out, /没听懂|出题考我|这段原文/, 'no chip of a passage on a page');
  assert.deepEqual(lib.PAGE_INTENTS.map(chip => chip.intent), ['explain', 'translate', 'points', 'extract']);
  assert.deepEqual(lib.PASSAGE_INTENTS.map(chip => chip.label), ['没听懂', '举个例子', '为什么', '和什么有区别']);
  assert.ok(lib.PASSAGE_INTENTS.every(chip => !chip.intent), 'the passage chips send what they sent before');
  const asking = addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
  assert.match(/<button[^>]*>(?:<[^>]+>)*讲解这一页/.exec(render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {}, thread: asking }))))[0], /disabled/, 'they wait while an answer is coming');
});

test('原始 PDF: 发给主会话 is a quiet link under the answers on a page with text, and the way forward on a page without text', () => {
  lib.setUiLanguage('zh');
  const out = render(withStudy(React.createElement(lib.LearningPanel, pagePanel({ question: '图 2 说明了什么？', pageHandOff }))));
  assert.match(out, /data-hand-off="reader\.page"/);
  assert.match(out, /sh-handoff--quiet/, 'a quiet line, never a button of the main path');
  assert.ok(out.indexOf('data-hand-off="reader.page"') > out.indexOf('依据这一页回答'), 'under the box and the answers');
  assert.match(text(out), /想让主会话接着讲（可附截图）：/);
  assert.doesNotMatch(text(out), /主会话能看图(?!片时)/, 'never a promise that the chat reads pictures');
  const blank = render(withStudy(React.createElement(lib.LearningPanel, pagePanel({ scope: pageScope({ empty: true, sourceId: '' }), resolution: null, pageHandOff: { ...pageHandOff, text: '' } }))));
  assert.match(blank, /data-hand-off="reader\.page"[^>]*>|sh-btn--secondary[^>]*data-hand-off="reader\.page"/);
  assert.match(blank, /sh-btn--secondary/, 'the one action of a page without text');
  assert.match(text(blank), /先点按钮，再截这一页的图；主会话能看图片时/);
  assert.doesNotMatch(render(React.createElement(lib.LearningPanel, pagePanel({ pageHandOff }))), /data-hand-off/, 'not offered where nothing can take it (no app around the reader)');
});

test('English: the page chips and the page hand-off are English', () => {
  lib.setUiLanguage('en');
  try {
    const out = render(withStudy(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {}, pageHandOff }))));
    assert.doesNotMatch(out.replace(/An old selection from 阅读/g, ''), han);
    const blank = render(withStudy(React.createElement(lib.LearningPanel, pagePanel({ scope: pageScope({ empty: true }), resolution: null, pageHandOff }))));
    assert.doesNotMatch(blank, han);
  } finally { lib.setUiLanguage('zh'); }
});

/* #482 review: what a chip click and a 重试 send, the question of a page stays on its page, and 翻译这一页 says what it is. */
const buttonsOf = element => {
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props?.onClick && typeof node.props.children === 'string') found.push(node);
    walk(node.props?.children);
  };
  walk(element);
  return found;
};

test('a page chip sends its question, its name and its intent; the request carries the intent and the page scope', () => {
  lib.setUiLanguage('zh');
  const asked = [];
  const chips = buttonsOf(lib.QuickIntents({ chips: lib.PAGE_INTENTS, onAsk: (...args) => asked.push(args) }));
  assert.equal(chips.length, 4);
  chips[1].props.onClick();
  assert.deepEqual(asked[0], ['请把这一页完整翻译过来，保持原来的顺序。', '翻译这一页', 'translate']);
  assert.deepEqual(lib.askRequest({ selection: { page: 2 }, page: true, question: asked[0][0], intent: asked[0][2], language: '中文' }),
    { selection: { page: 2 }, scope: 'page', question: '请把这一页完整翻译过来，保持原来的顺序。', intent: 'translate', language: '中文', terms: true });
  // a passage chip sends what it sent before: no intent, no scope
  const passage = [];
  buttonsOf(lib.QuickIntents({ chips: lib.PASSAGE_INTENTS, onAsk: (...args) => passage.push(args), onQuiz() {} }))[0].props.onClick();
  assert.equal(passage[0][2], undefined);
  assert.deepEqual(Object.keys(lib.askRequest({ selection: {}, question: 'q', language: '中文' })).sort(), ['language', 'question', 'selection', 'terms']);
});

test('重试 asks the same preset again; a follow-up carries its term and thread', () => {
  const node = { id: 'n1', question: '请把这一页按知识点拆开', term: '', intent: 'points', status: 'failed' };
  assert.deepEqual(lib.retryOf(node), { question: '请把这一页按知识点拆开', term: '', intent: 'points' });
  assert.equal(lib.askRequest({ selection: {}, page: true, ...lib.retryOf(node), language: '中文' }).intent, 'points');
  assert.deepEqual(lib.retryOf({ question: 'q' }), { question: 'q', term: '', intent: '' });
  const inside = lib.askRequest({ selection: {}, question: 'q', term: 'ELK', context: [{ question: 'a', answer: 'b' }], language: 'English' });
  assert.equal(inside.term, 'ELK'); assert.deepEqual(inside.thread, [{ question: 'a', answer: 'b' }]);
});

test('a question typed on one page is never sent from another, nor from a page without saved text', () => {
  assert.notEqual(lib.pageDraftKey({ kind: 'page', page: 2, sourceId: 'p2' }), lib.pageDraftKey({ kind: 'page', page: 4, sourceId: 'p4' }));
  assert.equal(lib.pageDraftKey(null), '');
  const handOff = { title: 'Scheduling', page: 4, text: '' };
  assert.deepEqual(lib.pageHandOffInput(handOff, '图 2 说明了什么？', true), { ...handOff, question: '' });
  assert.equal(lib.pageHandOffInput({ ...handOff, page: 2, text: 't' }, 'q', false).question, 'q');
});

test('翻译这一页 says on hover that it is a one-off answer, not the reader\'s own translation', () => {
  lib.setUiLanguage('zh');
  const chip = lib.PAGE_INTENTS.find(item => item.intent === 'translate');
  assert.match(chip.note, /不会保存；整份资料的对照翻译在「阅读」工具栏的「翻译」里/);
  lib.setUiLanguage('en');
  try { assert.doesNotMatch(render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {} }))), han); } finally { lib.setUiLanguage('zh'); }
});

/* #456 PR 3: first-visit hints (once, closed for good), friendlier refusals that say what to do next, chips in an even grid. */
test('first visit: the page hint and the presets hint are there, each closable; a closed hint stays closed in this browser', async () => {
  lib.setUiLanguage('zh');
  lib.forgetClosedHints();
  const out = render(withStudy(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {}, pageHandOff }))));
  assert.match(text(out), /这里问的是第 3 页：用翻页按钮换页，在 PDF 里滚动不会改变要问的页。/);
  assert.match(text(out), /点一个预设就直接提问；图表或扫描页可以「发给主会话」，截图只在主会话能看图片时有用。/);
  assert.equal((out.match(/data-reader-hint="/g) || []).length, 2);
  assert.equal((out.match(/aria-label="不再提示：问的是哪一页"/g) || []).length, 1, 'the page hint closes with its own name');
  assert.equal((out.match(/aria-label="不再提示：预设和发给主会话"/g) || []).length, 1, 'the presets hint closes with its own name');
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  assert.equal(lib.hintClosed(lib.READER_HINTS.page, storage), false);
  assert.equal(lib.closeHint(lib.READER_HINTS.page, storage), true);
  assert.equal(lib.hintClosed(lib.READER_HINTS.page, storage), true);
  assert.equal(lib.hintClosed(lib.READER_HINTS.presets, storage), false, 'one hint at a time');
  lib.closeHint(lib.READER_HINTS.page, storage);
  assert.deepEqual(JSON.parse(store.get('study-reader-hints')), ['pdf-page'], 'remembered once');
  lib.forgetClosedHints();
  assert.equal(lib.hintClosed(lib.READER_HINTS.page, storage), true, 'a stored closing survives a new visit');
  assert.equal(lib.hintClosed('pdf-page', null), false, 'no storage: a new visit shows it again, never an error');
  // the presets hint only where there are presets (not on a page without saved text)
  const blank = render(withStudy(React.createElement(lib.LearningPanel, pagePanel({ scope: pageScope({ empty: true }), resolution: null, pageHandOff }))));
  assert.doesNotMatch(text(blank), /点一个预设就直接提问/);
  assert.doesNotMatch(text(blank), /粘贴进问题框/, 'no word about a box that is not there');
});

test('a hint closed without browser storage stays closed when the panel is opened again in this visit', () => {
  lib.setUiLanguage('zh');
  lib.forgetClosedHints();
  const shown = () => render(withStudy(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {}, pageHandOff }))));
  assert.match(text(shown()), /这里问的是第 3 页/);
  assert.equal(lib.closeHint(lib.READER_HINTS.page, null), false, 'a blocked browser cannot store it');
  assert.equal(lib.hintClosed(lib.READER_HINTS.page, null), true, 'this visit still remembers the closing');
  const again = text(shown());
  assert.doesNotMatch(again, /这里问的是第 3 页/, 'closing and opening the panel must not bring the hint back');
  assert.match(again, /点一个预设就直接提问/, 'the other hint is untouched');
  lib.forgetClosedHints();
  assert.match(text(shown()), /这里问的是第 3 页/, 'a new visit shows it again');
  lib.forgetClosedHints();
});

test('refusals and empty states say what to do next, in one sentence each', () => {
  lib.setUiLanguage('zh');
  const said = status => text(render(React.createElement(lib.LearningPanel, pagePanel({ question: 'q', pageRefusal: { status } }))));
  assert.match(said('missing'), /这一页没有能核对的文字：换一页再问，或用「发给主会话」，截图只在主会话能看图片时有用。/);
  assert.match(said('ambiguous'), /这一页对应了好几段文字：切换到「阅读」，选中要问的那一段。/);
  assert.match(said('unavailable'), /现在没有可用的模型：先在设置里连上模型，再回来问。/);
  assert.match(said('other'), /这一页暂时问不了：稍后再试一次。/);
  // without an app around the reader there is no hand-off, so the empty page does not point to one
  const bare = text(render(React.createElement(lib.LearningPanel, pagePanel({ scope: pageScope({ empty: true }), resolution: null }))));
  assert.match(bare, /第 3 页没有保存文字（多半是扫描页或图片页）：换一页再问，或在「阅读」里点「看原页」看这一页的图。/);
  assert.doesNotMatch(bare, /发给主会话/);
});

test('the page chips sit in an even two-column grid; the original-PDF notice is one short sentence', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../ui/document-preview/document-preview.css', import.meta.url), 'utf8');
  assert.match(css, /\.study-page-ask \.ask-quick \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  const viewer = await readFile(new URL('../ui/document-preview/DocumentViewer.jsx', import.meta.url), 'utf8');
  const notice = viewer.match(/view === 'original' && !localMode && <p key="pdf" className="reader-pdf-note">\{ui\('([^']+)'\)\}/)?.[1];
  assert.equal(notice, '在原始 PDF 里按页提问（「学习工具」）；要问选中的一段，请切换到「阅读」。');
  assert.ok(notice.length <= 40, 'one line on a phone-width reader, two at most');
});

test('English: the hints and the new sentences are English', () => {
  lib.setUiLanguage('en');
  try {
    for (const extra of [{ onQuick() {}, pageHandOff }, { pageRefusal: { status: 'missing' } }, { pageRefusal: { status: 'unavailable' } }, { scope: pageScope({ empty: true }), resolution: null },
      { pageCut: { chars: 9000, used: 8000, truncated: true } }]) {
      const out = render(withStudy(React.createElement(lib.LearningPanel, pagePanel(extra))));
      assert.doesNotMatch(out.replace(/An old selection from 阅读/g, ''), han, JSON.stringify(Object.keys(extra)));
    }
  } finally { lib.setUiLanguage('zh'); }
});
