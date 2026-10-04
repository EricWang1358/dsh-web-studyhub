import test from 'node:test';
import { warmSettingsPanes } from './helpers/settings-panes.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildReport } from '../lib/usage-report.js';

/* Settings › Advanced › Usage frequency record: the privacy contract is on the screen before the switch, there is one clear state for
   each of "off", "on, nothing yet", "on with data", "paused" and "off with data", the report speaks plain words, bars have text, and
   English has no Han outside the names the learner's own data brought (the key of an unregistered control is named by the page). */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { UsageSettingsView, usageRowName, usagePrivacyPoints } from './ui/UsageSettings.jsx';
  export { default as Settings } from './ui/Settings.jsx';
  export { SETTINGS_GROUPS } from './ui/settings-groups.js';
  export { setUiLanguage, ENGLISH_SOURCES } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { UsageSettingsView, usageRowName, usagePrivacyPoints, Settings, SETTINGS_GROUPS, setUiLanguage, ENGLISH_SOURCES } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const noop = () => {};
await warmSettingsPanes(Settings);
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

const TODAY = '2026-10-03', DAY = 86400000;
const at = back => { const d = new Date(new Date(`${TODAY}T12:00:00`).getTime() - back * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const cell = days => { const entries = Object.entries(days); return { first: at(Math.max(...entries.map(([b]) => Number(b)))), last: at(Math.min(...entries.map(([b]) => Number(b)))), older: 0, total: Object.values(days).reduce((a, b) => a + b, 0), days: Object.fromEntries(entries.map(([b, n]) => [at(Number(b)), n])) }; };
const state = { version: 1, enabled: true, paused: false, since: at(30), areas: { library: { total: 60, older: 0, days: { [at(0)]: 60 } }, settings: { total: 9, older: 0, days: { [at(0)]: 9 } } }, controls: {
  'nav.library': cell({ 0: 20, 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 20 }), 'nav.sources': cell({ 0: 6, 1: 6, 2: 6, 3: 6, 4: 6, 5: 6 }), 'nav.exam': cell({ 40: 2 }), 'library/button/保存复习设置': cell({ 0: 4 }) } };
const report = language => buildReport(state, { period: 30, today: TODAY, language });

const base = { status: { enabled: false, paused: false, hasData: false, daysWithData: 0, since: '', file: 'usage-frequency.json', limits: { keys: 800, days: 180 } }, report: null, period: 30, busy: false, error: '', confirming: false,
  onSwitch: noop, onPause: noop, onPeriod: noop, onExport: noop, onCopy: noop, onAskClear: noop, onCancelClear: noop, onClear: noop };
const view = (patch = {}, language = 'zh') => render(h(UsageSettingsView, { ...base, ...patch, report: patch.report === undefined ? base.report : patch.report }), language);
const withData = (language, extra = {}) => ({ status: { ...base.status, enabled: true, hasData: true, daysWithData: 8, since: at(30) }, report: report(language), ...extra });

test('the privacy contract is spelled out before the switch, in plain words, in both languages', () => {
  const zh = usagePrivacyPoints().join('\n');
  for (const needle of [/记录.*哪些控件.*多少次/s, /不记录.*输入.*读.*答/s, /只保存在这台电脑/, /随时.*查看.*导出.*暂停.*删除/s, /不会.*发送/]) assert.match(zh, needle);
  setUiLanguage('en');
  const en = usagePrivacyPoints().join('\n');
  setUiLanguage('zh');
  assert.ok(!han.test(en), en);
  for (const needle of [/which controls you use and how often/i, /never what you typed, read or answered/i, /file, course or source name/i, /stays on this computer/i, /view, export, pause and delete/i, /never sent anywhere/i]) assert.match(en, needle);
  const html = view();
  assert.ok(html.indexOf('只保存在这台电脑') < html.indexOf('type="checkbox"'), 'the contract comes before the switch');
});

test('off with nothing recorded: one switch, unchecked, the contract, and no report at all', () => {
  const html = view();
  assert.match(html, /<fieldset[^>]*class="[^"]*usage-settings[^"]*"/);
  assert.match(html, /data-usage-ignore/);
  assert.match(html, /data-tour="settings-usage"/);
  assert.match(html, /data-state="off"/);
  assert.match(html, /<legend[^>]*>使用频率记录<\/legend>/);
  assert.match(html, /<input[^>]*type="checkbox"(?![^>]*checked)[^>]*name="usage-frequency"|<input[^>]*name="usage-frequency"[^>]*type="checkbox"(?![^>]*checked)/);
  assert.match(html, /已关闭[^<]*什么都没有记录|什么都没有记录/);
  assert.doesNotMatch(html, /我的使用报告/);
  assert.doesNotMatch(html, /暂停记录|继续记录|删除全部记录/);
});

test('on, nothing recorded yet: says so plainly and offers pause; still no report', () => {
  const html = view({ status: { ...base.status, enabled: true } });
  assert.match(html, /data-state="empty"/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(html, /正在记录/);
  assert.match(html, /还没有记录/);
  assert.match(html, /暂停记录/);
  assert.doesNotMatch(html, /我的使用报告/);
  const en = view({ status: { ...base.status, enabled: true } }, 'en');
  assert.match(en, /Recording/);
  assert.match(en, /Nothing recorded yet/);
  assert.ok(!han.test(en));
});

test('on with data: the report is there, folded until opened, with a period selector, the summary and the ranked list with bars that have text', () => {
  const html = view(withData('zh'));
  assert.match(html, /data-state="on"/);
  assert.match(html, /<details[^>]*class="[^"]*usage-report[^"]*"(?![^>]*\bopen\b)/, 'collapsed by default');
  assert.match(html, /<summary[^>]*>[^]*我的使用报告/);
  for (const period of ['最近 7 天', '最近 30 天', '全部时间']) assert.match(html, new RegExp(period));
  assert.match(html, /aria-pressed="true"[^>]*>最近 30 天|最近 30 天[^<]*<\/button>/);
  assert.match(html, /有记录的天数/);
  assert.match(html, /互动次数/);
  assert.match(html, /用过的控件/);
  assert.match(html, /最常用的控件/);
  // ranked rows: plain name, the count and the share as text, and a decorative bar
  assert.match(html, /<li[^>]*class="[^"]*usage-rank__row[^"]*"[^]*?学习库[^]*?140[^]*?<span[^>]*class="[^"]*usage-meter[^"]*"[^>]*aria-hidden="true"/);
  assert.match(html, /\d+(\.\d)?%/);
  assert.match(html, /按页面/);
  assert.match(html, /按使用时机/);
  assert.match(html, /每天/);
  assert.match(html, /每天的节奏/);
  assert.match(html, /从没用过的功能/);
  assert.match(html, /小提示/);
  assert.match(html, /可以不管/, 'every observation says it is optional');
  for (const action of ['导出 Markdown', '导出 JSON', '复制报告', '暂停记录', '删除全部记录']) assert.match(html, new RegExp(action));
});

test('the daily rhythm and every bar carry their numbers as text, not only as colour or height', () => {
  const html = view(withData('zh'));
  const rhythm = html.match(/<ol[^>]*class="[^"]*usage-rhythm[^"]*"[\s\S]*?<\/ol>/)?.[0] || '';
  assert.ok(rhythm.length > 0);
  assert.equal((rhythm.match(/<li/g) || []).length, 30);
  assert.match(rhythm, /<span class="sr-only">2026-10-03[^<]*140?[^<]*<\/span>|2026-10-03[^<]*\d/);
  for (const row of html.match(/<li[^>]*usage-rank__row[\s\S]*?<\/li>/g) || []) assert.match(row, /\d+<|\d+ [^<]*|\d+%/, 'each ranked row has numbers in text');
});

test('unregistered controls are named by the page from their key, in the page language, with no key text shown raw', () => {
  const key = 'library/button/保存复习设置';
  assert.equal(usageRowName({ key, name: null, registered: false }, 'zh'), '学习库 · 按钮 · 保存复习设置');
  const en = usageRowName({ key, name: null, registered: false }, 'en');
  assert.ok(!han.test(en), en);
  assert.match(en, /Study library/);
  assert.match(en, /button/i);
  assert.match(en, /Save review settings/);
  assert.equal(usageRowName({ key: 'settings/button', name: null, registered: false }, 'en'), 'Settings · a button without a name');
  assert.equal(usageRowName({ key: 'other', name: null, registered: false }, 'en'), 'Everything else (folded together)');
  assert.equal(usageRowName({ key: 'nav.library', name: 'Study library', registered: true }, 'en'), 'Study library');
  assert.equal(usageRowName({ key: 'tour.generate-submit', name: null, registered: false }, 'en'), 'tour.generate-submit', 'a developer hook is shown as it is');
});

test('paused with no data: resume remains available and no report waits forever', () => {
  const html = view({ status: { ...base.status, enabled: true, paused: true } });
  assert.match(html, /继续记录/);
  assert.doesNotMatch(html, /我的使用报告|正在整理报告/);
  assert.doesNotMatch(view({ status: { ...base.status, enabled: true, paused: true } }, 'en'), /My usage report|Preparing the report/);
});

test('paused: no recording, says so, and offers to resume; the report stays', () => {
  const html = view(withData('zh', { status: { ...base.status, enabled: true, paused: true, hasData: true, daysWithData: 8, since: at(30) } }));
  assert.match(html, /data-state="paused"/);
  assert.match(html, /已暂停/);
  assert.match(html, /继续记录/);
  assert.doesNotMatch(html, /暂停记录/);
  assert.match(html, /我的使用报告/);
});

test('off but with data from before: the report, export and delete are still there and it says recording is off', () => {
  const html = view(withData('zh', { status: { ...base.status, enabled: false, hasData: true, daysWithData: 8 } }));
  assert.match(html, /data-state="off-data"/);
  assert.match(html, /已关闭/);
  assert.match(html, /我的使用报告/);
  assert.match(html, /删除全部记录/);
  assert.doesNotMatch(html, /暂停记录|继续记录/);
});

test('deleting everything asks first: the confirmation says what goes and that the switch stays as it is', () => {
  const html = view({ ...withData('zh'), confirming: true });
  assert.match(html, /<dialog/);
  assert.match(html, /删除全部使用记录？/);
  assert.match(html, /不会影响学习库|不影响学习库/);
  assert.match(html, /取消/);
  const en = view({ ...withData('en'), confirming: true }, 'en');
  assert.match(en, /Delete all usage records\?/);
  assert.match(en, /Cancel/);
  assert.ok(!han.test(en.replace(/<dialog[\s\S]*?<\/dialog>/, m => m)), 'no Han in the dialog');
});

test('English is complete: every state and the whole report read without Han (the unregistered rows are named in English too)', () => {
  const states = [view({}, 'en'), view({ status: { ...base.status, enabled: true } }, 'en'), view(withData('en'), 'en'),
    view(withData('en', { status: { ...base.status, enabled: true, paused: true, hasData: true, daysWithData: 8 } }), 'en'), view(withData('en', { status: { ...base.status, enabled: false, hasData: true, daysWithData: 8 } }), 'en'),
    view({ ...withData('en'), confirming: true }, 'en'), view({ ...withData('en'), error: 'Could not read the record' }, 'en')];
  for (const html of states) assert.ok(!han.test(html.replace(/data-[a-z-]+="[^"]*"/g, '')), html.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]);
  const html = states[2];
  assert.match(html, /My usage report/);
  assert.match(html, /Last 7 days/);
  assert.match(html, /Most used controls/);
  assert.match(html, /Never used/i);
  assert.match(html, /Study library/);
  assert.match(html, /optional/i);
});

test('every new UI sentence has an English entry in the fragment, and the fragment is registered', () => {
  assert.ok(Object.keys(ENGLISH_SOURCES).includes('en.frequency.json'));
  const fragment = ENGLISH_SOURCES['en.frequency.json'];
  for (const key of ['使用频率记录', '我的使用报告', '删除全部使用记录？', '暂停记录', '继续记录']) assert.ok(fragment[key], key);
  for (const [key, value] of Object.entries(fragment)) { assert.ok(han.test(key), `${key}: the key is the Chinese source`); assert.ok(!han.test(value), `${key}: English without Han`); }
});

test('Settings › Advanced has a category for the usage record and one for the experimental switch, whether or not experimental features are shown; the group says so', () => {
  const advanced = SETTINGS_GROUPS.find(group => group.id === 'advanced');
  assert.match(advanced.lead, /使用频率/);
  const props = { data: { sources: [], contexts: ['system'], settings: {}, root: '/tmp/lib', experimental: false }, busy: false, act: noop, call: async () => ({}), host: {}, setNotice: noop,
    settings: { first_interval_days: 1, second_interval_days: 6, initial_ease_factor: 2.5, minimum_ease_factor: 1.3 }, setSettings: noop, legacy: '', setLegacy: noop, workspacePanel: null, coursePanel: null, onboardingPanel: null, exportData: noop, onRestored: noop, initialProfile: { consent: false, goal: '', summary: '', signals: {} } };
  for (const experimental of [false, true]) {
    for (const [anchor, tour] of [['settings-usage', 'settings-usage'], ['settings-experimental', 'settings-experimental']]) {
      const html = render(h(Settings, { ...props, focusSection: anchor, data: { ...props.data, experimental } }));
      assert.match(html, new RegExp(`data-tour="${tour}"`), `experimental ${experimental}: ${anchor}`);
    }
  }
  const en = render(h(Settings, { ...props, focusSection: 'settings-usage' }), 'en');
  assert.match(en, /Usage frequency record/);
});

test('the section is quiet: no first-run banner, no badge on the sidebar, nothing added to the home page', async () => {
  const app = await readFile('ui/App.jsx', 'utf8');
  assert.ok(!/UsageSettings|usage\.frequency\.|usage-frequency\.json/.test(app), 'App only hosts the controller and the area marker: the section and the operations are Settings\'');
  assert.match(app, /createUsageController/);
  assert.match(app, /data-usage-area=\{page\}/);
  const css = await readFile('ui/usage.css', 'utf8');
  assert.ok(!/position:\s*(fixed|sticky)/.test(css), 'no floating widget');
  assert.ok(!/@keyframes|animation:/.test(css), 'no motion');
});
