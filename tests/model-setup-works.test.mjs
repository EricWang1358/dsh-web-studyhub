import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* Model setup that works (the model-setup batch of the learner-flow work): the gate says WHERE the key is set (DSH keeps it, StudyHub has no key field),
   the button is named for where it goes (打开模型设置 only when the host opens DSH's own panel, else 前往设置), Settings › 学习库与模型 shows
   whether a model is connected and, when it is not, the same gate with the exact steps, a compact one-line form of the gate stands where there was
   plain text or a silently disabled button, and 创建题组 shows the gate on top like 备考补习 does. Static markup, Chinese and English. */

const m = await loadUi(`
  export { default as ModelSetupGate, gateTitle, gateMessage, modelFact, MODEL_GATE_FEATURES } from './ui/ModelSetupGate.jsx';
  export { default as ModelErrorNote, ModelSettingsContext, modelSettingsLabel } from './ui/ModelErrorNote.jsx';
  export { default as AiHelperNote } from './ui/AiHelperNote.jsx';
  export { default as ModelPane } from './ui/settings/ModelPane.jsx';
  export { default as Generate } from './ui/Generate.jsx';
  export { default as Sources } from './ui/Sources.jsx';
  export { default as MergeSuggestions } from './ui/study-map/MergeSuggestions.jsx';
  export { default as Welcome } from './ui/Welcome.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const read = file => readFileSync(file, 'utf8');
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const render = (element, { language = 'zh', ...options } = {}) => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, options)); } finally { m.setUiLanguage('zh'); }
};
const gate = (props, options) => render(h(m.ModelSetupGate, props), options);
const READY = { ready: true, reason: 'ok', label: 'DeepSeek · V4 Flash' };
const NO_ROUTE = { ready: false, reason: 'no-route', label: '' };
const NO_KEY = { ready: false, reason: 'no-credential', label: 'DeepSeek · V4 Flash' };
const NO_PROVIDER = { ready: false, reason: 'no-route', label: 'Acme · acme-1' };
const NO_CALL = { ready: false, reason: 'unknown', label: 'DeepSeek · V4 Flash' };
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ variant: /sh-btn--(primary|secondary|quiet|link|danger)/.exec(match[1])?.[1], text: text(match[2]) }));
const labelOf = (html, variant) => buttons(html).find(button => button.variant === variant)?.text;
const steps = html => [...html.matchAll(/<li><span class="sh-setup__num"[^>]*>\d+<\/span><span class="sh-setup__step">([\s\S]*?)<\/span><\/li>/g)].map(match => text(match[1]));

test('the block gate says where the key is set in DSH, for each reason, and never promises a key field', () => {
  const none = gate({ variant: 'block', feature: 'generate', model: NO_ROUTE, onOpenSettings: noop });
  assert.deepEqual(steps(none), [
    '在 DSH 打开「设置 › 模型」，选一个服务商，填入它的 API Key 并保存',
    '选一个模型：在对话输入框的模型选择器里选，或在 StudyHub「设置 › 学习库与模型」的「生成模型」里选',
    '回到这里，点「生成并检查题组」']);
  assert.doesNotMatch(none, /打开模型设置，选择一个服务商|填入这个服务商的 API Key/, 'the old steps promised a button that led nowhere');

  const key = gate({ variant: 'block', feature: 'generate', model: NO_KEY, onOpenSettings: noop });
  assert.deepEqual(steps(key), ['在 DSH 打开「设置 › 模型」，在「DeepSeek」卡片填入 API Key 并保存', '回到这里，点「生成并检查题组」'], 'a chosen model needs only its key');
  assert.match(text(key), /已选择「DeepSeek · V4 Flash」，但 DSH 里还没有它的 API Key/);

  const provider = gate({ variant: 'block', feature: 'generate', model: NO_PROVIDER, onOpenSettings: noop });
  assert.match(text(provider), /已选择「Acme · acme-1」，但 DSH 里没有这个服务商/);
  assert.equal(steps(provider).length, 2, 'choose another model, then come back');

  const noCall = gate({ variant: 'block', feature: 'generate', model: NO_CALL, onOpenSettings: noop });
  assert.match(text(noCall), /已选择「DeepSeek · V4 Flash」，但这个 DSH 没有让 StudyHub 调用模型/);
  assert.deepEqual(steps(noCall), [], 'no key step for a host that did not give StudyHub the model');

  // A reason the host did not give (a bare "not ready") makes no claim about the cause.
  assert.doesNotMatch(text(gate({ variant: 'block', feature: 'generate', model: { ready: false, reason: 'unknown', label: '' }, onOpenSettings: noop })), /没有让 StudyHub 调用模型|没有这个服务商/);
  assert.equal(m.modelFact({ ready: false, reason: 'no-route', label: '' }), '');
  assert.equal(m.modelFact(READY), '');
  assert.equal(gate({ variant: 'block', feature: 'generate', model: READY, onOpenSettings: noop }), '', 'a ready model draws nothing');
  for (const model of [NO_ROUTE, NO_KEY, NO_PROVIDER, NO_CALL])
    assert.doesNotMatch(gate({ variant: 'block', feature: 'generate', model, onOpenSettings: noop }, { language: 'en' }), han, `English: ${model.reason}`);
});

test('the button is named for where it goes: 打开模型设置 only when the host opens DSH\'s own panel, else 前往设置', () => {
  assert.equal(labelOf(gate({ variant: 'block', model: NO_ROUTE, onOpenSettings: noop }), 'primary'), '前往设置');
  assert.equal(labelOf(gate({ variant: 'block', model: NO_ROUTE, onOpenSettings: noop }, { host: { openModelSettings: noop } }), 'primary'), '打开模型设置');
  assert.equal(m.modelSettingsLabel({}), '前往设置');
  assert.equal(m.modelSettingsLabel({ openModelSettings: noop }), '打开模型设置');
  assert.equal(m.modelSettingsLabel(undefined), '前往设置');
  m.setUiLanguage('en');
  try { assert.equal(m.modelSettingsLabel({}), 'Go to settings'); assert.equal(m.modelSettingsLabel({ openModelSettings: noop }), 'Open model settings'); } finally { m.setUiLanguage('zh'); }
  const english = html => html.match(/<button[^>]*sh-inline__action[^>]*>([^<]+)<\/button>/)?.[1];
  assert.equal(english(gate({ variant: 'inline', feature: 'ingest', model: NO_ROUTE, onOpenSettings: noop })), '前往设置');
});

test('the gate opens the model settings the page offers, from the page\'s context when none is passed, and draws no button when there is none', () => {
  const withContext = (value, element) => h(m.ModelSettingsContext.Provider, { value }, element);
  const props = { variant: 'compact', feature: 'organize', model: NO_ROUTE };
  assert.match(render(withContext(noop, h(m.ModelSetupGate, props))), /<button/, 'the app\'s context carries openModelSettings');
  assert.doesNotMatch(render(h(m.ModelSetupGate, props)), /<button/, 'no handler, no button');
  assert.doesNotMatch(render(withContext(noop, h(m.ModelSetupGate, { ...props, onOpenSettings: false }))), /<button/, 'false: the page IS the settings, a link to itself would do nothing');
  const own = [];
  assert.match(render(withContext(noop, h(m.ModelSetupGate, { ...props, onOpenSettings: () => own.push(1) }))), /<button/);
});

test('the compact gate is one line with a link, for a control that cannot work', () => {
  const html = gate({ variant: 'compact', feature: 'organize', model: NO_ROUTE, onOpenSettings: noop });
  assert.match(html, /data-model-gate="compact"/);
  assert.match(html, /role="status"/);
  assert.match(text(html), /^请 AI 建议课程归属需要先配置模型；手动选择课程不需要。 前往设置$/);
  assert.doesNotMatch(html, /sh-setup|sh-inline|sh-banner/, 'no box: it stands next to the control');
  assert.equal(gate({ variant: 'compact', feature: 'organize', model: READY, onOpenSettings: noop }), '');
  assert.match(gate({ variant: 'compact', feature: 'organize', model: NO_ROUTE, className: 'mine' }), /class="[^"]*\bmine\b/);
  assert.ok(m.MODEL_GATE_FEATURES.length >= 16, 'every feature has its own wording');
  for (const feature of m.MODEL_GATE_FEATURES) {
    for (const variant of ['compact', 'inline', 'banner', 'block']) {
      const zh = gate({ variant, feature, model: NO_ROUTE, onOpenSettings: noop }), en = gate({ variant, feature, model: NO_ROUTE, onOpenSettings: noop }, { language: 'en' });
      assert.ok(text(zh).length > 10, `${feature}/${variant}: says something`);
      assert.doesNotMatch(en, han, `${feature}/${variant}: English`);
    }
    assert.match(m.gateMessage(feature), /模型/, `${feature}: a one-line message for a toast`);
  }
});

const pane = (model, { host = {}, refresh, language = 'zh' } = {}) => render(h(m.ModelPane, { data: { root: 'r', model, modelReady: model.ready, sources: [], decks: [] }, host }),
  { language, host, app: { core: { call: noop, act: noop, busy: false, notify: noop, setError: noop, refresh }, host } });

test('Settings › 学习库与模型 starts with whether a model is connected', () => {
  const ok = pane(READY);
  assert.match(text(ok), /模型已连接：DeepSeek · V4 Flash/);
  assert.match(text(ok), /密钥是否有效，要到真正用的时候才会知道/, 'what "connected" does and does not know');
  assert.doesNotMatch(ok, /sh-setup/, 'connected: no gate');
  assert.ok(ok.indexOf('模型已连接：') < ok.indexOf('binding-panel'), 'the status is at the top of the pane');

  const guess = pane({ ready: true, reason: 'unknown', label: 'DeepSeek · V4 Flash' });
  assert.match(text(guess), /已选择模型：DeepSeek · V4 Flash/);
  assert.doesNotMatch(text(guess), /已连接/, 'a model nobody could check is not called connected');
  assert.match(text(guess), /还不能确认可用/);
});

test('Settings › 学习库与模型: not connected shows the reason and the gate with the exact steps, and a re-check', () => {
  const none = pane(NO_ROUTE, { refresh: noop });
  assert.match(none, /class="sh-setup__badge">模型未连接</);
  assert.match(none, /先配置一个 AI 模型/);
  assert.match(text(none), /还没有选择 AI 模型。/);
  assert.deepEqual(steps(none), [
    '在 DSH 打开「设置 › 模型」，选一个服务商，填入它的 API Key 并保存',
    '在下面的「生成模型」里选一个模型，或在对话输入框的模型选择器里选',
    '回到这里，状态会变成「模型已连接」；没有变就点「重新检查」']);
  assert.equal(labelOf(none, 'quiet'), '重新检查', 'one click to read the state again');
  assert.equal(buttons(none).filter(button => /前往设置|打开模型设置/.test(button.text)).length, 0, 'this host cannot open DSH\'s panel: no button that would only land here');
  assert.ok(none.indexOf('sh-setup') < none.indexOf('binding-panel'), 'the gate is above the folder and the model choice');
  assert.doesNotMatch(none, /name="[^"]*(?:key|Key)|type="password"/, 'StudyHub has no key field: none is drawn');

  const key = pane(NO_KEY);
  assert.match(text(key), /已选择「DeepSeek · V4 Flash」，但 DSH 里还没有它的 API Key/);
  assert.deepEqual(steps(key), ['在 DSH 打开「设置 › 模型」，在「DeepSeek」卡片填入 API Key 并保存', '回到这里，状态会变成「模型已连接」']);
  assert.doesNotMatch(key, /重新检查/, 'no re-check without a refresh to call: the last step does not promise one');

  const opens = pane(NO_ROUTE, { host: { openModelSettings: noop }, refresh: noop });
  assert.equal(labelOf(opens, 'primary'), '打开模型设置', 'the host offers DSH\'s model panel: the button opens it');

  for (const model of [NO_ROUTE, NO_KEY, READY, { ready: true, reason: 'unknown', label: 'A · b' }])
    assert.doesNotMatch(text(pane(model, { language: 'en', refresh: noop })).replace(/[‘’“”]/g, ''), han, `English: ${model.reason}`);
});

const generateProps = data => ({ data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop, genSource: 'files', setGenSource: noop,
  gen: { kind: 'mixed', count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '' }, setGen: noop, selectedSources: ['a'], setSelectedSources: noop, setModal: noop,
  askInChat: noop, openModelSettings: noop });
const library = over => ({ root: 'lib', decks: [], drafts: [], jobs: [], sources: [{ id: 'a', title: '索引笔记', text: '数据库索引加快查找。', courses: ['数据库'] }],
  focus: { course: '数据库', courses: [{ name: '数据库' }] }, ...over });

test('创建题组 shows the gate on top as a banner, like 备考补习, and the submit is only off', () => {
  const off = render(h(m.Generate, generateProps(library({ model: NO_ROUTE, modelReady: false }))));
  const form = off.indexOf('<form');
  assert.ok(off.indexOf('sh-banner') > -1 && off.indexOf('sh-banner') < form, 'the banner comes before the form');
  assert.equal((off.match(/sh-banner--warning/g) || []).length, 1);
  assert.doesNotMatch(off, /sh-setup/, 'no block gate under the form any more');
  assert.match(text(off), /还没有可用的 AI 模型 可以先选好资料和题型；生成前需要先配置模型。 前往设置/);
  const submit = off.match(/<button[^>]*data-tour="generate-submit"[^>]*>/)?.[0] || '';
  assert.match(submit, /disabled/, 'the submit stays where it was, off');
  assert.match(submit, /type="submit"/);
  assert.equal(off.split('先配置一个 AI 模型').length - 1, 0, 'one statement: the banner, not the block title too');
  const on = render(h(m.Generate, generateProps(library({ model: READY, modelReady: true }))));
  assert.doesNotMatch(on, /sh-banner--warning|sh-setup/);
  assert.doesNotMatch(on.match(/<button[^>]*data-tour="generate-submit"[^>]*>/)?.[0] || '', /disabled/);
  const jsonTab = render(h(m.Generate, { ...generateProps(library({ model: NO_ROUTE, modelReady: false })), genSource: 'json' }));
  assert.doesNotMatch(jsonTab, /sh-banner--warning/, 'importing a deck needs no model: no banner on that tab');
  assert.doesNotMatch(render(h(m.Generate, generateProps(library({ model: NO_ROUTE, modelReady: false }))), { language: 'en' }), /先配置|模型/);
});

const organize = data => render(h(m.Sources, { data, setModal: noop, onGenerate: noop }), { call: noop, act: noop });
const sourceData = over => ({ root: 'lib', sources: [{ id: 'n1', title: '笔记', text: '内容内容内容', createdAt: '2025-03-04T09:00:00.000Z', courses: ['DB'], usedBy: [] }],
  decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [{ name: 'DB' }] }, ...over });

test('资料 › 请 AI 建议: the disabled button says why and links to the settings', () => {
  const off = organize(sourceData({ model: NO_ROUTE, modelReady: false }));
  assert.match(off, /data-model-gate="compact"/);
  assert.match(text(off), /请 AI 建议课程归属需要先配置模型；手动选择课程不需要。/);
  assert.match(off.match(/<button[^>]*>请 AI 建议<\/button>/)?.[0] || '', /disabled/);
  assert.doesNotMatch(organize(sourceData({ model: READY, modelReady: true })), /data-model-gate/, 'a ready model: nothing to say');
});

test('合并建议 without a model is the compact gate, not plain text', () => {
  const merge = { suggestions: { course: 'DB', method: 'unavailable', proposals: [] }, busy: false, error: '', close: noop };
  const html = render(h(m.MergeSuggestions, { merge, busy: false }));
  assert.match(html, /data-model-gate="compact"/);
  assert.match(text(html), /合并建议需要先配置模型；也可以在题组管理中手动合并。/);
  assert.doesNotMatch(html, /当前没有可用模型/);
  const none = render(h(m.MergeSuggestions, { merge: { ...merge, suggestions: { ...merge.suggestions, method: 'model' } }, busy: false }));
  assert.match(none, /没有发现值得合并的题组/);
  assert.doesNotMatch(none, /data-model-gate/);
});

test('学习流 and the daily plan use the compact gate where they had plain text, and the portal keeps the app\'s way to the settings', () => {
  const flows = read('ui/Workflows.jsx'), lesson = read('ui/WorkflowLesson.jsx'), portal = read('ui/WorkflowPortal.jsx'), plan = read('ui/DailyPlan.jsx');
  assert.match(flows, /<ModelSetupGate variant="compact" feature="workflow"/);
  assert.match(lesson, /<ModelSetupGate variant="compact" feature="lesson"/);
  assert.match(portal, /<ModelSetupGate variant="compact" feature="skeleton"/);
  assert.match(plan, /<ModelSetupGate variant="compact" feature="plan"/);
  assert.doesNotMatch(flows, /还没有连接模型：会按主题/);
  assert.doesNotMatch(lesson, /连接模型后即可生成讲解/);
  assert.doesNotMatch(portal, /连接模型后可以一键生成/);
  assert.doesNotMatch(plan, /配置模型后可以协商安排/);
  assert.match(portal, /useContext\(ModelSettingsContext\)/, 'the portal falls back to the app\'s context instead of masking it with null');
  for (const [feature, line] of [['workflow', '讲解、复述反馈和后台骨架需要先配置模型；现在会按主题和题组名匹配材料。'], ['lesson', '生成讲解需要先配置模型；也可以在下方请主对话补充材料。'],
    ['skeleton', '一键生成骨架需要先配置模型；也可以请主对话帮你设计骨架。'], ['plan', '协商安排需要先配置模型；已接受的行动可以继续。']])
    assert.equal(m.gateMessage(feature), line, feature);
});

test('every page that said "no model" in its own words says it with the gate\'s words and the one link wording', () => {
  const welcome = render(h(m.Welcome, { model: NO_KEY, sample: null, onSetupModel: noop }));
  assert.match(welcome, /先配置一个 AI 模型/);
  assert.match(text(welcome), /在 DSH 打开「设置 › 模型」，在「DeepSeek」卡片填入 API Key 并保存/);
  assert.doesNotMatch(welcome, /连接一个 AI 模型|打开模型设置，选择一个服务商和模型/);
  assert.equal(render(h(m.Welcome, { model: READY, sample: null, onSetupModel: noop })).includes('sh-setup'), false);
  assert.equal(labelOf(welcome, 'primary'), '导入我的第一份资料', 'the first screen leads with its own button');
  assert.equal(labelOf(welcome, 'secondary'), '前往设置', 'the model button is a secondary one');
  const note = render(h(m.ModelErrorNote, { error: 'NO_ADAPTER: Configure a model provider', onSettings: noop }));
  assert.match(note, />前往设置<\/button>/);
  assert.match(render(h(m.ModelErrorNote, { error: 'NO_ADAPTER: Configure a model provider', onSettings: noop }), { host: { openModelSettings: noop } }), />打开模型设置<\/button>/);
  const helper = render(h(m.AiHelperNote, { unavailable: { reason: 'no-model' }, fallback: '先用按章节做的路径', onSettings: noop }));
  assert.match(helper, />前往设置<\/button>/);
  assert.match(text(helper), /还没有可用的 AI 模型。先用按章节做的路径。/);
});

test('the install docs and the READMEs say where the status is, not that a button is always there', () => {
  for (const file of ['docs/install.zh-CN.md', 'README.zh-CN.md']) {
    const doc = read(file);
    assert.doesNotMatch(doc, /(?:配置提示和|先显示)「打开模型设置」/, `${file}: the button is not always there`);
    assert.match(doc, /设置 › 学习库与模型/, `${file}: names the page that shows the state`);
    assert.match(doc, /模型已连接/, `${file}: names the word the learner looks for`);
  }
  for (const file of ['docs/install.md', 'README.md']) {
    const doc = read(file);
    assert.doesNotMatch(doc, /shows (?:a setup card with|\*\*Open model settings\*\*)|\*\*Open model settings\*\* wherever/, `${file}: the button is not always there`);
    assert.match(doc, /Settings › Library & model/, `${file}: names the page that shows the state`);
    assert.match(doc, /Model connected/, `${file}: names the word the learner looks for`);
  }
});
