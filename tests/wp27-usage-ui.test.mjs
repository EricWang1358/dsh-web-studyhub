import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP27: token usage as DSH shows it. One layout everywhere (Token 用量, 缓存命中,
// 未缓存输入, 缓存读取, 缓存写入, 输出, in DSH's order, wording and `tok` unit),
// before a run as ranges, after it as exact counts, per feature in the stats.
const compiled = await build({ stdin: { contents: `
  export * as format from './ui/token-usage.js';
  export { TokenUsage, TokenEstimateView, JobUsage, ModelUsageView } from './ui/TokenUsage.jsx';
  export { default as Generate } from './ui/Generate.jsx';
  export { default as GenerationTrace } from './ui/GenerationTrace.jsx';
  export { default as GenerateAssist } from './ui/GenerateAssist.jsx';
  export { default as CaseCreate } from './ui/CaseCreate.jsx';
  export { RubricAnswer } from './ui/CaseWorkspace.jsx';
  export { default as WorkflowLesson } from './ui/WorkflowLesson.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { format, TokenUsage, TokenEstimateView, JobUsage, ModelUsageView, Generate, GenerationTrace, GenerateAssist, CaseCreate, RubricAnswer, WorkflowLesson, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (element) => renderToStaticMarkup(element);
const session = { uncachedInputTokens: 81139, outputTokens: 24266, cacheReadTokens: 1758854, cacheWriteTokens: 247421, calls: 7 };
const range = (low, high) => ({ low, high });
const estimate = { feature: 'generate', inputTokens: range(51895, 88353), outputTokens: range(6394, 7730), totalTokens: range(58289, 96083),
  uncachedInputTokens: range(39000, 88353), cacheReadTokens: range(0, 12895), calls: range(8, 10),
  stages: [{ id: 'plan', calls: 2, inputTokens: range(25802, 30966), outputTokens: range(1540, 1860) },
    { id: 'author', calls: 3, inputTokens: range(14841, 30848), outputTokens: range(4014, 4826) },
    { id: 'review', calls: 3, inputTokens: range(11252, 26539), outputTokens: range(840, 1044) }],
  notes: ['cache-depends', 'retries', 'large-selection'] };

test.afterEach(() => setUiLanguage('zh'));

test('usage lines are DSH\'s session panel: same fields, order, wording and unit', () => {
  setUiLanguage('zh');
  assert.deepEqual(format.usageRows(session).map((row) => [row.label, row.value]), [
    ['Token 用量', '2,111,680 tok'], ['缓存命中', '84%'], ['未缓存输入', '81,139 tok'], ['缓存读取', '1,758,854 tok'], ['缓存写入', '247,421 tok'], ['输出', '24,266 tok']]);
  assert.equal(format.usageText(session), 'Token 用量 2,111,680 tok · 缓存命中 84% · 未缓存输入 81,139 tok · 缓存读取 1,758,854 tok · 缓存写入 247,421 tok · 输出 24,266 tok');
  setUiLanguage('en');
  assert.equal(format.usageText(session), 'Token usage 2,111,680 tok · Cache hit 84% · Uncached input 81,139 tok · Cached input 1,758,854 tok · Cache write 247,421 tok · Output 24,266 tok');
});

test('like DSH, cache write is shown only when there was some and the hit rate only with input', () => {
  setUiLanguage('zh');
  const plain = { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.deepEqual(format.usageRows(plain).map((row) => row.label), ['Token 用量', '缓存命中', '未缓存输入', '缓存读取', '输出']);
  assert.equal(format.usageRows(plain)[1].value, '0%');
  const outputOnly = { uncachedInputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.ok(!format.usageRows(outputOnly).some((row) => row.label === '缓存命中'));
});

test('an estimate reads as the same lines with ranges, and a first run may hit no cache', () => {
  setUiLanguage('zh');
  const rows = format.estimateRows(estimate);
  assert.deepEqual(rows.map((row) => row.label), ['预计 Token 用量', '缓存命中', '未缓存输入', '缓存读取', '输出']);
  assert.equal(rows[0].value, '58.3K–96.1K tok');
  assert.equal(rows[1].value, '0–15%');
  assert.equal(rows[3].value, '0–12.9K tok');
  assert.equal(rows[4].value, '6.4K–7.7K tok');
  assert.equal(format.estimateText(estimate), '预计 Token 用量 58.3K–96.1K tok · 缓存命中 0–15% · 未缓存输入 39K–88.4K tok · 缓存读取 0–12.9K tok · 输出 6.4K–7.7K tok');
  assert.equal(format.estimateSummary(estimate), '预计 58.3K–96.1K tok · 8–10 次模型调用');
  assert.equal(format.estimateSummary({ ...estimate, calls: range(1, 1), totalTokens: range(900, 900) }), '预计 900 tok · 1 次模型调用');
  setUiLanguage('en');
  assert.equal(format.estimateSummary(estimate), 'Estimated 58.3K–96.1K tok · 8–10 model calls');
  assert.equal(format.estimateRows(estimate)[0].label, 'Estimated token usage');
  assert.equal(format.estimateRows(estimate)[3].label, 'Cached input');
});

test('TokenUsage renders the rows in DSH order with a copy button and the call count as small print', () => {
  setUiLanguage('zh');
  const html = render(React.createElement(TokenUsage, { usage: session }));
  const body = text(html);
  const order = ['Token 用量', '2,111,680 tok', '缓存命中', '84%', '未缓存输入', '81,139 tok', '缓存读取', '1,758,854 tok', '缓存写入', '247,421 tok', '输出', '24,266 tok'];
  let at = -1;
  for (const part of order) { const next = body.indexOf(part, at + 1); assert.ok(next > at, `${part} comes after the previous field in: ${body}`); at = next; }
  assert.match(html, /data-token-usage/);
  assert.match(html, /<dl/);
  assert.match(html, />复制</);
  assert.match(body, /7 次调用/);
  assert.doesNotMatch(html, /[¥$￥]|价格|费用|price|cost/i);
  setUiLanguage('en');
  const english = text(render(React.createElement(TokenUsage, { usage: session })));
  assert.ok(!han.test(english), english);
  assert.match(english, /Token usage 2,111,680 tok/);
  assert.match(english, /Copy/);
  assert.match(english, /7 calls/);
});

test('the estimate line states the range and calls, and its info panel lists the stages and what it cannot know', () => {
  setUiLanguage('zh');
  const closed = render(React.createElement(TokenEstimateView, { state: { status: 'ready', estimate } }));
  assert.match(text(closed), /预计 58\.3K–96\.1K tok · 8–10 次模型调用/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(text(closed), /规划考点/, 'the stages wait behind the info button');
  const open = text(render(React.createElement(TokenEstimateView, { state: { status: 'ready', estimate }, defaultOpen: true })));
  for (const part of ['规划考点', '出题与自查', '独立审阅', '×2', '×3', '缓存命中', '未缓存输入', '缓存读取', '输出']) assert.ok(open.includes(part), `${part}: ${open}`);
  assert.match(open, /缓存命中多少取决于服务商/);
  assert.match(open, /每一批只带上/, 'a large selection says what is sent where');
  assert.match(open, /出错重试/);
  assert.doesNotMatch(open, /[¥$￥]|价格|费用/);
  setUiLanguage('en');
  const english = text(render(React.createElement(TokenEstimateView, { state: { status: 'ready', estimate }, defaultOpen: true })));
  assert.ok(!han.test(english), english);
  assert.match(english, /Estimated 58\.3K–96\.1K tok · 8–10 model calls/);
  assert.match(english, /depends on the provider/);
});

test('an estimate that is loading or unavailable stays quiet, and one over the limit warns where the learner looks', () => {
  setUiLanguage('zh');
  assert.equal(text(render(React.createElement(TokenEstimateView, { state: { status: 'idle' } }))), '');
  assert.equal(text(render(React.createElement(TokenEstimateView, { state: { status: 'error' } }))), '');
  assert.match(text(render(React.createElement(TokenEstimateView, { state: { status: 'loading' } }))), /正在估算/);
  const blocked = { ...estimate, blocked: { code: 'over-limit', chars: 1200000, limit: 600000, fitSources: 190, totalSources: 400 }, notes: ['over-limit', 'cache-depends'] };
  const html = render(React.createElement(TokenEstimateView, { state: { status: 'ready', estimate: blocked } }));
  assert.match(html, /role="status"/);
  const body = text(html);
  assert.match(body, /400 份/);
  assert.match(body, /190 份/);
  assert.match(body, /缩小页码范围/);
});

test('a job shows what it used, set beside what was expected; an old job shows neither', () => {
  setUiLanguage('zh');
  const job = { tokenUsage: session, estimate: { totalTokens: range(58289, 96083), calls: range(8, 10), inputTokens: range(51895, 88353), outputTokens: range(6394, 7730) } };
  const body = text(render(React.createElement(JobUsage, { job })));
  assert.match(body, /实际用量/);
  assert.match(body, /Token 用量 2,111,680 tok/);
  assert.match(body, /预计 58\.3K–96\.1K tok/);
  assert.match(body, /7 次调用/);
  assert.equal(text(render(React.createElement(JobUsage, { job: { status: 'complete' } }))), '', 'a job from before usage was recorded');
  const estimated = text(render(React.createElement(JobUsage, { job: { estimate: job.estimate, status: 'running' } })));
  assert.match(estimated, /预计 58\.3K–96\.1K tok/);
  assert.doesNotMatch(estimated, /实际用量/);
  setUiLanguage('en');
  const english = text(render(React.createElement(JobUsage, { job })));
  assert.ok(!han.test(english), english);
  assert.match(english, /Actual usage/);
  assert.match(english, /Estimated 58\.3K–96\.1K tok/);
});

test('the generation trace carries the usage of the job and of each step', () => {
  setUiLanguage('zh');
  const job = { id: 'j', status: 'complete', steps: [{ id: 's1', stage: 'Planning evidence and learning targets · Group 1/1', status: 'complete', tokenUsage: { uncachedInputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } }],
    tokenUsage: session, estimate: { totalTokens: range(1000, 2000), calls: range(1, 2), inputTokens: range(800, 1500), outputTokens: range(200, 500) } };
  const html = render(React.createElement(GenerationTrace, { job }));
  assert.match(text(html), /实际用量/);
  assert.match(text(html), /1,200 tok/, 'the step\'s own total');
  assert.equal(text(render(React.createElement(GenerationTrace, { job: { id: 'j', status: 'complete', steps: [] } }))).includes('实际用量'), false);
});

const summary = (days) => ({ days, byFeature: {
  generate: { uncachedInputTokens: 50000, outputTokens: 9000, cacheReadTokens: 30000, cacheWriteTokens: 0, calls: 12 },
  repair: { uncachedInputTokens: 4000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 3 },
  coach: { uncachedInputTokens: 900, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 5 },
  audio: { uncachedInputTokens: 20000, outputTokens: 18000, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 30 } },
  total: { uncachedInputTokens: 74900, outputTokens: 28050, cacheReadTokens: 30000, cacheWriteTokens: 0, calls: 50 }, daily: [] });

test('the stats section lists the features that have usage, in the order of the product, and a total', () => {
  setUiLanguage('zh');
  const html = render(React.createElement(ModelUsageView, { state: { status: 'ready', summary: summary(7) }, days: 7, onDays() {}, onAudio() {} }));
  const body = text(html);
  const order = ['模型用量', '出题', '改题与复核', '陪学', '音频文本', '合计'];
  let at = -1;
  for (const part of order) { const next = body.indexOf(part, at + 1); assert.ok(next > at, `${part} in order: ${body}`); at = next; }
  assert.ok(!body.includes('学习流'), 'a feature without usage is not listed');
  assert.match(body, /Token 用量 132,950 tok/);
  assert.match(body, /缓存命中 29%/);
  assert.match(body, /未缓存输入 50,000 tok/);
  assert.match(body, /缓存读取 30,000 tok/);
  assert.match(body, /输出 9,000 tok/);
  assert.match(html, /aria-pressed="true"[^>]*>近 7 天</);
  assert.match(html, />近 30 天</);
  assert.match(body, /音频转录/, 'transcription minutes live on the audio page');
  assert.doesNotMatch(html, /[¥$￥]|价格|费用/);
  setUiLanguage('en');
  const english = text(render(React.createElement(ModelUsageView, { state: { status: 'ready', summary: summary(30) }, days: 30, onDays() {}, onAudio() {} })));
  assert.ok(!han.test(english), english);
  assert.match(english, /Model usage/);
  assert.match(english, /Total/);
  assert.match(english, /Uncached input 50,000 tok/);
  assert.match(english, /Cached input 30,000 tok/);
});

test('the stats section is quiet while loading, and says so when nothing was used', () => {
  setUiLanguage('zh');
  assert.match(text(render(React.createElement(ModelUsageView, { state: { status: 'loading' }, days: 30 }))), /正在统计/);
  assert.equal(text(render(React.createElement(ModelUsageView, { state: { status: 'error' }, days: 30 }))), '');
  const empty = text(render(React.createElement(ModelUsageView, { state: { status: 'ready', summary: { days: 30, byFeature: {}, total: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }, daily: [] } }, days: 30 })));
  assert.match(empty, /还没有模型用量记录/);
});

test('the 创建题组 form carries the estimate where the summary line is, only once something is selected', () => {
  setUiLanguage('zh');
  const data = { root: 'root', sources: [{ id: 's1', title: 'notes.md', text: 'x'.repeat(2000) }], focus: { courses: [] }, courses: [], jobs: [], model: { ready: true } };
  const base = { data, busy: false, running: false, act() {}, call: () => Promise.resolve({}), openDraft() {}, setPage() {}, setNotice() {}, genSource: 'files', setGenSource() {},
    gen: { kind: 'mixed', count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '' }, setGen() {}, setSelectedSources() {}, setModal() {} };
  const selected = render(React.createElement(Generate, { ...base, selectedSources: ['s1'] }));
  assert.match(selected, /data-token-estimate/);
  const none = render(React.createElement(Generate, { ...base, selectedSources: [] }));
  assert.doesNotMatch(none, /data-token-estimate/);
});

test('帮我想想 carries its own tiny estimate slot', () => {
  setUiLanguage('zh');
  const html = render(React.createElement(GenerateAssist, { ready: true, estimate: React.createElement('i', { 'data-slot': 'estimate' }) }));
  assert.match(html, /data-slot="estimate"/);
  assert.doesNotMatch(render(React.createElement(GenerateAssist, { ready: true })), /data-slot/);
});

test('a case paper, a rubric answer and a lesson each carry their estimate where the action is', () => {
  setUiLanguage('zh');
  const caseData = { root: 'r', sources: [{ id: 's1', title: 'notes', text: 'x'.repeat(500) }], focus: { courses: [] }, courses: [], model: { ready: true } };
  const caseForm = (initial) => render(React.createElement(CaseCreate, { data: caseData, busy: false, act() {}, call: () => Promise.resolve({}), setNotice() {}, initial }));
  assert.match(caseForm({ sourceIds: ['s1'] }), /data-token-estimate/, 'sources chosen: the paper can be priced');
  assert.doesNotMatch(caseForm({ sourceIds: [] }), /data-token-estimate/);
  const run = { id: 'run', deckId: 'deck', card: { id: 'card', kind: 'open', prompt: 'Why bridge?', marks: 6, rubricCriteria: [{ id: 'c1', label: 'L', marks: 6 }] } };
  const answer = (value) => render(React.createElement(RubricAnswer, { run, data: caseData, value, call: () => Promise.resolve({}), onChange() {}, onSubmit() {} }));
  assert.match(answer('My answer'), /data-token-estimate/);
  assert.doesNotMatch(answer(''), /data-token-estimate/, 'nothing typed, nothing to grade');
  const lesson = (record) => render(React.createElement(WorkflowLesson, { topic: '缓存', content: '', record, resources: { modelReady: true }, disabled: false,
    onTeach() {}, onUndo() {}, call: () => Promise.resolve({}), sessionId: 'session', stepId: 'lesson' }));
  assert.match(lesson({}), /data-token-estimate/, 'the empty lesson shows what the full explanation is expected to use');
  const done = text(render(React.createElement(WorkflowLesson, { topic: '缓存', content: '## 讲解\n\n内容', resources: { modelReady: true }, disabled: false, onTeach() {}, onUndo() {},
    record: { teaching: { status: 'done', tokenUsage: session } } })));
  assert.match(done, /本次讲解的用量/);
  assert.match(done, /Token 用量 2,111,680 tok/);
  setUiLanguage('en');
  const english = text(render(React.createElement(WorkflowLesson, { topic: 'Cache', content: '## Lesson\n\nbody', resources: { modelReady: true }, disabled: false, onTeach() {}, onUndo() {},
    record: { teaching: { status: 'done', tokenUsage: session } } })));
  assert.match(english, /Usage of this lesson/);
  assert.match(english, /Token usage 2,111,680 tok/);
});

test('nothing this work package ships mentions a price or a currency', async () => {
  const files = ['lib/token-usage.js', 'lib/token-estimate.js', 'lib/model-usage.js', 'lib/usage-scope.js', 'ui/token-usage.js', 'ui/TokenUsage.jsx', 'ui/token-usage.css', 'ui/locales/en.usage.json'];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const stripped = file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.css') ? source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '') : source;
    assert.doesNotMatch(stripped, /[¥￥]|\$\d|\b(?:USD|CNY|RMB)\b|价格|费用|\bpric(?:e|es|ing)\b/i, `${file} has no price or currency in its code or copy`);
  }
});
