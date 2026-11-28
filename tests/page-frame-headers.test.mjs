import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAppSource } from './helpers/app-source.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* D2 (2.5.9) + #779: 历史学习流记录, 课堂实录 and 音频转录 sit in the same page frame as 资料: the shared PageHeader carries each
   page's only <h1>, its actions are shared Buttons, and the content starts at the page's own left edge. */

const compiled = await build({ stdin: { contents: `
  export { default as Workflows } from './ui/Workflows.jsx';
  export { default as LiveClass } from './ui/LiveClass.jsx';
  export { AudioHeader } from './ui/app/page-views.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Workflows, LiveClass, AudioHeader, setUiLanguage } = module.exports;
const h = React.createElement;
const noop = () => {};
const HAN = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

const listing = { retired: true, templates: [], sessions: [{ id: 'ws1', topic: 'OS', title: 'Flow', stepTitle: 'Step 1', status: 'completed', updatedAt: '2026-10-01T00:00:00Z' }] };
const data = { root: 'frame', focus: { course: 'OS', courses: [{ name: 'OS' }] }, modelReady: true };

const headerOf = (html) => html.match(/<header class="sh-page-header[^"]*"[^>]*>[\s\S]*?<\/header>/)?.[0] || '';
function assertOneH1InHeader(html, label) {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${label}: exactly one h1 on the page`);
  assert.match(headerOf(html), /<h1 class="sh-page-header__title"/, `${label}: the h1 is inside .sh-page-header`);
}
const button = (html, text) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*?${text}(?:(?!</button>)[\\s\\S])*?</button>`))?.[0] || '';
const isShButton = (html, text) => /class="sh-btn /.test(button(html, text));

const screens = {
  'archive list': (language) => render(h(Workflows, { data, initialListing: listing }), language),
  'loading': (language) => render(h(Workflows, { data }), language),
  'live class': (language) => render(h(LiveClass, { data, call: noop, visible: true, onSettings: noop, initialReadiness: { live: false } }), language),
  'live class form': (language) => render(h(LiveClass, { data, call: noop, visible: true, onSettings: noop, initialReadiness: { live: true } }), language),
  'audio': (language) => render(h(AudioHeader, { onSettings: noop, onSources: noop }), language),
};

for (const [name, page] of Object.entries(screens)) {
  test(`${name}: one h1, inside the shared PageHeader, in both languages`, () => {
    assertOneH1InHeader(page('zh'), `${name} zh`);
    const english = page('en');
    assertOneH1InHeader(english, `${name} en`);
    assert.doesNotMatch(english.replace(/frame|OS/g, ''), HAN, `${name}: no Han in the English UI`);
  });
}

// #1708: while the setup card is on screen it is the one way to the audio settings; without it, the header's button is.
test('live class and audio: one way to the audio settings, whether or not the setup card is on screen', () => {
  const ways = (html) => [...html.matchAll(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?(?:音频设置|改用 Gemini 密钥)(?:(?!<\/button>)[\s\S])*?<\/button>/g)].map((match) => match[0]);
  const gated = screens['live class']('zh');
  assert.equal(ways(gated).length, 1, JSON.stringify(ways(gated)));
  assert.equal(ways(headerOf(gated)).length, 0, 'the card is the way, not the header');
  assert.equal(ways(screens['live class form']('zh')).length, 1);
  assert.equal(ways(render(h(AudioHeader, { onSettings: noop, onSources: noop, setupShown: true }), 'zh')).length, 0);
  assert.equal(ways(screens.audio('zh')).length, 1);
});

const page = (name) => screens[name]('zh');
test('the page-level wrappers use the page frame, not a narrow centred column', async () => {
  assert.match(page('live class'), /<section class="page live-class"/);
  assert.match(page('archive list'), /<section class="page workflow-page"/);
  const css = await Promise.all(['ui/live-class.css', 'ui/workflows.css'].map((file) => readFile(file, 'utf8')));
  assert.doesNotMatch(css[0], /\.live-class\s*\{[^}]*max-width/, 'live class no longer caps and centres its own column');
  assert.doesNotMatch(css[1], /\.workflow-page\s*\{[^}]*(max-width|margin-inline)/, 'workflow page no longer caps and centres its own column');
});

test('the old bare-text actions are shared Buttons', () => {
  const live = screens['live class form']('zh');
  assert.ok(isShButton(headerOf(live), '音频设置'), 'live class: 音频设置 is a sh- Button');
  const audio = screens.audio('zh');
  assert.ok(isShButton(audio, '音频设置') && isShButton(audio, '查看资料'), 'audio: both header actions are sh- Buttons');
  for (const label of ['音频设置', '查看资料']) assert.doesNotMatch(button(audio, label), /class="sh-btn--primary|sh-btn--primary/, `${label} is not a primary`);
  const english = screens.audio('en');
  assert.ok(isShButton(english, 'Audio settings') && isShButton(english, 'View sources'));
});

test('the archive list uses shared Buttons and keeps zero hand-rolled .primary buttons', () => {
  const html = screens['archive list']('zh');
  assert.ok(isShButton(html, '查看记录'), '查看记录 is a shared Button');
  assert.doesNotMatch(html, /class="primary"/, 'no hand-rolled .primary buttons are left on the page');
});

test('the portal header is the shared PageHeader and keeps its heading ref for scrolling', async () => {
  const interactive = await loadInteractiveUi(`
    export { default as WorkflowPortal } from './ui/WorkflowPortal.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  interactive.exports.setUiLanguage('zh');
  const sampleSession = {
    id: 'ws1',
    topic: 'Operating Systems',
    currentStepId: 'st1',
    template: {
      title: 'Study Flow',
      steps: [{ id: 'st1', kind: 'lesson', title: 'Step 1', instructions: '', content: 'Intro' }],
    },
    records: { st1: { outcome: 'done', content: 'Intro', output: '' } },
    history: [],
  };
  const sampleResources = { readings: [], sources: [], cardCount: 0 };
  const services = { call: async () => ({ session: sampleSession, resources: sampleResources }) };

  await withBrowserGlobals(async () => {
    const mounted = interactive.mount(() => interactive.React.createElement(
      interactive.exports.StudyServicesContext.Provider,
      { value: services },
      interactive.React.createElement(interactive.exports.WorkflowPortal, {
        id: 'ws1',
        onBack: noop,
        onOpenRun: noop,
        initialResult: { session: sampleSession, resources: sampleResources },
      }),
    ));
    try {
      const headers = mounted.findAll((n) => n.type === 'header');
      const pageHeaders = headers.filter((n) => /\bsh-page-header\b/.test(String(n.props?.className || '')));
      assert.equal(pageHeaders.length, 1, 'portal renders a single .sh-page-header');
      const bareWfHeaders = headers.filter((n) => /\bwf-heading\b/.test(String(n.props?.className || '')) && !/\bsh-page-header\b/.test(String(n.props?.className || '')));
      assert.equal(bareWfHeaders.length, 0, 'no bare hand-rolled .wf-heading header without .sh-page-header is left');
      const header = pageHeaders[0];

      const h1s = mounted.findAll((n) => n.type === 'h1');
      assert.equal(h1s.length, 1, 'portal renders exactly one h1');
      assert.match(String(h1s[0].props?.className || ''), /\bsh-page-header__title\b/, 'the h1 uses PageHeader title styling');
      assert.equal(mounted.find((n) => n.type === 'h1', header), h1s[0], 'the only h1 lives inside .sh-page-header');

      assert.ok(header.ref && typeof header.ref === 'object', 'headingRef is bound to the rendered PageHeader <header>');
      assert.equal(header.ref.current?.tagName, 'HEADER', 'headingRef attaches to the rendered <header> DOM node');
      assert.equal(typeof header.ref.current?.scrollIntoView, 'function', 'headingRef target supports scrolling');
      assert.equal(typeof header.ref.current?.focus, 'function', 'headingRef target is focusable');
    } finally {
      mounted.unmount();
    }
  });
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
