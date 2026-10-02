/* The bilingual reading in the reader, as the learner meets it: every state of a translation block, the display row, the 译
   popover, the job's progress line and the glossary, in both languages. The layout is checked in the browser journey
   (scripts/qa/translation.mjs); this guards the markup, the copy, the accessibility attributes and that translations, comments
   and quoted passages are shown as text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTextMeasure, estimateRun } from '../lib/token-estimate.js';

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js';
  export { default as TranslationBlock } from './ui/document-preview/translation/TranslationBlock.jsx';
  export { TranslationDisplayRow, TranslationMenu, TranslationJobCard, SelectionChip } from './ui/document-preview/translation/TranslationMenu.jsx';
  export { default as GlossaryDialog } from './ui/document-preview/translation/GlossaryDialog.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
function load() {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const lib = load();
const h = React.createElement;
const render = (element, language = 'zh') => { lib.setUiLanguage(language); return renderToStaticMarkup(element); };
const count = (text, pattern) => (text.match(pattern) || []).length;
const noop = () => {};
const handlers = { onToggle: noop, onCopy: noop, onDelete: noop, onRetranslate: noop, onGlossary: noop, onCancel: noop, onRetry: noop, onUndo: noop, onDismiss: noop };

const item = (extra = {}) => ({ key: 's|k|0', kind: 'paragraph', sourceId: 's', quote: 'A platform lets two groups find each other.', target: 'zh', text: '平台让两类人群找到彼此。', version: 1, history: [], warnings: [], outdated: false, parts: 1, ...extra });
const block = (props, language) => render(h(lib.TranslationBlock, { target: 'zh', open: true, ...handlers, ...props }), language);
const estimate = estimateRun('translate', { target: 'zh', calls: [{ system: 'S'.repeat(900), prompt: JSON.stringify({ passages: ['p'] }), chars: 600, items: 4 }] }, { measure: createTextMeasure() });

/* ---------- the block ---------- */

test('a translation block is a labelled note in the language of the translation, with a collapse handle and the 译 tag', () => {
  const markup = block({ state: 'ok', item: item() });
  assert.match(markup, /role="note"/);
  assert.match(markup, /aria-label="译文"/);
  assert.match(markup, /lang="zh-Hans"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /aria-label="收起译文"/);
  assert.match(markup, /class="tr-block__tag"[^>]*>译</);
  assert.match(markup, /平台让两类人群找到彼此。/);
  assert.match(markup, /aria-haspopup="menu"/, 'the ⋯ menu');
  assert.equal(count(markup, /role="menuitem"/g), 0, 'the menu is closed until it is asked for');
  const english = block({ state: 'ok', item: item({ target: 'en', text: 'A platform lets two groups find each other.' }), target: 'en' });
  assert.match(english, /lang="en"/);
  assert.match(english, />EN</);
});

test('the translation, the learner\'s comment and the quoted passage are text, never markup', () => {
  const evil = '<img src=x onerror=alert(1)> 译文 <script>alert(2)</script>';
  const markup = block({ state: 'ok', item: item({ text: evil, version: 3, comment: '<b>更口语</b>', kind: 'selection', quote: '<i>quoted</i>', history: [{ version: 2, text: '<u>old</u>', comment: '<s>x</s>' }] }) });
  assert.doesNotMatch(markup, /<img|<script|<b>|<i>|<u>|<s>/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /v3 · 意见：&lt;b&gt;更口语&lt;\/b&gt;/);
  assert.match(markup, /&lt;i&gt;quoted&lt;\/i&gt;/);
});

test('a second version shows its number and the comment that made it; the earlier versions are listed', () => {
  const markup = block({ state: 'ok', item: item({ version: 3, comment: '更正式一点', history: [{ version: 1, text: '甲', at: 'x' }, { version: 2, text: '乙', comment: '短一点', at: 'y' }] }) });
  assert.match(markup, /v3 · 意见：更正式一点/);
  assert.match(markup, /历史版本 · 2/);
  assert.ok(markup.indexOf('乙') < markup.indexOf('甲'), 'newest earlier version first');
  assert.match(markup, /意见：短一点/);
  assert.doesNotMatch(block({ state: 'ok', item: item() }), /历史版本|v1/);
});

test('a collapsed block keeps its bar and a one-line preview; an outdated one says why and offers a retranslation', () => {
  const folded = block({ state: 'ok', item: item({ text: '一二三四五六七八九十'.repeat(30) }), open: false });
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /aria-label="展开译文"/);
  assert.match(folded, /tr-block__preview/);
  assert.doesNotMatch(folded, /tr-block__text/);
  const stale = block({ state: 'ok', item: item({ outdated: true }) });
  assert.match(stale, /术语表已改/);
  assert.match(stale, /术语表改过了，这段译文可能不一致。/);
  assert.match(stale, /重新翻译/);
  const warn = block({ state: 'ok', item: item({ warnings: ['numbers'], parts: 3, reused: true }) });
  assert.match(warn, /数字和原文对不上/);
  assert.match(warn, /已分成 3 小段/);
  assert.match(warn, /没有再调用模型/);
});

test('a block under way says so and can be cancelled; a retranslation keeps the old text, dimmed', () => {
  const pending = block({ state: 'pending' });
  assert.match(pending, /role="status"/);
  assert.match(pending, /正在翻译…/);
  assert.match(pending, />取消</);
  const again = block({ state: 'pending', item: item(), pendingKind: 'retranslate' });
  assert.match(again, /data-state="busy"/);
  assert.match(again, /平台让两类人群找到彼此。/);
  assert.match(again, /正在重新翻译…/);
});

test('every reason a passage was not translated is said plainly, with a retry only where one can help', () => {
  const model = block({ state: 'error', error: { code: 'model' } });
  assert.match(model, /role="alert"/);
  assert.match(model, /还没有连接模型/);
  assert.doesNotMatch(model, />重试</, 'a retry cannot help without a model');
  assert.match(block({ state: 'error', error: { code: 'refusal' } }), /模型拒绝或在解释，没有翻译/);
  assert.match(block({ state: 'error', error: { code: 'length' } }), /译文的长度和原文对不上/);
  assert.match(block({ state: 'error', error: { code: 'refusal' } }), />重试</);
  assert.match(block({ state: 'error', error: { code: 'ambiguous' } }), /出现了多次/);
  assert.match(block({ state: 'error', error: { code: 'missing' } }), /模型漏了这一段|找不到这段文字/);
  assert.match(block({ state: 'error', error: { code: 'weird', message: 'boom' } }), /这段没有译成：boom/);
});

test('a deleted translation can be undone for a few seconds', () => {
  const markup = block({ state: 'undo' });
  assert.match(markup, /已删除这段翻译/);
  assert.match(markup, />撤销</);
  assert.match(markup, /role="status"/);
});

test('English renders every block state without Chinese except the translation itself and the learner\'s own words', () => {
  const own = '平台让两类人群找到彼此。', comment = '更口语一点';
  const states = [block({ state: 'ok', item: item({ version: 2, comment, history: [{ version: 1, text: own }], outdated: true, warnings: ['numbers'], parts: 2, reused: true }) }, 'en'),
    block({ state: 'ok', item: item(), open: false }, 'en'), block({ state: 'pending' }, 'en'), block({ state: 'pending', item: item(), pendingKind: 'retranslate' }, 'en'), block({ state: 'undo' }, 'en'),
    ...['model', 'refusal', 'length', 'untranslated', 'empty', 'missing', 'format', 'ambiguous', 'unlocated', 'x'].map(code => block({ state: 'error', error: { code, message: 'x' } }, 'en'))];
  for (const markup of states) assert.doesNotMatch(markup.replaceAll(own, '').replaceAll(comment, ''), han);
  assert.match(states[0], /Comment|comment: 更口语一点/);
  assert.match(states[0], /Earlier versions · 1/);
  assert.match(states[0], /aria-label="Translation"/);
});

/* ---------- the display row and the popover ---------- */

test('the Aa row offers four ways to draw translations, the current one pressed; the narrow note appears only for 左右分栏', () => {
  const row = (props, language) => render(h(lib.TranslationDisplayRow, { mode: 'pairs', target: 'zh', narrow: false, onChange: noop, ...props }), language);
  const markup = row();
  for (const label of ['逐段对照', '左右分栏', '仅中文', '隐藏译文']) assert.match(markup, new RegExp(`>${label}<`));
  assert.equal(count(markup, /aria-pressed="true"/g), 1);
  assert.match(markup, /aria-pressed="true"[^>]*>逐段对照</);
  assert.doesNotMatch(markup, /窗口较窄/);
  assert.match(row({ mode: 'side', narrow: true }), /窗口较窄，现在按逐段对照显示。/);
  assert.doesNotMatch(row({ mode: 'pairs', narrow: true }), /窗口较窄/);
  assert.match(row({ target: 'en' }), />仅英文</);
  const english = row({ mode: 'only' }, 'en');
  assert.doesNotMatch(english, han);
  for (const label of ['Paragraph pairs', 'Side by side', 'Chinese only', 'Hide translations']) assert.match(english, new RegExp(`>${label}<`));
  assert.match(english, /aria-pressed="true"[^>]*>Chinese only</);
});

const scopes = [{ id: 'page', label: '翻译本页', status: 'ready', counts: { toTranslate: 8, cached: 4 }, estimate },
  { id: 'chapter', label: '翻译本章', status: 'ready', counts: { toTranslate: 0, cached: 20 }, estimate: null }];
const menu = (props, language) => render(h(lib.TranslationMenu, { open: true, onOpenChange: noop, scopes, target: 'zh', modelAvailable: true, stale: [], busy: false, hasTranslations: true,
  onStart: noop, onExpandAll: noop, onCollapseAll: noop, onGlossary: noop, onTarget: noop, ...props }), language);

test('the 译 popover prices each scope before anything starts, says what is left, and starts only on a click', () => {
  const markup = menu();
  assert.match(markup, /aria-label="中英对照翻译"/);
  assert.match(markup, /翻译本页/);
  assert.match(markup, /还有 8 段要译 · 已译 4 段/);
  assert.match(markup, /预计/, 'the price (the shared token estimate line) comes first');
  assert.match(markup, /已经全部译好。/);
  assert.equal(count(markup, />开始翻译</g), 1, 'a scope with nothing to do has no start button');
  assert.match(markup, /后台进行，可以继续阅读，关闭阅读器也不会中断，完成后进信箱。/);
  for (const text of ['展开本页全部译文', '收起本页全部译文', '术语表…', '简体中文', 'English']) assert.match(markup, new RegExp(text));
  assert.match(markup, /aria-pressed="true"[^>]*>简体中文</);
});

test('without a model the popover says so plainly and the start button is off; a running job also switches it off', () => {
  const none = menu({ modelAvailable: false });
  assert.match(none, /还没有连接模型，没法翻译；已有的译文照常显示，阅读不受影响。/);
  assert.match(none, /<button[^>]*disabled[^>]*>开始翻译</);
  assert.match(menu({ busy: true }), /<button[^>]*disabled[^>]*>开始翻译</);
  assert.match(menu({ scopes: [{ id: 'page', label: '翻译本页', status: 'loading' }] }), /正在数段落…/);
  assert.match(menu({ scopes: [{ id: 'page', label: '翻译本页', status: 'error' }] }), /没能估算/);
  assert.match(menu({ stale: [{ revision: 'r0', count: 3 }, { revision: 'r1', count: 2 }] }), /旧版本里还有 5 段译文/);
  assert.match(menu({ hasTranslations: false }), /disabled[^>]*>展开本页全部译文/);
});

test('English: the popover has no Chinese', () => {
  const english = render(h(lib.TranslationMenu, { open: true, onOpenChange: noop, scopes: scopes.map(scope => ({ ...scope, label: scope.id === 'page' ? 'Translate this page' : 'Translate this chapter' })),
    target: 'en', modelAvailable: false, stale: [{ revision: 'r', count: 1 }], busy: false, hasTranslations: true, onStart: noop, onExpandAll: noop, onCollapseAll: noop, onGlossary: noop, onTarget: noop }), 'en');
  assert.doesNotMatch(english, han);
  assert.match(english, /8 to translate · 4 done/);
  assert.match(english, /Start translating/);
  assert.match(english, /No model is connected/);
});

/* ---------- the job ---------- */

const running = { id: 'j1', status: 'running', startedAt: '2026-10-01T08:00:00.000Z', runStartedAt: '2026-10-01T08:00:00.000Z', total: 15, done: 6, scopeLabel: '本页', rejected: 0, estimate: { totalTokens: { low: 4000, high: 9000 }, calls: { low: 3, high: 3 } }, tokenUsage: { uncachedInputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } };
const jobCard = (job, language) => render(h(lib.TranslationJobCard, { job, now: Date.parse('2026-10-01T08:01:05.000Z'), onStop: noop, onDismiss: noop }), language);

test('a running job shows counts, the clock, a progress bar, what it used against what was expected, and a stop', () => {
  const markup = jobCard(running);
  assert.match(markup, /正在翻译 · 本页/);
  assert.match(markup, /已处理 6 \/ 15 段 · 已用 1:05/);
  assert.match(markup, /role="progressbar"[^>]*aria-valuemax="15"[^>]*aria-valuenow="6"/);
  assert.match(markup, /scaleX\(0\.4\)/);
  assert.match(markup, />停止</);
  assert.match(markup, /后台继续翻译/);
  assert.match(markup, /实际用量/);
  assert.match(markup, /预计/);
  assert.doesNotMatch(markup, />知道了</);
});

test('a finished job says what happened, with the rejected count and a dismiss; a failed one has its technical detail; a queued one waits', () => {
  const done = jobCard({ ...running, status: 'complete', done: 15, rejected: 2, finishedAt: '2026-10-01T08:01:00.000Z' });
  assert.match(done, /翻译完成，有几段没译成/);
  assert.match(done, /用时 1:00/);
  assert.match(done, /有 2 段没通过检查/);
  assert.match(done, />知道了</);
  assert.doesNotMatch(done, />停止</);
  const failed = jobCard({ ...running, status: 'failed', stage: 'The provider is down', finishedAt: '2026-10-01T08:00:30.000Z' });
  assert.match(failed, /翻译没有完成/);
  assert.match(failed, /技术详情/);
  assert.match(failed, /The provider is down/);
  assert.match(jobCard({ ...running, status: 'cancelled', finishedAt: '2026-10-01T08:00:30.000Z' }), /翻译已停止/);
  assert.match(jobCard({ ...running, status: 'queued', total: 15, done: 0 }), /翻译排队中/);
  assert.match(jobCard({ ...running, status: 'cancelling' }), /正在停止翻译…/);
  assert.doesNotMatch(jobCard({ ...running, status: 'cancelling' }), />停止</);
});

test('English: the job line is English; the label the learner chose stays as it is', () => {
  const markup = jobCard({ ...running, scopeLabel: 'This page', tokenUsage: undefined, estimate: undefined }, 'en');
  assert.doesNotMatch(markup, han);
  assert.match(markup, /Translating · This page/);
  assert.match(markup, /6 \/ 15 paragraphs handled · Elapsed 1:05/);
  assert.doesNotMatch(jobCard({ ...running, scopeLabel: 'This page', status: 'complete', rejected: 1, tokenUsage: undefined, estimate: undefined, finishedAt: '2026-10-01T08:01:00.000Z' }, 'en'), han);
});

/* ---------- the chip and the glossary ---------- */

test('the selection chip names its action, including the shortcut, and turns into a cancel while it works', () => {
  const chip = props => render(h(lib.SelectionChip, { left: 10, top: 20, target: 'zh', onClick: noop, onCancel: noop, ...props }));
  assert.match(chip(), /aria-label="翻译选中的文字（Alt\+T）"/);
  assert.match(chip(), /left:10px;top:20px/);
  assert.match(chip({ busy: true }), /aria-label="取消翻译"/);
  assert.match(render(h(lib.SelectionChip, { left: 1, top: 2, target: 'en', onClick: noop }), 'en'), /aria-label="Translate the selected text \(Alt\+T\)"[^>]*>(?:<span[^>]*>)?EN/);
});

test('the glossary dialog lists terms with their handling, asks nothing to be retranslated and carries the explanation', () => {
  const dialog = (props, language) => render(h(lib.GlossaryDialog, { glossary: [{ term: 'CQRS', to: '' }, { term: 'latency', to: '延迟' }], target: 'zh', onSave: noop, onPrice: noop, onRetranslate: noop, onClose: noop, ...props }), language);
  const markup = dialog();
  assert.match(markup, /术语表/);
  assert.match(markup, /value="CQRS"/);
  assert.match(markup, /value="latency"/);
  assert.match(markup, /value="延迟"/);
  assert.match(markup, /<option value="keep" selected="">保持原文<\/option>|selected=""[^>]*>保持原文/);
  assert.match(markup, /保存术语表/);
  assert.match(markup, /比如 CQRS/);
  assert.doesNotMatch(markup, /重新翻译这/, 'nothing is offered before a save says what changed');
  assert.match(dialog({ glossary: [] }), /placeholder="例如 CQRS"/);
  const english = dialog({ glossary: [{ term: 'CQRS', to: '' }] }, 'en');
  assert.doesNotMatch(english.replaceAll('CQRS', ''), han);
  assert.match(english, /Keep as written/);
  assert.match(english, /Save glossary/);
});
