import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* Hidden by default, guided when shown. A learner who never opens Settings › Advanced › Experimental features must never see that Jev exists:
   with `data.experimental` off, every surface that once drew something Jev draws exactly what a build without Jev would draw (no Jev text,
   no jev- class, no data-experimental, no aria), in both languages. Turned on, the experimental block is one guided flow in this order:
   (a) what Jev could replace (a walk-through), (b) the provider and its key, (c) the per-site switches, which turn ON at once or say what is missing. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as Settings } from './ui/Settings.jsx';
  export { CourseList } from './ui/CourseSettings.jsx';
  export { OnboardingPanel } from './ui/tour/SampleControls.jsx';
  export { default as Sources } from './ui/Sources.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { JevSettingsView, JevGuide, JevReplaceList } from './ui/JevSettings.jsx';
  export { JevRunNote, JevDecidedBadge } from './ui/JevOrganize.jsx';
  export { JevDecidedNote } from './ui/JevBadge.jsx';
  export { experimentalShown } from './ui/experimental-flag.js';
  export { JEV_REPLACE_META, setupStep, providerChoices, privacyPoints } from './ui/jev-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Settings, CourseList, OnboardingPanel, Sources, Draft, JevSettingsView, JevGuide, JevReplaceList, JevRunNote, JevDecidedBadge, JevDecidedNote,
  experimentalShown, JEV_REPLACE_META, setupStep, privacyPoints, providerChoices, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const noop = () => {};
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const JEV_TRACE = /Jev|jev-|settings-jev|data-experimental|jev\./;

const defaults = { first_interval_days: 1, second_interval_days: 6, initial_ease_factor: 2.5, minimum_ease_factor: 1.3 };
const data = (extra = {}) => ({ root: 'D:\\Study\\library', settings: { ...defaults }, sources: [], decks: [], drafts: [], courses: [], jobs: [], model: { ready: true }, modelReady: true,
  focus: { mode: 'class', course: 'A', courses: [{ name: 'A' }] }, ...extra });
const settingsPage = (extra = {}, props = {}) => h(Settings, { data: data(extra), busy: false, act: noop, call: noop, setNotice: noop, settings: { ...defaults }, setSettings: noop,
  legacy: '', setLegacy: noop, workspacePanel: h('div', { className: 'binding-panel' }, 'library'), exportData: noop, onRestored: noop, coursePanel: h(CourseList, { courses: [] }),
  onboardingPanel: h(OnboardingPanel, { sample: null, onTour: noop }), initialProfile: { consent: true, goal: 'exam', summary: '', signals: {}, ready: 0 }, tourActive: true, ...props });

const PROVIDERS = [{ id: 'typesafe', model: 'jev-latest', host: 'api.typesafe.ai', family: 'typesafe', defaultKeyEnv: 'JEV_API_KEY' },
  { id: 'opencode-zen-free', model: 'jev-1.13-free', host: 'opencode.ai', family: 'opencode', defaultKeyEnv: 'OPENCODE_GO_API_KEY_2' },
  { id: 'opencode-zen', model: 'jev-1.13', host: 'opencode.ai', family: 'opencode', defaultKeyEnv: 'OPENCODE_GO_API_KEY_2' },
  { id: 'custom', model: '', host: '', family: 'custom', defaultKeyEnv: 'JEV_CUSTOM_API_KEY' }];
const jevSettings = (extra = {}) => ({ provider: 'typesafe', providers: PROVIDERS, key: { set: false, hint: '', source: '', envName: 'JEV_API_KEY', envFound: false }, keyEnv: '', keyEnvDefault: 'JEV_API_KEY',
  custom: { endpoint: '', model: '', host: '' }, confirmed: false, confirmedAt: '', enabled: false, features: { courseSuggest: false, preReview: false, outlineNoise: false, levelCheck: false },
  replace: { cardReview: false, courseOrganize: false }, threshold: 0.8, privacyUrl: 'https://docs.typesafe.ai/legal', docsUrl: 'https://docs.typesafe.ai', settingsFile: 'C:\\Users\\a\\.dsh\\study\\jev.json', ...extra });
const ready = jevSettings({ key: { set: true, hint: '••••ABCD', source: 'file', envName: 'JEV_API_KEY', envFound: false }, confirmed: true, confirmedAt: '2026-10-03T00:00:00.000Z' });
const view = (settings, extra = {}) => h(JevSettingsView, { settings, usage: null, failure: null, busy: false, working: '', result: null, error: '', onKey: noop, onVerify: noop, onClearKey: noop, onConfirm: noop,
  onEnabled: noop, onFeature: noop, onThreshold: noop, onProvider: noop, onKeyEnv: noop, onReplace: noop, onCustom: noop, onGoto: noop, ...extra });

/* ---- the one switch -------------------------------------------------------------------------------------------------- */

test('experimental features are shown only for a literal true on the snapshot', () => {
  assert.equal(experimentalShown({ experimental: true }), true);
  for (const value of [undefined, false, 'true', 1, null]) assert.equal(experimentalShown({ experimental: value }), false);
  assert.equal(experimentalShown(undefined), false);
});

test('Settings › Advanced holds a single switch, off by default, with one line saying what turning it off does', () => {
  const zh = render(settingsPage());
  assert.match(zh, /data-settings-group="advanced"/);
  assert.match(zh, /<summary[^>]*>[^]*?高级/);
  assert.match(zh, /<legend[^>]*>实验性功能<\\?\/legend>|实验性功能/);
  assert.match(zh, /<input[^>]*name="show-experimental"[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*name="show-experimental"/);
  assert.doesNotMatch(zh.match(/<input[^>]*name="show-experimental"[^>]*>/)?.[0] ?? '', /checked/);
  assert.match(zh, /显示实验性功能/);
  assert.match(zh, /关掉后[^<]*隐藏[^<]*停止/);
  const en = render(settingsPage(), 'en');
  assert.match(en, /Show experimental features/);
  assert.match(en, /Advanced/);
  assert.ok(!han.test(en.replace(/C:\\Users[^<]*/g, '')), en.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]);
  const on = render(settingsPage({ experimental: true }));
  assert.match(on.match(/<input[^>]*name="show-experimental"[^>]*>/)?.[0] ?? '', /checked/);
});

/* ---- hidden: identical to a build without Jev -------------------------------------------------------------------------- */

test('Settings with the switch off draws no Jev at all, in either language (the one-time group, the advanced group, the tour anchors included)', () => {
  for (const language of ['zh', 'en']) for (const experimental of [undefined, false]) {
    const html = render(settingsPage({ experimental }), language);
    assert.doesNotMatch(html, JEV_TRACE, `${language}/${experimental}`);
    assert.doesNotMatch(html, /正在读取 Jev|Reading the Jev/);
  }
});

test('Settings with the switch on draws the experimental block in the Advanced group, and only there', () => {
  const html = render(settingsPage({ experimental: true }));
  const advanced = html.split(/<details class="settings-group"/).find(part => /data-settings-group="advanced"/.test(part)) ?? '';
  assert.match(advanced, /data-tour="settings-jev"/);
  assert.match(html.split(/<details class="settings-group"/).filter(part => !/data-settings-group="advanced"/.test(part)).join(''), /^(?![^]*jev-)[^]*$/, 'no Jev in the other groups');
});

test('the organizer and the draft draw no Jev with the switch off, even for a library that holds Jev traces (a draft decided by Jev, pre-check signals)', () => {
  const sources = [{ id: 'a', title: 'Database notes', text: 'Transactions keep changes consistent.', courses: ['Databases'], createdAt: '2026-09-30' }];
  const card = { id: 'c1', kind: 'flashcard', topic: 't', objective: 'o', prompt: 'Why isolate transactions?', answer: 'a', explanation: 'e', citations: [{ sourceId: 'a', quote: 'Transactions keep changes consistent.' }] };
  const draft = { id: 'd', title: 'Draft', draftVersion: 1, cards: [card], editorial: { reviewedCards: {}, summary: 'Approved 1 questions in one review round (1 of the reviewed candidates judged by an experimental decision service, 0 by the independent model review); 0 candidates omitted.',
    jev: { version: 1, threshold: 0.8, signals: { c1: { checks: { stemLeaksAnswer: { p: 0.1, failure: 0.1, failed: false } }, flagged: false, failures: [] } } },
    jevDecided: { version: 1, site: 'cardReview', threshold: 0.8, language: 'zh', judged: 1, model: 0, accepted: 1, rejected: 0, cards: { c1: { verdict: 'accept', confidence: 0.95 } }, fallback: null } } };
  const props = { busy: false, act: noop, call: noop, draftLoaded: true, setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false, setJsonMode: noop, openDraft: noop, continueDraft: noop,
    onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setNotice: noop, setError: noop, setModal: noop, setSelectedSources: noop, setGenSource: noop,
    blankCard: () => ({}), patchCard: noop, parseDraft: noop, draft };
  for (const language of ['zh', 'en']) {
    const off = { data: { ...data(), sources, drafts: [draft], decks: [], focus: { course: 'Databases', courses: [{ name: 'Databases' }] } }, ...props };
    const organizer = render(h(Sources, { data: off.data, act: noop, setModal: noop }), language);
    assert.doesNotMatch(organizer, JEV_TRACE, `organizer ${language}`);
    const html = render(h(Draft, off), language);
    assert.doesNotMatch(html, JEV_TRACE, `draft ${language}`);
    // The same draft with the switch on shows what Jev decided.
    const on = render(h(Draft, { ...off, data: { ...off.data, experimental: true } }), language);
    assert.match(on, /Jev/);
    assert.match(on, /data-jev-decided/);
    if (language === 'en') assert.ok(!han.test(on), on.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]);
  }
});

test('the pieces that mark Jev’s decisions are experimental-labelled and plain in both languages', () => {
  const decided = { version: 1, site: 'cardReview', threshold: 0.8, language: 'zh', judged: 5, model: 2, accepted: 4, rejected: 1, cards: {}, fallback: { reason: 'low-confidence', count: 2, message: 'Jev was less sure than your 80% line about 2 item(s), so the usual model judged them.' } };
  const zh = render(h(JevDecidedNote, { decided }));
  assert.match(zh, /Jev（实验性）判定了 5 题/);
  assert.match(zh, /通过 4/);
  assert.match(zh, /其余 2 题由独立模型复审/);
  assert.match(zh, /less sure than your 80% line/, 'the one fallback notice of the run');
  const en = render(h(JevDecidedNote, { decided }), 'en');
  assert.match(en, /Jev \(experimental\) judged 5/);
  assert.ok(!han.test(en));
  assert.equal(render(h(JevDecidedNote, { decided: { ...decided, judged: 0 } })), '', 'nothing to say when Jev decided nothing');
  assert.match(render(h(JevDecidedBadge, {})), /由 Jev 判定/);
  assert.match(render(h(JevDecidedBadge, {}), 'en'), /Decided by Jev/);
  assert.match(render(h(JevRunNote, { jev: { enabled: true, jev: 2, model: 2, fallback: { reason: 'low-confidence', count: 2, message: 'two went to the model' } } })), /Jev（实验性）给出了 2 条建议，其余 2 条由模型给出/);
  assert.equal(render(h(JevRunNote, { jev: undefined })), '');
  assert.equal(render(h(JevRunNote, { jev: { enabled: false, jev: 0, model: 3, fallback: null } })), '', 'a switched-off site leaves no note');
});

/* ---- the guided flow --------------------------------------------------------------------------------------------------- */

test('the guided block runs in this order: the walk-through, the provider and its key, the per-site switches', () => {
  const html = render(view(ready));
  const at = pattern => html.search(pattern);
  assert.ok(at(/jev-guide/) >= 0 && at(/name="jev-provider"/) > at(/jev-guide/), 'guide before provider');
  assert.ok(at(/name="jev-key"/) > at(/name="jev-provider"/), 'provider before key');
  assert.ok(at(/class="jev-replace"|class="[^"]*jev-replace[^"]*"/) > at(/name="jev-key"/), 'key before the switches');
  assert.ok(at(/jev-switches/) > at(/jev-replace/), 'the master switch sits with the switches');
});

test('the walk-through goes site by site with next/back/skip, says what is replaced and the trade-off, and shows nowhere else', () => {
  assert.deepEqual(JEV_REPLACE_META.map(item => item.id), ['cardReview', 'courseOrganize']);
  const first = render(h(JevGuide, { initialStep: 0 }));
  assert.match(first, /Jev 可以替换哪些调用/);
  assert.match(first, /1 \/ 2/);
  assert.match(first, /出题后的独立复审/);
  assert.match(first, /现在/);
  assert.match(first, /用 Jev/);
  assert.match(first, /更快、更省，但准确度可能下降/);
  assert.match(first, /实验性/);
  assert.match(first, /下一个/);
  assert.match(first, /跳过/);
  assert.match(first, /<button[^>]*disabled=""[^>]*>[^<]*上一个/, 'no "back" on the first step');
  const second = render(h(JevGuide, { initialStep: 1 }));
  assert.match(second, /2 \/ 2/);
  assert.match(second, /课程归属建议/);
  assert.match(second, /<button[^>]*>[^<]*上一个/);
  assert.match(second, /完成|知道了/);
  const en = render(h(JevGuide, { initialStep: 0 }), 'en');
  assert.match(en, /What Jev could replace/);
  assert.match(en, /faster and cheaper, but accuracy may drop/i);
  assert.match(en, /Experimental/);
  assert.ok(!han.test(en), en.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]);
  const done = render(h(JevGuide, { initialStep: -1 }));
  assert.doesNotMatch(done, /1 \/ 2/, 'a skipped walk-through folds to one line');
  assert.match(done, /再看一遍/);
});

test('each replaceable site is a plain switch: what it does, what it replaces, the expected trade-off, off by default', () => {
  const html = render(view(ready));
  for (const site of ['cardReview', 'courseOrganize']) {
    const at = html.indexOf(`data-replace="${site}"`);
    assert.ok(at > 0, site);
    const row = html.slice(at, at + 1400);
    assert.match(row, /type="checkbox"/);
    assert.doesNotMatch(row.slice(0, row.indexOf('</label>')), /checked/, `${site} starts off`);
    assert.match(row, /替换：/);
    assert.match(row, /预期：更快、更省，但准确度可能下降/);
  }
  assert.match(html, /默认全部关闭/);
  assert.match(html, /node scripts\/eval-jev\.mjs/, 'the “compare on my data” pointer');
  const on = render(view({ ...ready, enabled: true, replace: { cardReview: true, courseOrganize: false } }));
  assert.match(on, /data-replace="cardReview"[^>]*><input[^>]*type="checkbox"[^>]*checked=""/);
  const en = render(view(ready), 'en');
  assert.match(en, /Replaces: /);
  assert.match(en, /Expected: faster and cheaper, but accuracy may drop/);
  assert.match(en, /node scripts\/eval-jev\.mjs/);
  assert.ok(!han.test(en.replace(/C:\\Users[^<]*/g, '')), en.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]);
});

test('a switch that cannot work yet says what is missing and offers the step instead of silently staying off', () => {
  for (const [settings, step, pattern] of [[jevSettings(), 'key', /还没有可用的密钥/], [jevSettings({ key: ready.key }), 'confirm', /还没有确认隐私说明/],
    [jevSettings({ provider: 'custom' }), 'endpoint', /自定义端点还没有填写完整/]]) {
    assert.equal(setupStep(settings), step);
    const html = render(h(JevReplaceList, { settings, onToggle: noop, onGoto: noop }));
    assert.match(html, /jev-prereq/);
    assert.match(html, pattern);
    assert.match(html, /<button[^>]*data-goto="[a-z]+"/, 'a button for the step');
  }
  assert.doesNotMatch(render(h(JevReplaceList, { settings: ready, onToggle: noop, onGoto: noop })), /jev-prereq/, 'nothing missing, nothing said');
  const blocked = render(h(JevReplaceList, { settings: jevSettings(), onToggle: noop, onGoto: noop, initialBlocked: 'cardReview' }));
  assert.match(blocked, /role="alert"/);
  assert.match(blocked, /先完成/);
  const en = render(h(JevReplaceList, { settings: jevSettings(), onToggle: noop, onGoto: noop, initialBlocked: 'cardReview' }), 'en');
  assert.match(en, /No key is available yet/);
  assert.ok(!han.test(en), en.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]);
});

test('the walk-through names the replaced calls, the trade-off and the fallback, and never recommends or implies Jev will become the default', () => {
  const all = JEV_REPLACE_META.map(item => [item.label(), item.hint(), item.replaces(), item.instead()].join('\n')).join('\n');
  assert.doesNotMatch(all, /推荐|默认使用|稳定后|目前|暂时|for now|recommended|until stable|will become|default/i);
  const html = render(view(ready));
  assert.doesNotMatch(html.replace(/默认全部关闭|默认 80%|默认读取|不推荐/g, ''), /推荐|稳定后|for now|will become/i);
  assert.match(html, /出错、被限流或不确定时，自动改用原来的模型，并且只提示一次/);
  assert.match(html, /实验性/);
});

test('the providers note says several exist, lists the facts and marks the unverified ones, and recommends none', () => {
  const html = render(view(ready));
  assert.match(html, /Jev 有多个服务商可以配置/);
  assert.match(html, /OpenCode Zen/);
  assert.match(html, /jev-1\.13-free/);
  assert.match(html, /OpenRouter、AIML、Netlify AI Gateway/);
  assert.match(html, /未验证/);
  assert.match(html, /保留[^。]*没有说明|没有说明[^。]*保留/);
  assert.doesNotMatch(html, /建议使用|推荐使用/);
  const en = render(view(ready), 'en');
  assert.match(en, /several providers/i);
  assert.match(en, /OpenRouter, AIML and Netlify AI Gateway/);
  assert.match(en, /unverified/i);
  assert.ok(!han.test(en.replace(/C:\\Users[^<]*/g, '')), en.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]);
});

test('the custom endpoint asks for an address, a model id and a key variable name, and its privacy note names the address and says nothing is known', () => {
  const settings = jevSettings({ provider: 'custom', custom: { endpoint: 'https://gateway.example.com/v1/systemone', model: 'jev-x', host: 'gateway.example.com' },
    key: { set: false, hint: '', source: '', envName: 'JEV_CUSTOM_API_KEY', envFound: false }, keyEnvDefault: 'JEV_CUSTOM_API_KEY' });
  const html = render(view(settings));
  assert.match(html, /name="jev-custom-endpoint"[^>]*value="https:\/\/gateway\.example\.com\/v1\/systemone"|value="https:\/\/gateway\.example\.com\/v1\/systemone"[^>]*name="jev-custom-endpoint"/);
  assert.match(html, /name="jev-custom-model"/);
  assert.match(html, /JEV_CUSTOM_API_KEY（未找到）/);
  assert.match(html, /gateway\.example\.com/);
  setUiLanguage('zh');
  const zh = privacyPoints('custom', { host: 'gateway.example.com' }).join('\n');
  assert.match(zh, /gateway\.example\.com/);
  assert.match(zh, /不知道/);
  assert.match(zh, /未验证/);
  setUiLanguage('en');
  const en = privacyPoints('custom', { host: 'gateway.example.com' }).join('\n');
  setUiLanguage('zh');
  assert.ok(!han.test(en), en);
  assert.match(en, /unverified/i);
  assert.deepEqual(providerChoices().map(choice => choice.id), ['typesafe', 'opencode-zen-free', 'opencode-zen', 'custom']);
});
