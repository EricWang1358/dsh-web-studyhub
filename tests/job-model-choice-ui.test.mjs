import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* 「仅本任务生效」, the box: the 模型 select of a running question run lists the host's models (the catalog Settings' 生成模型 lists) by their names, its
   first choice follows the generation model and names it, the levels of the stages are those of the model in force, 存为默认 never saves the model,
   and every word has its English. */
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export * from './ui/tasks/task-control.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const key = (provider, model) => JSON.stringify([provider, model]);
const GROUPS = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V41-Flash' }, { id: 'deepseek-v4.1-pro', name: 'DeepSeek-V41-Pro' }] },
  { id: 'siliconflow', name: 'SiliconFlow', models: [{ id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B' }] }, { id: 'empty', name: 'Nothing', models: [] }];
const GENERATION = { provider: 'deepseek', model: 'deepseek-v4.1-flash', label: 'DeepSeek · DeepSeek-V41-Flash', session: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } };
const STAGES = ['effortPlanning', 'effortReview', 'effortWriting', 'effortRepair'];
const generation = (values = {}) => ({ id: 'g1', status: 'running', deckTitle: 'Deck', requestedTotal: 10, savedCount: 2, startedAt: '2026-10-08T10:00:00.000Z', paused: false,
  control: { values: { concurrency: 4, model: 'follow', effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'medium', applySuggestions: false, ...values },
    limits: { concurrency: { type: 'int', min: 1, max: 8 }, model: { type: 'model' }, ...Object.fromEntries(STAGES.map((stage) => [stage, { type: 'enum', values: ['follow', 'default', 'lowest', 'low', 'medium', 'high', 'highest'] }])),
      applySuggestions: { type: 'bool' } } } });
const flat = (options) => options.flatMap((option) => option.options || [option]);
const env = (extra = {}) => ({ groups: GROUPS, generation: GENERATION, ...extra });

test('the 模型 select lists the host models by name, grouped by provider, after the choice that follows the generation model and names it', () => {
  const item = m.controlItems(generation(), GENERATION.session, env()).find((entry) => entry.key === 'model');
  assert.equal(item.type, 'enum', 'drawn as a choice like the other selects');
  assert.equal(item.label, '模型');
  assert.equal(item.value, 'follow');
  assert.deepEqual(item.options[0], { value: 'follow', label: '跟随设置 · DeepSeek · DeepSeek-V41-Flash', triggerLabel: '跟随设置',
    tip: '用「设置 › 学习库与模型」里的生成模型：现在是 DeepSeek · DeepSeek-V41-Flash。', wrap: true });
  assert.deepEqual(item.options.slice(1).map((group) => [group.group, group.options.map((option) => option.label)]),
    [['DeepSeek', ['DeepSeek-V41-Flash', 'DeepSeek-V41-Pro']], ['SiliconFlow', ['Qwen3 235B']]], 'a provider without models is not a heading');
  assert.equal(item.options[2].options[0].value, key('siliconflow', 'Qwen/Qwen3-235B-A22B'));
  assert.ok(flat(item.options.slice(1)).every((option) => option.tip === '只用于这个任务：设置里的生成模型和其他任务不变。'), 'a chosen model says it is for this task only');
  const keys = m.controlItems(generation(), GENERATION.session, env()).map((entry) => entry.key);
  assert.deepEqual(keys, ['concurrency', 'model', ...STAGES, 'applySuggestions'], 'next to the other choices of the run, before the levels it decides');
});

test('a chosen model the host does not list any more is still shown; with nothing to choose there is no select', () => {
  const gone = key('old', 'retired-model');
  const item = m.controlItems(generation({ model: gone }), undefined, env()).find((entry) => entry.key === 'model');
  assert.deepEqual(flat(item.options).at(-1), { value: gone, label: 'retired-model', tip: '只用于这个任务：设置里的生成模型和其他任务不变。' });
  assert.equal(m.controlItems(generation(), undefined, {}).some((entry) => entry.key === 'model'), false, 'no catalog and following: nothing to offer');
  assert.equal(m.controlItems(generation(), undefined, { groups: [] }).some((entry) => entry.key === 'model'), false);
  assert.ok(m.controlItems(generation({ model: gone }), undefined, {}).some((entry) => entry.key === 'model'), 'a run on a model of its own can always go back');
  assert.deepEqual(m.controlItems(generation(), undefined, env({ generation: undefined })).find((entry) => entry.key === 'model').options[0].label, '跟随设置');
});

test('the levels of the stages are those of the model in force, through the one mapping of 出题偏好', () => {
  const deepseek = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }];
  const items = m.controlItems(generation(), GENERATION.session, env({ efforts: deepseek }));
  const repair = items.find((entry) => entry.key === 'effortRepair'), writing = items.find((entry) => entry.key === 'effortWriting');
  assert.deepEqual(repair.options.map((option) => option.label), ['跟随当前会话 · deepseek-v4.1-flash · high', '模型默认', 'Off', 'Low', 'High', 'Max'], 'the model own names');
  assert.equal(repair.value, 'high', 'this model has no 「中」: the select shows the level really used');
  assert.equal(repair.options.find((option) => option.value === 'high').tip, '你之前选的「中」，当前模型没有，已用「High」');
  assert.equal(writing.value, 'low');
  assert.equal(writing.options.find((option) => option.value === 'low').tip, undefined, 'met exactly: nothing to explain');
  // another model, other levels: the same stage is re-derived
  const other = m.controlItems(generation({ model: key('siliconflow', 'Qwen/Qwen3-235B-A22B') }), GENERATION.session, env({ efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] }));
  assert.equal(other.find((entry) => entry.key === 'effortRepair').value, 'medium');
  assert.deepEqual(other.find((entry) => entry.key === 'effortRepair').options.slice(2).map((option) => option.label), ['Low', 'Medium', 'High']);
  // a model without levels: the existing words
  const none = m.controlItems(generation(), GENERATION.session, env({ efforts: [] })).find((entry) => entry.key === 'effortRepair');
  assert.deepEqual(none.options.map((option) => option.value), ['follow', 'default']);
  assert.equal(none.value, 'default');
  assert.equal(none.options[1].tip, '当前模型没有可调的推理强度，「中」不起作用，按模型默认运行');
  // levels not known (a host that cannot describe models): the relative choices, as before
  const unknown = m.controlItems(generation(), GENERATION.session, env()).find((entry) => entry.key === 'effortRepair');
  assert.equal(unknown.options.length, 7);
  assert.equal(unknown.value, 'medium');
});

test('the model in force: the run own choice, else the generation model; 存为默认 never saves the model; the log names it', () => {
  assert.deepEqual(m.modelInForce(generation(), GENERATION), { provider: 'deepseek', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(m.modelInForce(generation({ model: key('siliconflow', 'Qwen/Qwen3-235B-A22B') }), GENERATION), { provider: 'siliconflow', model: 'Qwen/Qwen3-235B-A22B' });
  assert.equal(m.modelInForce(generation(), undefined), null);
  const saved = m.defaultsPatch(generation({ model: key('siliconflow', 'Qwen/Qwen3-235B-A22B') }));
  assert.equal(saved.action, 'settings');
  assert.equal('model' in saved.args.generation, false, '存为默认 writes the other values only');
  assert.equal(m.appliedText({ model: key('siliconflow', 'Qwen/Qwen3-235B-A22B') }), '✓ 已生效 · 模型 → Qwen/Qwen3-235B-A22B', 'the log line names the model by its id');
  assert.equal(m.appliedText({ model: 'follow' }), '✓ 已生效 · 模型 → 跟随设置');
  const items = m.controlItems(generation(), GENERATION.session, env());
  assert.equal(m.appliedText({ model: key('siliconflow', 'Qwen/Qwen3-235B-A22B') }, items), '✓ 已生效 · 模型 → Qwen3 235B', 'the row says it as its select does');
});

const render = (job, { language = 'zh', host = { modelGroups: GROUPS } } = {}) => {
  m.setUiLanguage(language);
  const html = renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [], model: GENERATION }, openers: { resultOf: () => null } }),
    { data: { jobs: [job], model: GENERATION }, host, app: { lib: { taskFocus: null } } }));
  m.setUiLanguage('zh');
  return html.slice(html.indexOf('aria-label="'), html.indexOf('class="tc-body"'));
};

test('the box draws the select with the host models and says in one line that the model is for this task only', () => {
  const row = render(generation());
  assert.match(row, /data-control="model"/);
  assert.match(row, /<label class="tc-control__label"[^>]*>模型<\/label>/);
  assert.match(row, /<optgroup label="DeepSeek"><option value="\[&quot;deepseek&quot;,&quot;deepseek-v4.1-flash&quot;\]"[^>]*>DeepSeek-V41-Flash<\/option>/);
  assert.match(row, /<option value="follow"[^>]*selected=""[^>]*>跟随设置 · DeepSeek · DeepSeek-V41-Flash<\/option>/);
  assert.match(row, /改动从下一次调用生效，模型仅本任务生效/);
  const save = /title="([^"]*)"[^>]*>存为默认/.exec(row)?.[1] ?? '';
  assert.ok(save && !save.includes('模型'), `存为默认 does not name the model: ${save}`);
  const en = render(generation(), { language: 'en' });
  assert.match(en, />Model<\/label>/);
  assert.match(en, />As in Settings · DeepSeek · DeepSeek-V41-Flash</);
  assert.match(en, /Applies from the next call; model for this task only/);
  assert.doesNotMatch(en, /[一-鿿]/, 'no Chinese left in the English box');
});

test('a host that lists no models draws the box as it was', () => {
  const row = render(generation(), { host: {} });
  assert.doesNotMatch(row, /data-control="model"/);
  assert.match(row, /改动从下一次调用生效</);
});

/* #944: the box says that the model and the levels change what a run uses, and what the estimate made before the run does about them. Every clause is a fact of the code:
   the estimate is made once when the job starts (lib/contexts/generation/generate/estimate.js estimateInto), it reads no reasoning level (lib/token-estimate.js: a high level is only noted), and
   a change made here goes to job.control and applies from the next call. */
const USAGE_ZH = '模型和推理档位会明显改变用量。';

test('the box says in one short line that the model and the levels change the usage, the detail in a tooltip, and only on a job that has one of them', () => {
  const row = render(generation());
  assert.match(row, /<span class="tc-controls__usage"[^>]*tabindex="0"[^>]*>模型和推理档位会明显改变用量。<\/span>/, 'the visible sentence, reachable by keyboard');
  const tip = /role="tooltip"[^>]*>(出题前的估算[^<]*)</.exec(row)?.[1] ?? '';
  assert.match(tip, /只在任务开始时/, 'made once, when the job starts');
  assert.match(tip, /不随推理档位变化/, 'not scaled by the level');
  assert.match(tip, /算作输出/, 'more thinking is more output');
  assert.match(tip, /超出估算，包括它的上限/, 'the real usage may end above the estimate, even above its upper end');
  assert.match(tip, /下一次调用生效，不会重新估算/, 'a change here does not redo the estimate');
  assert.doesNotMatch(row, /title="[^"]*明显改变用量/, 'a Tooltip, never title=');
  // the slot is in the first render, whatever the host lists: a host that lists no models still has the levels of the stages
  assert.match(render(generation(), { host: {} }), /tc-controls__usage/);
  // a job with neither a model nor a level to change (here only the parallel count), and a job that has ended: nothing new
  const plain = { ...generation(), control: { values: { concurrency: 4 }, limits: { concurrency: { type: 'int', min: 1, max: 8 } } } };
  assert.doesNotMatch(render(plain), /tc-controls__usage/);
  assert.doesNotMatch(render({ ...generation(), status: 'complete', finishedAt: '2026-10-08T10:30:00.000Z' }), /tc-controls__usage/);
  assert.ok(!render(plain).includes(USAGE_ZH));
});

test('the sentence has its English, and the English box stays free of Chinese', () => {
  const en = render(generation(), { language: 'en' });
  assert.match(en, /<span class="tc-controls__usage"[^>]*>Model and reasoning level change the usage a lot\.<\/span>/);
  assert.match(en, /role="tooltip"[^>]*>The estimate is made once, when the task starts, from typical usage\./);
  assert.match(en, /counted as output/);
  assert.match(en, /even above its upper end/);
  assert.match(en, /does not redo the estimate/);
  assert.doesNotMatch(en, /[一-鿿]/, 'no Chinese left in the English box');
});
