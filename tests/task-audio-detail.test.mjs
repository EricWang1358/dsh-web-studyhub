import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { jobContract } from '../lib/job-contract.js';

/* The detail of an audio task speaks for ITS kind (S6-7: the real host showed a subtitle import saying no request had gone to the transcription service, with a
   transcription entry in the timeline's legend). Each kind names only the calls it can make. */

const { usageLine } = await loadUi(`export { usageLine } from './ui/tasks/task-facts.js';`);
const parallel = { limit: 3, effective: 3, lowest: 3 };
const card = (kind, detail = {}) => ({ contract: { ...jobContract({ type: 'audio-import', id: 'job-1', status: 'running', filename: 'x', startedAt: new Date().toISOString() }), kind,
  detail: { files: [{ status: 'running', phase: 'proofread', steps: {} }], parallel: { text: parallel }, ...detail } } });
const TEXT_ONLY = ['audio-subtitles', 'audio-review', 'audio-live-save', 'audio-live-correction'], TRANSCRIBING = ['audio-import', 'audio-batch'];

for (const kind of TEXT_ONLY) test(`${kind}: the request line says nothing about the transcription service, before and after its first request`, () => {
  for (const detail of [{}, { usage: { gemini: { free: 0, paid: 0 }, siliconflow: 0, groq: 0 }, textProvider: 'host' }]) {
    const line = usageLine(card(kind, detail));
    assert.doesNotMatch(line, /转写/, `"${line}"`);
  }
});

for (const kind of TRANSCRIBING) test(`${kind}: the request line still speaks for the transcription service`, () => {
  assert.match(usageLine(card(kind)), /还没有向转写服务发请求/);
});

test('a text-only task says what it does instead of nothing: the model asked, the parallel windows', () => {
  assert.match(usageLine(card('audio-subtitles')), /并行 3/);
  assert.ok(usageLine(card('audio-review', { files: [] })).length > 0, 'the line is never empty: the console keeps its height for every audio task');
});

test('a completed host proofreading step does not claim that review also translated', () => {
  const job = card('audio-review', { files: [], textProvider: 'host' });
  job.contract.progress.segments = [{ stage: 'proofread', done: 1, total: 1 }];
  const line = usageLine(job);
  assert.match(line, /DSH/);
  assert.doesNotMatch(line, /翻译/);
});

test('text-only request rows stay informative without files, measured segments or new requests', () => {
  for (const kind of TEXT_ONLY) {
    for (const usage of [undefined, { thisRun: { free: 0, paid: 0 } }]) {
      const line = usageLine(card(kind, { files: [], usage }));
      assert.ok(line.length > 0, kind);
      assert.doesNotMatch(line, /转写|翻译|DSH/, 'do not name unused steps or infer a provider');
    }
  }
});

test('the legend of the timeline names the calls of that kind only', async () => {
  const { timelineLegend } = await loadUi(`export { timelineLegend } from './ui/tasks/call-model.js';`);
  const names = kind => timelineLegend('audio', kind).map(([call]) => call);
  assert.deepEqual(names('audio-import'), ['transcribe', 'proofread', 'translate']);
  assert.deepEqual(names('audio-batch'), ['transcribe', 'proofread', 'translate']);
  assert.deepEqual(names('audio-subtitles'), ['proofread', 'translate']);
  assert.deepEqual(names('audio-live-save'), ['proofread', 'translate']);
  assert.deepEqual(names('audio-review'), ['proofread']);
  assert.deepEqual(names('audio-live-correction'), ['live.correct']);
  assert.deepEqual(names(undefined), ['transcribe', 'proofread', 'translate'], 'a task of the original path is one kind for all of them');
  assert.deepEqual(timelineLegend('coach').map(([call]) => call), ['prep']);
  assert.ok(timelineLegend('generation').length > 2);
});

const panels = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as AudioFiles } from './ui/tasks/AudioFiles.jsx';
  export { default as TaskBody } from './ui/tasks/TaskBody.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const render = (View, props, language = 'zh') => {
  panels.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(panels, React.createElement(View, props))); }
  finally { panels.setUiLanguage('zh'); }
};
const counts = { transcribe: { done: 1, total: 1 }, proofread: { done: 2, total: 3 }, translate: { done: 1, total: 2 } };
const fileCard = kind => card(kind, { files: [{ filename: 'lesson.txt', status: 'running', phase: 'proofread', steps: counts }] });

for (const [kind, stages] of [
  ['audio-import', ['transcribe', 'proofread', 'translate']], ['audio-batch', ['transcribe', 'proofread', 'translate']],
  ['audio-subtitles', ['proofread', 'translate']], ['audio-live-save', ['proofread', 'translate']], ['audio-review', ['proofread']],
]) test(`${kind}: file bars, accessible counts and selected-file detail name only its own stages`, () => {
  for (const language of ['zh', 'en']) {
    const out = render(panels.AudioFiles, { contract: fileCard(kind).contract }, language);
    assert.deepEqual([...out.matchAll(/data-stage="([^"]+)"/g)].map(match => match[1]), stages);
    const aria = out.match(/role="img" aria-label="([^"]+)"/)[1];
    const strip = out.slice(out.indexOf('class="tc-strip__line"'));
    for (const [stage, label] of [['transcribe', language === 'zh' ? '转写' : 'Transcription'],
      ['proofread', language === 'zh' ? '校对' : 'Proofreading'], ['translate', language === 'zh' ? '翻译' : 'Translation']]) {
      for (const text of [aria, strip]) assert.equal(text.includes(label), stages.includes(stage), `${language}: ${stage}: ${text}`);
    }
    assert.match(aria, /2\/3/, 'observed proofread count is preserved');
  }
});

test('live correction has no file tab; other audio kinds keep theirs', () => {
  for (const kind of [...TRANSCRIBING, ...TEXT_ONLY]) {
    for (const language of ['zh', 'en']) {
      const out = render(panels.TaskBody, { task: fileCard(kind) }, language);
      const tabs = [...out.matchAll(/class="sh-tab__label">([^<]+)/g)].map(match => match[1]).join(' ');
      assert.equal(tabs.includes(language === 'zh' ? '文件' : 'Files'), kind !== 'audio-live-correction', `${kind}: ${tabs}`);
      assert.match(out, language === 'zh' ? /正在进行/ : /In progress/);
    }
  }
});

test('PDF retains its conversion detail section', () => {
  const task = { id: 'pdf-1', type: 'pdf-convert', filename: 'lesson.pdf', status: 'running', phase: 'parse' };
  const out = render(panels.TaskBody, { task });
  assert.match(out, /转换详情/);
  assert.doesNotMatch(out, /class="tc-files"/);
});
