import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// WP-TC step 3, the UI half: the 即时控制 row draws what job.control says, in both languages, with the bounds and the words the owner approved.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export * from './ui/tasks/task-control.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const audioControl = (values = {}) => ({ values: { textConcurrency: 3, transcribeConcurrency: 1, proofreadReasoning: 'high', translateReasoning: 'low', autoBackoff: true, paused: false, ...values },
  limits: { textConcurrency: { type: 'int', min: 1, max: 6 }, transcribeConcurrency: { type: 'int', min: 1, max: 3 },
    proofreadReasoning: { type: 'enum', values: ['default', 'lowest', 'low', 'medium', 'high', 'highest'] }, translateReasoning: { type: 'enum', values: ['default', 'lowest', 'low', 'medium', 'high', 'highest'] },
    autoBackoff: { type: 'bool' }, paused: { type: 'bool' } } });
const audio = (extra = {}) => ({ id: 'a1', type: 'audio-import', filename: 'lecture.wav', status: 'running', phase: 'proofread', startedAt: '2026-10-05T10:00:00.000Z', control: audioControl(), paused: false, ...extra });
const generation = () => ({ id: 'g1', status: 'running', deckTitle: 'Deck', requestedTotal: 10, savedCount: 2, startedAt: '2026-10-05T10:00:00.000Z', paused: false,
  control: { values: { concurrency: 4, paused: false, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' },
    limits: { concurrency: { type: 'int', min: 1, max: 8 }, paused: { type: 'bool' }, ...Object.fromEntries(['effortPlanning', 'effortReview', 'effortWriting', 'effortRepair'].map((key) => [key, { type: 'enum', values: ['follow', 'lowest', 'low', 'default', 'high', 'highest'] }])) } } });
const render = (job, language = 'zh') => {
  m.setUiLanguage(language);
  const html = renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [] }, openers: { resultOf: () => null } }),
    { data: { jobs: [job] }, app: { lib: { taskFocus: null } } }));
  m.setUiLanguage('zh');
  return html;
};

test('an audio job offers text concurrency, transcription concurrency, the reasoning of what is left, the back-off switch and pause', () => {
  const html = render(audio());
  const row = html.slice(html.indexOf('aria-label="即时控制"'), html.indexOf('class="tc-body"'));
  for (const key of ['textConcurrency', 'transcribeConcurrency', 'proofreadReasoning', 'translateReasoning', 'autoBackoff']) assert.match(row, new RegExp(`data-control="${key}"`), key);
  assert.match(row, /校对\/翻译并发/);
  assert.match(row, /转写并发/);
  assert.match(row, /<strong class="tc-stepper__value"[^>]*>3<\/strong>/);
  assert.match(row, /剩余校对推理/);
  assert.match(row, /<option value="high" selected="">高<\/option>/);
  assert.match(row, /限流时自动降并发/);
  assert.match(row, /存为默认/);
  assert.match(row, /改动从下一次调用生效/);
  assert.match(html, />暂停</, 'the header has pause');
  assert.match(html, /aria-pressed="false"[^>]*>暂停/);
});

test('a stepper stops at its bounds: the button that would leave them is disabled', () => {
  const low = render(audio({ control: audioControl({ textConcurrency: 1, transcribeConcurrency: 3 }) }));
  assert.match(low, /disabled="" aria-label="减少校对\/翻译并发"/);
  assert.doesNotMatch(low, /disabled="" aria-label="增加校对\/翻译并发"/);
  assert.match(low, /disabled="" aria-label="增加转写并发"/);
  const high = render(audio({ control: audioControl({ textConcurrency: 6 }) }));
  assert.match(high, /disabled="" aria-label="增加校对\/翻译并发"/);
});

test('a paused job says so on the button that resumes it', () => {
  const html = render(audio({ paused: true, control: audioControl({ paused: true }) }));
  assert.match(html, /aria-pressed="true"[^>]*>继续/);
});

test('a generation job offers concurrency and the reasoning of each stage, and writes its defaults to the generation settings', () => {
  const html = render(generation());
  for (const key of ['concurrency', 'effortPlanning', 'effortReview', 'effortWriting', 'effortRepair']) assert.match(html, new RegExp(`data-control="${key}"`), key);
  assert.match(html, /规划推理/);
  assert.match(html, /<option value="follow"[^>]*selected=""[^>]*>跟随当前会话<\/option>/);
  const { defaultsPatch } = m;
  const patch = defaultsPatch(generation());
  assert.equal(patch.action, 'settings');
  assert.deepEqual(patch.args, { generation: { concurrency: 4, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' } });
  assert.deepEqual(defaultsPatch(audio()), { action: 'audio.settings.set', args: { textConcurrency: 3, transcribeConcurrency: 1, proofreadReasoning: 'high', translateReasoning: 'low' } });
});

test('the row is always there: a job that cannot be adjusted, or has ended, says so in the same place', () => {
  const none = render({ ...audio(), control: undefined });
  assert.match(none, /aria-label="即时控制"/);
  assert.match(none, /任务还没有开始/, 'the contract says why: there is nothing to adjust yet');
  assert.doesNotMatch(none, /data-control=/);
  const unsupported = render({ id: 'p1', type: 'pdf-convert', filename: 'Book.pdf', status: 'running', phase: 'parse', startedAt: '2026-10-05T10:00:00.000Z' });
  assert.match(unsupported, /这类任务不支持这个操作/);
  assert.match(unsupported, /这类任务没有可以安全暂停的地方；可以停止，已完成的部分会保留/, 'and says what to do instead of pausing');
  assert.doesNotMatch(unsupported, />暂停</, 'no pause button where the contract offers no pause');
  const ended = render(audio({ status: 'complete', control: undefined }));
  assert.match(ended, /任务已经结束。/);
  assert.doesNotMatch(ended, />暂停</);
});

test('English wording', () => {
  const html = render(audio(), 'en');
  assert.match(html, /aria-label="Live controls"/);
  assert.match(html, /Proofread\/translate parallel/);
  assert.match(html, /Auto back-off on rate limit/);
  assert.match(html, /Changes apply from the next call/);
  assert.match(html, /Save as default/);
  assert.match(html, />Pause</);
  assert.match(m.appliedText({ textConcurrency: 4 }), /已生效/, 'back in Chinese once the language is reset');
  m.setUiLanguage('en');
  assert.equal(m.appliedText({ textConcurrency: 4 }), '✓ Applied · Proofread/translate parallel → 4');
  assert.equal(m.actionText('pause'), 'Paused: no new call starts, and it stops once the calls in progress finish');
  assert.equal(m.appliedText({ proofreadReasoning: 'high' }), '✓ Applied · Proofread reasoning (rest) → High');
  m.setUiLanguage('zh');
});

test('a step stays inside the limits', () => {
  const item = { value: 6, min: 1, max: 6 };
  assert.equal(m.stepValue(item, 1), 6);
  assert.equal(m.stepValue(item, -1), 5);
  assert.equal(m.stepValue({ value: 1, min: 1, max: 6 }, -1), 1);
});
