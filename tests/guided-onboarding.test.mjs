import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

/* #549: the learner is shown how to start AI 带学 — sentences they can send to the main chat as they are, in the tour, in Settings › 引导 and on
   the empty workbench, with the session's defaults said once — and the workbench speaks the interface language. */

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export { default as GuidancePane } from './ui/settings/GuidancePane.jsx';
  export { default as GuidedStudyWorkbench } from './ui/guided-study/GuidedStudyWorkbench.jsx';
  export { default as GuidedStudyStart } from './ui/guided-study/GuidedStudyStart.jsx';
  export { GUIDED_EXAMPLES, GUIDED_DEFAULTS } from './ui/guided-study/examples.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { TOUR_STEPS } from './ui/tour/steps.js';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const m = (() => { const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); return module.exports; })();
const h = React.createElement;
const han = /[㐀-鿿]/;
const words = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const memory = () => { const map = new Map(); return { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => map.get(k) ?? null,
  setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) }; };
const withServices = (services, element) => h(m.StudyServicesContext.Provider, { value: services }, element);

test('the tour step and Settings › 引导 give the same sentences, each sendable to the main chat', () => {
  m.setUiLanguage('zh');
  const step = m.TOUR_STEPS.find((item) => item.id === 'guided-study');
  assert.match(step.body, /带我学条件概率，每讲完一个点就出一道题考我/, 'the tour says what to type');
  assert.match(step.body, /设置 › 引导 › AI 带学/, 'and where the rest is');
  assert.ok(m.GUIDED_EXAMPLES.some((example) => step.body.includes(example.text.replace(/。$/, ''))), 'the tour example is one of the shared examples');
  const html = renderToStaticMarkup(withServices({ askInChat: () => {} }, h(m.GuidancePane, { storages: { local: memory(), session: memory() } })));
  assert.match(html, /data-guidance="guided-study"/);
  for (const example of m.GUIDED_EXAMPLES) assert.ok(html.includes(example.text), example.id);
  assert.equal((html.match(/data-hand-off="guided\.start"/g) || []).length, m.GUIDED_EXAMPLES.length, 'one 「发给主会话」 per sentence, through the hand-off registry');
  assert.match(html, /现场出新题：默认关/, 'the defaults are said once');
});

test('each sentence goes to the main chat as the learner\'s own words, handed to the study-tutor skill, in both languages', () => {
  for (const example of m.GUIDED_EXAMPLES) {
    const zh = m.handOffText('guided.start', { example: example.id }, 'zh');
    assert.ok(zh.startsWith(example.text), example.id);
    assert.match(zh, /skill study-tutor/);
    const en = m.handOffText('guided.start', { example: example.id }, 'en');
    assert.ok(!han.test(en.split('\n')[0]), en);
  }
  assert.ok(m.handOffText('guided.start', { example: 'nope' }, 'zh').startsWith(m.GUIDED_EXAMPLES[0].text), 'an unknown sentence id is the first sentence');
});

test('the empty workbench says how to start, and the workbench is all in English in the English interface', () => {
  m.setUiLanguage('zh');
  const empty = renderToStaticMarkup(withServices({ askInChat: () => {} }, h(m.GuidedStudyWorkbench, { session: { id: 's', status: 'active' }, run: null, modelReady: true })));
  assert.match(empty, /data-guided-start/);
  assert.match(empty, /带学进行中/);
  assert.doesNotMatch(empty, /会话状态|active</, 'the status is a sentence, not the raw value');
  m.setUiLanguage('en');
  try {
    const session = { id: 's', status: 'paused', goal: { title: '' }, returnPath: [{}], artifactRefs: [], focus: null };
    const html = renderToStaticMarkup(withServices({ askInChat: () => {} }, h(m.GuidedStudyWorkbench, { session, run: null, modelReady: false })));
    const text = words(html);
    assert.ok(!han.test(text), `no Chinese left: ${text.match(new RegExp(`.{0,30}${han.source}.{0,30}`))?.[0]}`);
    assert.match(text, /Guided study paused/);
    assert.match(text, /No AI model is available/);
    const card = { id: 'c', kind: 'flashcard', prompt: 'Recall it' };
    const answering = words(renderToStaticMarkup(withServices({ askInChat: () => {} }, h(m.GuidedStudyWorkbench, { session: { id: 's', status: 'active' }, run: { id: 'r', card }, modelReady: true, onAnswer: () => {} }))));
    assert.ok(!han.test(answering), answering);
  } finally { m.setUiLanguage('zh'); }
});

test('every guided workbench string goes through ui()', async () => {
  for (const file of ['GuidedStudyWorkbench.jsx', 'StudyProgressPanel.jsx', 'TeachingArtifactBlock.jsx', 'QuestionPrepSlot.jsx']) {
    const source = await readFile(new URL(`../ui/guided-study/${file}`, import.meta.url), 'utf8');
    const bare = source.split('\n').filter((line) => han.test(line) && !/ui\(|uiFormat\(|^\s*(\/\/|\/\*|\*|\{\/\*)|label: '|STATUS_WORD = /.test(line));
    assert.deepEqual(bare, [], file);
  }
});
