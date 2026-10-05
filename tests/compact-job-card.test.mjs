import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// WP-TC step 6: the compact job card that replaces the big cards on the pages, and the console sections that took their detail over.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as CompactJobCard, cardLine } from './ui/tasks/CompactJobCard.jsx';
  export { default as AudioFiles } from './ui/tasks/AudioFiles.jsx';
  export { default as TaskBody } from './ui/tasks/TaskBody.jsx';
  export { PdfDetail } from './ui/PdfConvertJob.jsx';
  export { resultOpener } from './ui/tasks/task-actions.js';
  export { usageLine } from './ui/tasks/task-facts.js';
  export { jobContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const HAN = /[㐀-鿿]/;
const noop = () => {};
const draw = (element, { data = {}, app = {}, language = 'zh' } = {}) => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data, app })); } finally { m.setUiLanguage('zh'); }
};
const card = (job, props = {}, options) => draw(React.createElement(m.CompactJobCard, { job, ...props }), options);
const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const audio = (extra = {}) => ({ id: 'a1', type: 'audio-import', filename: 'Week 3.wav', status: 'running', phase: 'proofread', startedAt: at(0), steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 2, total: 6 } },
  tasks: [{ id: 't', kind: 'proofread', part: 3, parts: 6, status: 'running', runtime: 'subagent', startedAt: at(5) }], ...extra });
const pdf = (extra = {}) => ({ id: 'p1', type: 'pdf-convert', route: 'local', filename: 'Book.pdf', status: 'running', phase: 'local', done: 100, total: 450, chunk: { index: 3, count: 9 }, startedAt: at(0), ...extra });

test('one card is one article: a dot, the title and its percent, a bar, ONE line, a stop slot and ONE button', () => {
  const out = card(audio());
  assert.equal((out.match(/<article/g) || []).length, 1);
  for (const part of ['cjc__dot', 'cjc__title', 'cjc__pct', 'sh-progress', 'cjc__line', 'cjc__slot', 'cjc__go']) assert.match(out, new RegExp(part), part);
  assert.equal((out.match(/cjc__go/g) || []).length, 1, 'one primary button');
  assert.match(out, /aria-label="停止：Week 3\.wav"/);
  assert.match(out, />查看详情</);
  assert.doesNotMatch(out, /<details|<ol|<ul/, 'a card folds nothing and lists nothing');
  assert.doesNotMatch(out.match(/<article[^>]*>/)[0], /role=|aria-live/, 'the card is not a live region');
});

test('the line says what runs now (from the calls in flight), the piece of a long conversion, and counts the notices', () => {
  assert.match(card(audio()), /正在校对 3\/6/);
  assert.match(card(pdf()), /第 3\/9 段/);
  assert.match(card(pdf({ local: { adaptive: true } })), /第 3 段/, 'an adaptive plan decides one window at a time');
  assert.match(card(audio({ warnings: ['a.mp3：文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理'] })), /1 条提醒/);
});

test('the primary button follows the contract: the result opens, a failure that can go on says so, anything else opens the console', () => {
  const opened = [];
  const app = { learn: { openAudioSources: (ids) => opened.push(ids) }, nav: { show: { task: (id) => opened.push(id) } } };
  const done = audio({ status: 'complete', phase: 'done', sourceIds: ['s1'] });
  assert.match(card(done, {}, { app }), />打开资料</);
  assert.match(card(audio({ status: 'failed', stage: 'boom', retryable: true })), />看原因并继续</);
  assert.match(card(audio({ status: 'failed', stage: 'boom', retryable: false })), />查看详情</);
  assert.match(card(done, { primary: { label: '打开逐字稿', run: noop } }), />打开逐字稿</, 'a page that knows better names its own');
  assert.equal(m.resultOpener(done, app).label, '打开资料');
  m.resultOpener(done, app).run();
  assert.deepEqual(opened, [['s1']]);
  assert.equal(m.resultOpener(audio(), app), null, 'a running job has no result yet');
  assert.match(card(audio({ status: 'failed', stage: 'boom', retryable: true }), { primary: { label: '去配置模型', run: noop, disabled: true } }), /disabled=""[^>]*>去配置模型|去配置模型/);
});

test('finished cards can be dismissed, running ones cannot; a dismissal that failed says so inside the card', () => {
  assert.doesNotMatch(card(audio()), /知道了/);
  assert.match(card(audio({ status: 'complete', phase: 'done' })), /aria-label="知道了：Week 3\.wav"/);
  const out = renderToStaticMarkup(inApp(m, React.createElement(m.CompactJobCard, { job: audio({ status: 'failed', stage: 'boom' }) }), { data: {} }));
  assert.doesNotMatch(out, /sh-inline--error/);
});

test('in English the card has no Chinese in any state (file names and the job\'s own message aside)', () => {
  const states = [audio(), audio({ status: 'complete', phase: 'done', sourceIds: ['s'], corrected: 2, uncertain: 1 }), audio({ status: 'cancelled' }), audio({ status: 'failed', stage: 'boom', retryable: true }),
    pdf(), pdf({ status: 'complete', phase: 'done', sourceIds: ['a'] }), { id: 'g', type: 'generate', status: 'running', stage: '', parts: 1, requestedTotal: 10, savedCount: 4, steps: [] }];
  for (const job of states) assert.doesNotMatch(card(job, {}, { language: 'en' }).replace(/Week 3\.wav|Book\.pdf|boom/g, ''), HAN, job.status);
});

test('the audio console keeps a blocked file picked, with the skip button, and a single file already shows its stages', () => {
  const batch = { id: 'b1', type: 'audio-import', status: 'failed', batchId: 'batch-1', filename: 'Week 5', phase: 'batch', retryable: true, warnings: [], stage: '「PE1.mp3」未通过预检，其余文件尚未开始', blocked: { index: 1, filename: 'PE1.mp3' },
    members: [{ index: 0, filename: 'A.wav', status: 'waiting', waitingFor: 'PE1.mp3' }, { index: 1, filename: 'PE1.mp3', status: 'blocked', stage: '没有在文件里找到可识别的 MP3 音频帧' }, { index: 2, filename: 'B.wav', status: 'waiting', waitingFor: 'PE1.mp3' }] };
  const out = draw(React.createElement(m.AudioFiles, { contract: m.jobContract(batch) }));
  assert.match(out, /未通过预检/);
  assert.match(out, /跳过这个文件继续/);
  assert.match(out, /没有在文件里找到可识别的 MP3 音频帧/);
  assert.equal((out.match(/等待中/g) || []).length, 2, 'both siblings say they wait');
});

test('a PDF conversion has its own section in the console: the environment, the window in hand and the windows', () => {
  const job = pdf({ env: { kind: 'local', mineruVersion: '4.0.10', tier: 'basic' }, chunks: [{ index: 1, startPage: 1, endPage: 50, pages: 50, state: 'done' }, { index: 2, startPage: 51, endPage: 100, pages: 50, state: 'parsing' }],
    local: { window: { startPage: 51, endPage: 100, pages: 50, startedAt: at(1), expectedSeconds: 60 } } });
  assert.match(draw(React.createElement(m.TaskBody, { task: job })), />转换详情</, 'the one section of the kind is a tab of the left panel');
  const out = draw(React.createElement(m.PdfDetail, { job }));
  assert.match(out, /运行环境/);
  assert.match(out, /本地 mineru 4\.0\.10/);
  assert.match(out, /第 1 段 · 第 1–50 页/);
  assert.match(draw(React.createElement(m.TaskBody, { task: job }), { language: 'en' }), />Conversion</);
});

test('the usage line of an audio job is one line that never changes height: requests, free providers, reuse', () => {
  const none = audio({ usage: undefined });
  assert.match(m.usageLine(none), /还没有向转写服务发请求/);
  const used = audio({ usage: { free: { requests: 3 }, paid: { requests: 1 }, estimatedPaidTranscribeUsd: 0.02, groq: { requests: 2 }, siliconflow: { requests: 0 } } });
  assert.match(m.usageLine(used), /Gemini 请求：免费 3 · 付费 1 · 转写付费约 \$0\.02 · Groq 2（免费额度）/);
  assert.equal(m.usageLine(pdf()), '', 'only audio imports meter providers this way');
});
