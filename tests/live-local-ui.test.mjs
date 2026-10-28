import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 本地转写（声音不上传）in the UI: the local engine's card (ui/LiveLocalCard.jsx) in every state with exactly one primary button and Tooltips (never title=),
   the live class's setup gate (local first where it can run, Gemini where it cannot or was chosen), the per-class choice only where both engines can
   run, and Settings › 音频转写's engine choice. English shows no Chinese. */

const mod = await loadUi(`export { default as LiveLocalCard } from './ui/LiveLocalCard.jsx';
  export { LiveSetup, ProviderChoice, ResumeControl, Sentence } from './ui/LiveClass.jsx';
  export { LiveEngineChoice } from './ui/AudioSettings.jsx';
  export { installArgs, localCardState, localFix, localStageStates, localProgress, localFacts, localTip, LOCAL_STATUS } from './ui/live-local-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const { LiveLocalCard, LiveSetup, ProviderChoice, ResumeControl, Sentence, LiveEngineChoice, installArgs, localCardState, localFix, localStageStates, localProgress } = mod;
const h = React.createElement;
const han = /[㐀-鿿]/;
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const call = async () => ({});
const primaries = html => (html.match(/class="sh-btn sh-btn--primary/g) || []).length;

const FOLDER = 'D:\\StudyHub\\LiveLocal';
const base = { status: 'idle', stage: '', stages: ['engine', 'model', 'check'], done: [], step: 0, of: 3, folder: '', installedFolder: '', installed: false, ready: false,
  supported: true, tested: true, engineVersion: '1.13.8', downloadMb: 239, diskMb: 253, modelMb: 228, log: [], error: null };
const status = {
  missing: base,
  installing: { ...base, status: 'running', stage: 'model', step: 2, done: ['engine'], folder: FOLDER, stageFraction: 0.4 },
  paused: { ...base, status: 'cancelled', stage: 'model', step: 2, done: ['engine'], folder: FOLDER, error: { code: 'cancelled', message: '已暂停；已下载的部分保留，下次点「继续安装」接着装。' } },
  checksum: { ...base, status: 'failed', stage: 'model', step: 2, done: ['engine'], folder: FOLDER, error: { code: 'checksum', message: '下载的文件校验没有通过（可能下载不完整或被改动），已删除这个文件。' } },
  ready: { ...base, status: 'complete', stage: 'done', step: 3, done: ['engine', 'model', 'check'], folder: FOLDER, installedFolder: FOLDER, installed: true, ready: true },
  unsupported: { ...base, supported: false },
  // Installed once; a native file was quarantined afterwards (the backend reads it as not installed, needs repair).
  repair: { ...base, status: 'complete', stage: 'done', step: 3, done: ['engine', 'model', 'check'], folder: FOLDER, needsRepair: true },
};
const plan = { ok: true, problems: [], warnings: [], folder: FOLDER, defaultFolder: FOLDER, defaultReason: 'largest-data-drive', platform: 'win32', supported: true, tested: true,
  drives: [{ root: 'D:\\', freeMb: 100_000, totalMb: 500_000, system: false, recommended: true, folder: FOLDER }], disk: { freeMb: 100_000, neededMb: 600, drive: 'D:' },
  estimate: { downloadMb: 239, diskMb: 253 }, files: [] };
const render = (props, language = 'zh') => { mod.setUiLanguage(language); try { return renderToStaticMarkup(h(LiveLocalCard, { call, ...props })); } finally { mod.setUiLanguage('zh'); } };

test('the card state: checking, not installed, installing, paused, failed with its one fix, ready, unsupported', () => {
  assert.deepEqual(localCardState(null), { state: 'checking' });
  assert.equal(localCardState(status.missing).state, 'not-installed');
  assert.equal(localCardState(status.installing).state, 'installing');
  assert.deepEqual(localCardState(status.paused), { state: 'paused', code: 'cancelled' });
  assert.deepEqual(localCardState(status.checksum), { state: 'error', code: 'checksum' });
  assert.equal(localCardState(status.ready).state, 'ready');
  assert.equal(localCardState(status.unsupported).state, 'unsupported');
  assert.deepEqual(localCardState(status.repair), { state: 'repair' });
  assert.equal(localFix(undefined).id, 'repair');
  assert.equal(localFix('checksum').id, 'retry');
  assert.equal(localFix('cancelled').id, 'continue');
  assert.equal(localFix('no-space').id, 'relocate');
  assert.equal(localFix('vc-runtime').id, 'vc-runtime');
  assert.equal(localFix('check-failed').id, 'repair');
  assert.deepEqual(localStageStates(status.installing).map(item => item.state), ['done', 'active', 'pending']);
  assert.deepEqual(localStageStates(status.checksum).map(item => item.state), ['done', 'failed', 'pending']);
  assert.deepEqual(localProgress(status.installing), { value: 1.4, max: 3 });
});

test('every state renders with at most one primary button, a Tooltip for each explanation and no title attribute', () => {
  const cases = [['missing', status.missing, 1], ['installing', status.installing, 0], ['paused', status.paused, 1], ['checksum', status.checksum, 1], ['ready', status.ready, 0], ['unsupported', status.unsupported, 0], ['repair', status.repair, 1]];
  for (const [name, initialStatus, expected] of cases) {
    const html = render({ initialStatus, initialPlan: plan });
    assert.equal(primaries(html), expected, name);
    assert.doesNotMatch(html, / title="/, name);
    assert.match(html, /role="tooltip"/, `${name}: the explanation is a Tooltip`);
  }
  const offer = textOf(render({ initialStatus: status.missing, initialPlan: plan }));
  assert.match(offer, /不需要密钥 · 转写在这台电脑上进行/);
  assert.match(offer, /首次安装下载约 239 MB · 装好后占用约 253 MB/);
  assert.match(offer, /安装本地转写引擎/);
  assert.match(offer, /D:\\StudyHub\\LiveLocal/);
  assert.match(textOf(render({ initialStatus: status.installing })), /第 2\/3 步：下载识别模型/);
  assert.match(textOf(render({ initialStatus: status.paused, initialPlan: plan })), /继续安装/);
  assert.match(textOf(render({ initialStatus: status.checksum, initialPlan: plan })), /校验没有通过[\s\S]*重试/);
  assert.match(textOf(render({ initialStatus: status.ready })), /装在 D:\\StudyHub\\LiveLocal；转写在这台电脑上进行/);
  assert.doesNotMatch(render({ initialStatus: status.ready }), /删除本地转写引擎/, 'removing is in Settings only');
  assert.match(render({ initialStatus: status.ready, settings: true }), /删除本地转写引擎/);
});

test('English: no Chinese on the card in any state', () => {
  for (const initialStatus of Object.values(status)) {
    const html = render({ initialStatus, initialPlan: plan, settings: true }, 'en');
    assert.doesNotMatch(textOf(html), han, JSON.stringify(initialStatus.status));
  }
  assert.match(textOf(render({ initialStatus: status.missing, initialPlan: plan }, 'en')), /No key needed · transcription runs on this computer[\s\S]*The first install downloads about 239 MB · uses about 253 MB once installed/);
});

test('the live class gate: without a key the local engine comes first; Gemini where the computer has no local engine or the learner chose Gemini', () => {
  const html = renderToStaticMarkup(h(LiveSetup, { readiness: { live: false, liveReason: 'no-provider', liveLocal: { supported: true, ready: false } }, call, onSettings() {}, initialLocal: status.missing }));
  assert.match(textOf(html), /先装一个转写引擎/);
  assert.match(html, /live-local-card/);
  assert.match(textOf(html), /改用 Gemini 密钥/);
  const none = renderToStaticMarkup(h(LiveSetup, { readiness: { live: false, liveReason: 'no-provider', liveLocal: { supported: false, ready: false } }, call, onSettings() {} }));
  assert.doesNotMatch(none, /live-local-card/);
  assert.match(textOf(none), /课堂实录需要 Gemini 密钥/);
  const chose = renderToStaticMarkup(h(LiveSetup, { readiness: { live: false, liveReason: 'no-gemini-key', liveLocal: { supported: true, ready: true } }, call, onSettings() {} }));
  assert.match(textOf(chose), /你在音频设置里选了用 Gemini/);
});

test('the per-class choice appears only where both engines can run; a sentence the local engine wrote in Chinese has no 正在翻译 line', () => {
  const both = { providers: { free: true }, liveLocal: { ready: true } };
  assert.match(renderToStaticMarkup(h(ProviderChoice, { readiness: both, value: 'gemini', onChange() {} })), /本地转写（声音不上传）/);
  assert.equal(renderToStaticMarkup(h(ProviderChoice, { readiness: { providers: { free: true }, liveLocal: { ready: false } }, value: 'gemini', onChange() {} })), '');
  assert.equal(renderToStaticMarkup(h(ProviderChoice, { readiness: { providers: {}, liveLocal: { ready: true } }, value: 'local', onChange() {} })), '');
  const sentence = renderToStaticMarkup(h(Sentence, { segment: { id: 1, t: 0, en: '今天讲分区。', zh: '', zhState: 'none' }, selected: false, generated: false, checked: false, onToggle() {} }));
  assert.doesNotMatch(sentence, /正在翻译|live-chinese/);
  const pending = renderToStaticMarkup(h(Sentence, { segment: { id: 2, t: 0, en: 'Partitions.', zh: '', zhState: 'pending' }, selected: false, generated: false, checked: false, onToggle() {} }));
  assert.match(pending, /正在翻译/);
});

test('Settings › 音频转写: auto, local or Gemini for live classes, with the local engine card under it', () => {
  const html = renderToStaticMarkup(h(LiveEngineChoice, { view: { liveProvider: 'auto' }, call, onSave() {}, initialLocal: status.ready }));
  const text = textOf(html);
  assert.match(text, /课堂实录的转写/);
  assert.match(text, /自动（推荐）[\s\S]*本地转写（声音不上传）[\s\S]*Gemini（云端）/);
  assert.match(html, /live-local-card/);
  assert.match(html, /删除本地转写引擎/);
});

test('a damaged engine reads 需要修复 with 修复 as its one button, in 课堂实录 and in Settings (where it can also be removed)', () => {
  const html = textOf(render({ initialStatus: status.repair }));
  assert.match(html, /需要修复/);
  assert.match(html, /文件不完整或被改动/);
  assert.match(html, /修复/);
  assert.doesNotMatch(html, /可以用了/);
  assert.match(textOf(render({ initialStatus: status.repair, settings: true })), /修复[\s\S]*删除本地转写引擎/);
  assert.doesNotMatch(textOf(render({ initialStatus: status.repair }, 'en')), han);
});

test('moving to another folder sends removePrevious; installing where it already is does not', () => {
  assert.deepEqual(installArgs({ location: 'E:\StudyHub\LiveLocal', current: FOLDER }), { confirm: true, location: 'E:\StudyHub\LiveLocal', removePrevious: true });
  assert.deepEqual(installArgs({ location: FOLDER, current: FOLDER }), { confirm: true, location: FOLDER });
  assert.deepEqual(installArgs({ location: FOLDER.toLowerCase(), current: FOLDER }), { confirm: true, location: FOLDER.toLowerCase() });
  assert.deepEqual(installArgs({ location: FOLDER }), { confirm: true, location: FOLDER }, 'a first install has nothing to remove');
});

test('接着录 keeps the engine of the class; when it cannot run it says so and offers the other engine, never a silent switch', () => {
  const both = { live: true, providers: { free: true }, liveLocal: { supported: true, ready: true } };
  const asked = [];
  const tree = ResumeControl({ session: { engine: 'local' }, readiness: both, onResume: value => asked.push(value) });
  tree.props.onClick();
  assert.deepEqual(asked, ['local'], 'a local class resumes on local even with a Gemini key');
  const gone = renderToStaticMarkup(h(ResumeControl, { session: { engine: 'local' }, readiness: { ...both, liveLocal: { supported: true, ready: false } }, onResume() {} }));
  assert.match(textOf(gone), /这堂课是用本地转写录的，本地转写现在用不了/);
  assert.match(textOf(gone), /用 Gemini 接着录/);
  assert.doesNotMatch(textOf(gone), /^\s*接着录\s*$/);
  const noKey = renderToStaticMarkup(h(ResumeControl, { session: {}, readiness: { live: true, providers: {}, liveLocal: { supported: true, ready: true } }, onResume() {} }));
  assert.match(textOf(noKey), /这堂课是用 Gemini 录的，现在没有 Gemini 密钥[\s\S]*用本地转写接着录/, 'a class saved before the local engine was Gemini');
  mod.setUiLanguage('en');
  try { assert.doesNotMatch(textOf(renderToStaticMarkup(h(ResumeControl, { session: { engine: 'local' }, readiness: { ...both, liveLocal: { supported: true, ready: false } }, onResume() {} }))), han); }
  finally { mod.setUiLanguage('zh'); }
});
