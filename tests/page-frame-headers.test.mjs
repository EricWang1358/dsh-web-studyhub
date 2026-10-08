import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAppSource } from './helpers/app-source.mjs';

/* D2 (2.5.9): 学习流, 课堂实录 and 音频转录 sit in the same page frame as 资料: the shared PageHeader carries each
   page's only <h1>, its actions are shared Buttons, and the content starts at the page's own left edge. */

const compiled = await build({ stdin: { contents: `
  export { default as Workflows, FlowEditor, StartFlow } from './ui/Workflows.jsx';
  export { default as LiveClass } from './ui/LiveClass.jsx';
  export { AudioHeader } from './ui/app/page-views.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Workflows, FlowEditor, StartFlow, LiveClass, AudioHeader, setUiLanguage } = module.exports;
const h = React.createElement;
const noop = () => {};
const HAN = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

const step = { id: 's1', kind: 'lesson', title: '讲解', instructions: '', content: '', next: '$next', retry: '$stay', count: 10 };
const listing = { components: [{ kind: 'lesson', title: '讲解', prompt: 'p', description: 'd' }], templates: [], sessions: [], topics: [], skeletons: [],
  groups: { groups: [] }, limit: 5, suggested: { id: 'sg', title: '建议流程', description: '先讲后练', steps: [step] } };
const data = { root: 'frame', focus: { course: 'OS', courses: [{ name: 'OS' }] }, modelReady: true };
const template = { id: 't1', version: 1, title: '我的流程', description: '先讲再练', steps: [step] };

const headerOf = (html) => html.match(/<header class="sh-page-header[^"]*"[^>]*>[\s\S]*?<\/header>/)?.[0] || '';
function assertOneH1InHeader(html, label) {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${label}: exactly one h1 on the page`);
  assert.match(headerOf(html), /<h1 class="sh-page-header__title"/, `${label}: the h1 is inside .sh-page-header`);
}
const button = (html, text) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*?${text}(?:(?!</button>)[\\s\\S])*?</button>`))?.[0] || '';
const isShButton = (html, text) => /class="sh-btn /.test(button(html, text));

const screens = {
  'prompt page': (language) => render(h(Workflows, { call: noop, askInChat: noop, data, initialListing: listing }), language),
  'loading': (language) => render(h(Workflows, { call: noop, askInChat: noop, data }), language),
  'editor': (language) => render(h(FlowEditor, { initial: { title: '', description: '', steps: [step] }, components: listing.components, call: noop, askInChat: noop, storageKey: 'k', draftName: 'new', onSaved: noop, onBack: noop }), language),
  'start': (language) => render(h(StartFlow, { template, listing, call: noop, askInChat: noop, onRefresh: noop, onStarted: noop, onBack: noop }), language),
  'live class': (language) => render(h(LiveClass, { data, call: noop, visible: true, onSettings: noop, initialReadiness: { live: false } }), language),
  'live class form': (language) => render(h(LiveClass, { data, call: noop, visible: true, onSettings: noop, initialReadiness: { live: true } }), language),
  'audio': (language) => render(h(AudioHeader, { onSettings: noop, onSources: noop }), language),
};

for (const [name, page] of Object.entries(screens)) {
  test(`${name}: one h1, inside the shared PageHeader, in both languages`, () => {
    assertOneH1InHeader(page('zh'), `${name} zh`);
    const english = page('en');
    assertOneH1InHeader(english, `${name} en`);
    assert.doesNotMatch(english.replace(/frame|OS|我的流程|先讲再练|建议流程|先讲后练|讲解/g, ''), HAN, `${name}: no Han in the English UI`);
  });
}

const page = (name) => screens[name]('zh');
test('the page-level wrappers use the page frame, not a narrow centred column', async () => {
  assert.match(page('live class'), /<section class="page live-class"/);
  assert.match(page('prompt page'), /<section class="page workflow-page"/);
  const css = await Promise.all(['ui/live-class.css', 'ui/workflows.css'].map((file) => readFile(file, 'utf8')));
  assert.doesNotMatch(css[0], /\.live-class\s*\{[^}]*max-width/, 'live class no longer caps and centres its own column');
  assert.doesNotMatch(css[1], /\.workflow-page\s*\{[^}]*(max-width|margin-inline)/, 'workflow page no longer caps and centres its own column');
});

test('the old bare-text actions are shared Buttons', () => {
  const live = screens['live class']('zh');
  assert.ok(isShButton(headerOf(live), '音频设置'), 'live class: 音频设置 is a sh- Button');
  const audio = screens.audio('zh');
  assert.ok(isShButton(audio, '音频设置') && isShButton(audio, '查看资料'), 'audio: both header actions are sh- Buttons');
  for (const label of ['音频设置', '查看资料']) assert.doesNotMatch(button(audio, label), /class="sh-btn--primary|sh-btn--primary/, `${label} is not a primary`);
  const english = screens.audio('en');
  assert.ok(isShButton(english, 'Audio settings') && isShButton(english, 'View sources'));
});

test('the prompt page has one primary: 开始学, a shared primary Button that is only grey while disabled', () => {
  const html = screens['prompt page']('zh');
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1, 'one primary on the page');
  const go = button(html, '开始学');
  assert.match(go, /class="sh-btn sh-btn--primary/, '开始学 is the shared primary');
  assert.doesNotMatch(go, /disabled/, 'the course is in the box already, so the one click works');
  const empty = render(h(Workflows, { call: noop, askInChat: noop, data: { root: 'frame', modelReady: true }, initialListing: listing }));
  assert.match(button(empty, '开始学'), /disabled/, 'disabled with no input (the neutral disabled style is the Button\'s own)');
  assert.doesNotMatch(html, /class="primary"/, 'no hand-rolled .primary buttons are left on the page');
});

test('the editor and the start page each keep a single shared primary', () => {
  for (const name of ['editor', 'start']) {
    const html = screens[name]('zh');
    assert.equal((html.match(/sh-btn--primary/g) || []).length, 1, `${name}: one primary`);
    assert.doesNotMatch(html, /class="primary"/, `${name}: no hand-rolled .primary`);
  }
});

test('the portal header is the shared PageHeader and keeps its heading ref for scrolling', async () => {
  const source = await readFile('ui/WorkflowPortal.jsx', 'utf8');
  assert.match(source, /<PageHeader[^>]*ref=\{headingRef\}/, 'headingRef stays on the header');
  assert.doesNotMatch(source, /<header className="wf-heading"/, 'no hand-rolled heading is left');
  assert.doesNotMatch(source, /<h1>/, 'no bare h1 is left');
});

test('no page below the frame hand-rolls its heading any more', async () => {
  for (const file of ['ui/Workflows.jsx', 'ui/LiveClass.jsx']) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /<h1>/, `${file}: no bare h1`);
    assert.doesNotMatch(source, /<header className="(wf|live)-heading/, `${file}: no hand-rolled heading`);
  }
  const app = await readAppSource();
  assert.doesNotMatch(app, /<h1>\{language === "en" \? "Audio transcription"/, 'the audio heading left App.jsx');
});
