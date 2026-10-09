import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { MARKER_TEXT } from '../lib/marker-local.js';

/* The 任务 console of a PDF conversion (the owner's screenshots of 2026-10-09): no model-call panels for a job that makes no model calls, the log as a story in both
   languages, the real cause of a failure in full in 转换详情 with 复制诊断信息, conversion wording (not question wording), and 前往设置 first when only the installation can help.
   And the Marker card of Settings for a marker-pdf 2.x: start Docker, or 修复安装（改装 1.x）. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as MarkerInstall } from './ui/MarkerInstall.jsx';
  export { logLines } from './ui/tasks/call-model.js';
  export { jobContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const at = (seconds) => new Date(Date.parse('2026-10-09T12:38:00.000Z') + seconds * 1000).toISOString();
let n = 0;
const event = (seconds, level, code, args = null, text) => ({ id: `e${++n}`, at: at(seconds), level, tag: null, code, args, ...(text !== undefined ? { text } : {}) });

const story = [
  event(0, 'step', 'convert-start', { converter: 'marker', route: 'local', pages: 198, windows: { kind: 'adaptive', firstPages: 10, targetSeconds: 60, minPages: 4, maxPages: 50 }, origin: 'installed', version: '1.10.2', python: '3.12.6' }),
  event(1, 'step', 'window-start', { index: 1, start: 1, end: 10, pages: 10 }),
  event(20, 'info', 'tool-output', null, 'Recognizing layout: 100% (10/10)'),
  event(40, 'step', 'window-end', { index: 1, start: 1, end: 10, pages: 10, seconds: 39.5, done: 10, total: 198, etaSeconds: 740 }),
  event(41, 'info', 'tool-omitted', { count: 7 }),
  event(230, 'step', 'merge', { windows: 5, pages: 198 }),
  event(231, 'step', 'save', { pages: 198, chars: 412345, bytes: 500000 }),
  event(232, 'warn', 'empty-pages', { count: 3, pages: [4, 9, 12] }),
  event(233, 'done', 'convert-end', { pages: 195, skipped: 3, windows: 5, retries: 0, chars: 412345, seconds: 231, title: 'Design Secure Architecture' }),
];
const failureLines = ['  File "vllm.py", line 195, in spawn_fn', 'surya.inference.backends.spawn.SpawnError: docker run failed: failed to connect to the docker API'];
const failedEvents = [story[0], story[1], event(60, 'warn', 'window-failed', { index: 1, start: 1, end: 10, pages: 10, seconds: 59, exitCode: 1 }, MARKER_TEXT.needsDocker(2)),
  event(61, 'error', 'convert-failed', { lines: failureLines, fix: 'settings' }, MARKER_TEXT.needsDocker(2))];

/** A conversion's record as the original path keeps it (the console reads it through its contract). */
const pdfJob = (extra = {}) => ({ id: 'pdf1', type: 'pdf-convert', converter: 'marker', route: 'local', filename: '04. Design Secure Architecture v4.7.pdf', status: 'running', phase: 'local',
  done: 0, total: 198, chunk: { index: 1, count: 0 }, chunks: [{ index: 1, startPage: 1, endPage: 10, pages: 10, state: 'running' }], local: { adaptive: true }, warnings: [], note: '',
  startedAt: at(0), env: { kind: 'local', windows: { kind: 'adaptive', firstPages: 10, targetSeconds: 60, minPages: 4, maxPages: 50 } }, events: story.slice(0, 3), ...extra });
const failedJob = () => pdfJob({ status: 'failed', phase: 'local', retryable: true, errorCode: 'marker-needs-docker', stage: MARKER_TEXT.needsDocker(2), finishedAt: at(61), events: failedEvents,
  chunks: [{ index: 1, startPage: 1, endPage: 10, pages: 10, state: 'planned', error: MARKER_TEXT.needsDocker(2) }],
  failure: { code: 'marker-needs-docker', summary: MARKER_TEXT.needsDocker(2), lines: failureLines, exitCode: 1, fix: 'settings' } });
const draw = (job, language = 'zh', opened = []) => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [] }, openers: { resultOf: () => null } }),
      { data: { jobs: [job] }, app: { lib: { taskFocus: null }, settingsEntry: { openSettings: section => opened.push(section), openModelSettings: () => {}, setCourseSettings: () => {} } } }));
  } finally { m.setUiLanguage('zh'); }
};

test('a conversion\'s log reads as a story, in Chinese and in English, and a failure carries the converter\'s last lines', () => {
  m.setUiLanguage('zh');
  const zh = m.logLines({ events: story, calls: [] }).map(line => line.text);
  assert.ok(zh.includes('开始转换 · 共 198 页 · Marker 本机解析 · StudyHub 安装的 Marker · Marker 1.10.2 · Python 3.12.6 · 分段：先做 10 页，之后每段约 60 秒（4–50 页）'), zh.join('\n'));
  assert.ok(zh.includes('第 1 段开始：第 1–10 页（10 页）'));
  assert.ok(zh.some(text => /^第 1 段完成：第 1–10 页，用时 .+ · 已完成 10\/198 页 · 预计还需约 .+$/.test(text)), zh.join('\n'));
  assert.ok(zh.includes('Recognizing layout: 100% (10/10)'));
  assert.ok(zh.includes('…… 中间省略 7 行输出'));
  assert.ok(zh.some(text => text.startsWith('转换完成：195 页资料 · 「Design Secure Architecture」 · 5 段')));
  assert.ok(zh.includes('3 页没有文字（空白页或只有图），没有存为资料'));
  const failed = m.logLines({ events: failedEvents, calls: [] });
  const error = failed.find(line => line.kind === 'convert-failed');
  assert.equal(error.text, `转换失败：${MARKER_TEXT.needsDocker(2)}`);
  assert.deepEqual(error.block, failureLines);
  m.setUiLanguage('en');
  try {
    const en = m.logLines({ events: [...story, ...failedEvents], calls: [] }).map(line => line.text);
    for (const text of en) if (!/Recognizing|Design Secure/.test(text)) assert.doesNotMatch(text, han, `English log line: ${text}`);
    assert.ok(en.includes('Window 1 started: pages 1–10 (10 pages)'));
    assert.ok(en.some(text => text.startsWith('Conversion failed: The installed Marker is 2.x, which runs its inference server in Docker. Start Docker Desktop')));
  } finally { m.setUiLanguage('zh'); }
});

test('a running conversion shows what is relevant: no model-call timeline, no 实时输出, the log; Marker\'s bar live in 转换详情; windows, not model calls', () => {
  const html = draw(pdfJob({ toolProgress: { label: 'Recognizing layout', percent: 40, done: 4, total: 10, at: at(10) } })), text = textOf(html);
  assert.doesNotMatch(html, /tc-timeline/, 'no parallel timeline');
  assert.doesNotMatch(text, /还没有模型调用|没有选中的调用|实时输出|正在进行 0|规划|出题/);
  assert.match(text, /转换详情/); assert.match(text, /日志/);
  assert.match(text, /Marker 正在：Recognizing layout 40%（4\/10）/);
  assert.match(text, /已完成的段 0/); assert.doesNotMatch(text, /模型任务/);
  assert.match(text, /这类任务没有可以调整的设置。/); assert.doesNotMatch(text, /这类任务不支持这个操作/);
  assert.match(text, /开始转换 · 共 198 页/, 'the 日志 tab is the one shown');
});

test('a failed conversion: the cause in full with the last lines and 复制诊断信息, conversion wording, 前往设置 first and 接着做 second', () => {
  const opened = [], html = draw(failedJob(), 'zh', opened), text = textOf(html);
  assert.match(text, /失败原因/);
  assert.ok(text.includes(MARKER_TEXT.needsDocker(2)));
  assert.match(html, /class="pdf-failure__lines"[^>]*>[^<]*SpawnError: docker run failed/);
  assert.match(text, /转换程序最后输出的几行（退出码 1）/);
  assert.match(text, /复制诊断信息/);
  assert.match(text, /已转换的页会保留。先按「前往设置」里的说明处理，再点「接着做」继续。/);
  assert.doesNotMatch(text, /已出的题/);
  assert.match(html, /data-fix="settings"[^>]*>前往设置</);
  const retry = /<button[^>]*>接着做<\/button>/.exec(html)?.[0] || '';
  assert.ok(retry, '接着做 is still offered (after Docker is started it continues)');
  assert.doesNotMatch(retry, /primary/, '接着做 is not the primary action');
  assert.doesNotMatch(html, /tc-timeline/);
  const en = textOf(draw(failedJob(), 'en'));
  assert.match(en, /Why it failed/); assert.match(en, /Copy diagnostic information/); assert.match(en, /Go to settings/);
  assert.match(en, /The converted pages are kept\. Follow the steps in Go to settings first, then press Continue\./);
  assert.match(en, /Windows done/);
});

test('a failure the job can retry by itself keeps 接着做 as the primary action and no 前往设置', () => {
  const job = failedJob();
  job.failure = { code: 'timeout', summary: '这一段 Marker 解析用时过长，可以接着做重试。', lines: [] };
  job.errorCode = 'timeout'; job.stage = job.failure.summary;
  const html = draw(job), text = textOf(html);
  assert.doesNotMatch(html, /data-fix="settings"/);
  assert.match(/<button[^>]*>接着做<\/button>/.exec(html)?.[0] || '', /primary/);
  assert.match(text, /已转换的页会保留，点「接着做」继续。/);
});

test('Settings › Marker for a 2.x: two equal ways out (start Docker / 修复安装（改装 1.x）); a Marker StudyHub did not install is told how to get a 1.x', () => {
  const complete = { status: 'complete', stage: 'done', stages: ['create-venv', 'install', 'verify', 'configure'], folder: 'F:\\StudyHub-Marker', mirror: 'tsinghua', log: [], error: null,
    installed: true, installedFolder: 'F:\\StudyHub-Marker', defaultFolder: 'C:\\x', command: 'F:\\StudyHub-Marker\\venv\\Scripts\\marker_single.exe' };
  const status = { state: 'needs-docker', docker: 'stopped', version: '2.0.0', message: MARKER_TEXT.needsDocker(2, 'stopped') };
  const render = (props, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(inApp(m, React.createElement(m.MarkerInstall, { call: async () => ({}), ...props }))); } finally { m.setUiLanguage('zh'); } };
  const html = render({ initialInstall: complete, markerStatus: status }), text = textOf(html);
  assert.match(text, /Docker 没有运行/); assert.match(text, /用 Docker/); assert.match(text, /不用 Docker/);
  assert.match(text, /修复安装（改装 1\.x）/); assert.match(text, /重新检测/);
  assert.doesNotMatch(text, /Marker 已就绪/);
  const en = textOf(render({ initialInstall: complete, markerStatus: status }, 'en'));
  assert.match(en, /Repair: install 1\.x/); assert.match(en, /Use Docker/); assert.match(en, /Docker is not running/);
  assert.doesNotMatch(en.replace(/F:\\StudyHub-Marker/g, ''), han);
  const manual = textOf(render({ initialInstall: { ...complete, status: 'idle', installed: false, installedFolder: '' }, initialPlan: null, markerStatus: { ...status, docker: 'missing', message: MARKER_TEXT.needsDocker(2, 'missing') } }));
  assert.match(manual, /没有找到 Docker/); assert.match(manual, /这份 Marker 不是 StudyHub 装的/); assert.match(manual, /marker-pdf>=1\.10,<2/);
  const ready = textOf(render({ initialInstall: complete, markerReady: true, markerStatus: { state: 'ready', version: '1.10.2' } }));
  assert.match(ready, /Marker 已就绪/); assert.doesNotMatch(ready, /Docker/);
});
