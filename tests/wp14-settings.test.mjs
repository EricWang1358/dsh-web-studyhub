/* WP14 · Settings, from the owner's first real use: one left edge and one
   section-header style for every section, aligned transcription provider
   cards, a 陪学 section that says what the profile changes, a compact SM-2
   form with a live schedule preview, and a guided backup / restore. */
import test from 'node:test';
import { warmSettingsPanes } from './helpers/settings-panes.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { schedule, initialReview, defaults } from '../lib/domain.js';
import { inApp } from './helpers/fake-app.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as Settings } from './ui/Settings.jsx';
  export { CoachSection, coachActions } from './ui/settings/CoachSection.jsx';
  export { ScheduleSection } from './ui/settings/ScheduleSection.jsx';
  export { BackupSection, RestorePreview, backupSummary, backupFileName } from './ui/settings/BackupSection.jsx';
  export { default as AudioSettings, ProviderKeyForm, PROVIDERS } from './ui/AudioSettings.jsx';
  export { CourseList } from './ui/CourseSettings.jsx';
  export { OnboardingPanel } from './ui/tour/SampleControls.jsx';
  export { previewSchedule } from './lib/sm2.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Settings, CoachSection, coachActions, ScheduleSection, BackupSection, RestorePreview, backupSummary, backupFileName, AudioSettings, ProviderKeyForm, PROVIDERS,
  previewSchedule, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const h = React.createElement;
const noop = () => {};
await warmSettingsPanes(Settings);
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

const view = {
  freeKey: { set: false, hint: '' }, paidKey: { set: false, hint: '' }, groqKey: { set: false, hint: '' }, siliconflowKey: { set: true, hint: '••••mtzj' },
  settingsFile: 'C:\\Users\\me\\.dsh\\study\\audio.json', textProvider: 'auto', mode: 'SMART', partMinutes: 59, textConcurrency: 3,
  proofreadReasoning: 'default', translateReasoning: 'low', transcribeModel: 't', textModel: 'x', groqTranscribeModel: 'g', groqTextModel: 'g2',
  siliconflowTranscribeModel: 's', liveModel: 'l', liveTranslateModel: 'l2', liveCorrectionReasoning: 'low', dailyLimits: {},
};
const profile = { consent: true, goal: 'exam', summary: '偏好先看例子再看定义；在分布式一致性和调度器相关题目上反复出错，选择题容易被“看起来更全面”的干扰项吸引。复盘时更愿意看到对比表。'.repeat(2),
  signals: { got: 44, confused: 20, easy: 3, hard: 5, up: 2, down: 67 }, updatedAt: '2026-09-30T08:15:00.000Z', ready: 3 };
const data = { root: 'D:\\Study\\library', settings: { ...defaults }, sources: [], decks: [], drafts: [], courses: [], focus: { courses: [] } };
const settingsPage = (language, props = {}) => render(inApp(module.exports, h(Settings, { data, settings: { ...defaults }, setSettings: noop,
  legacy: '', setLegacy: noop, exportData: noop, onRestored: noop, initialProfile: profile, ...props }), { data, call: noop, act: noop }), language);

/* ---------- one left edge, one header style ---------- */

test('every Settings section is a settings-section with the same title treatment', () => {
  // The tour shows every category one after another (no list), which is where every section can be checked at once.
  const html = settingsPage('zh', { tourActive: true });
  assert.match(html, /<section class="page settings-page"/);
  const fieldsets = html.match(/<fieldset[^>]*>/g) || [];
  assert.ok(fieldsets.length >= 7, `sections: ${fieldsets.length}`);
  for (const tag of fieldsets) assert.match(tag, /class="[^"]*\bsettings-section\b/, tag);
  const legends = html.match(/<legend[^>]*>/g) || [];
  assert.equal(legends.length, fieldsets.length);
  for (const tag of legends) assert.match(tag, /class="settings-section__title"/, tag);
  for (const title of ['学习库与模型', '课程', '上手与示例', '陪学', '导入 study-lib-spar', '间隔复习 · SM-2', '数据备份与恢复'])
    assert.match(html, new RegExp(`<legend class="settings-section__title">${title}</legend>`), title);
  assert.deepEqual(html.match(/<button(?![^>]*class="sh-)[^>]*>/g) || [], [], 'every button is a shared Button');
});

test('the audio section and its 高级 disclosure share the page edge', () => {
  const html = render(h(AudioSettings, { busy: false, act: noop, call: noop, setNotice: noop, initialView: view }));
  assert.match(html, /<fieldset class="settings-section audio-settings"/);
  assert.match(html, /<legend class="settings-section__title">音频转写<\/legend>/);
  assert.match(html, /class="sh-disclosure audio-advanced settings-disclosure"/, 'the page styles flatten this disclosure to the section edge');
});

/* ---------- provider cards line up ---------- */

test('provider cards: the same rows in the same order, the key input full width, actions below it', () => {
  const html = render(h(AudioSettings, { busy: false, act: noop, call: noop, setNotice: noop, initialView: view }));
  const cards = html.match(/<article class="sh-provider[\s\S]*?<\/article>/g) || [];
  assert.equal(cards.length, 3);
  for (const card of cards) {
    const order = ['sh-provider__head', 'sh-provider__status', 'sh-steps', 'sh-secret__input', 'sh-secret__actions', 'sh-secret__foot'].map(name => card.indexOf(name));
    assert.ok(order.every(at => at > 0), `all rows present: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'rows in the shared order');
    assert.match(card, /<form class="sh-secret"/);
    assert.doesNotMatch(card, /audio-key-row/, 'no input and buttons squeezed into one row');
    assert.match(card, /class="sh-hint sh-hint--sm"/);
  }
  const saved = cards.find(card => card.includes('••••mtzj'));
  const actions = saved.match(/<div class="sh-secret__actions">[\s\S]*?<\/div>/)[0];
  assert.match(actions, /sh-btn--primary[^>]*>[\s\S]*?保存并验证/);
  assert.match(actions, /sh-btn--secondary[^>]*>[\s\S]*?验证/);
  assert.match(actions, /sh-secret__clear[^>]*>[\s\S]*?清除已保存的密钥/);
  assert.match(saved, /class="sh-provider__status is-set"/);
});

test('a failed check shows an inline message under the actions', () => {
  const provider = PROVIDERS.siliconflow;
  const html = render(h(ProviderKeyForm, { provider, state: view.siliconflowKey, call: noop, initialResult: { ok: false, message: 'HTTP 401: Invalid API key' } }));
  const foot = html.match(/<div class="sh-secret__foot">[\s\S]*$/)?.[0] || '';
  assert.match(foot, /sh-inline--error/);
  assert.match(foot, /不可用：HTTP 401: Invalid API key/);
  assert.ok(html.indexOf('sh-secret__actions') < html.indexOf('sh-inline--error'));
  assert.match(html, /aria-describedby="[^"]+"/, 'the input points at the message');
});

/* ---------- 陪学 ---------- */

const coach = (props = {}, language) => render(h(CoachSection, { profile, busy: false, act: noop, setProfile: noop, setNotice: noop, ...props }), language);

test('陪学 says exactly where the profile is used', () => {
  const html = coach();
  assert.match(html, /画像只影响陪学：答错后的提示、追问、改题、强化变式题和每轮复盘的措辞与侧重；不影响出题和复习排期。/);
  assert.match(html, /提示语气与例子会贴近这个目标/);
});

test('the profile is a short summary with 展开, a compact feedback row with icons and the last update', () => {
  const html = coach();
  assert.match(html, /class="coach-profile__summary is-clamped"/);
  assert.match(html, /aria-expanded="false"[^>]*>展开</);
  const stats = html.match(/<ul class="coach-stats"[\s\S]*?<\/ul>/)?.[0] || '';
  for (const [label, count] of [['懂了', 44], ['不懂', 20], ['有用', 2], ['没用', 67]])
    assert.match(stats, new RegExp(`<svg[^>]*>[\\s\\S]*?</svg>${label} <strong>${count}</strong>`), label);
  assert.doesNotMatch(html, /👍|👎/);
  assert.match(html, /上次更新 2026/);
  assert.match(html, /已备 3 道定制题/);
  assert.doesNotMatch(coach({ profile: { ...profile, summary: '短摘要。' } }), /展开/, 'a short summary needs no toggle');
  const en = coach({}, 'en');
  assert.doesNotMatch(en.replace(/偏好[^<]*/g, ''), han);
});

test('清空画像 asks first and says what goes', () => {
  const html = coach({ confirmForget: true });
  assert.match(html, /role="dialog"|<dialog/);
  assert.match(html, /清空陪学画像？/);
  assert.match(html, /学习目标、画像摘要、反馈计数和 3 道未使用的定制题/);
  assert.match(html, /练习记录和复习进度不受影响/);
});

/* ---------- SM-2 ---------- */

test('previewSchedule replays the real scheduler', () => {
  const settings = { ...defaults };
  const preview = previewSchedule(settings, { grade: 4, reviews: 6 });
  let review = initialReview(settings), at = '2026-01-01T00:00:00.000Z', day = 0;
  for (const point of preview) {
    review = schedule(review, 4, at, settings);
    day += review.interval_days;
    assert.equal(point.interval, review.interval_days);
    assert.equal(point.day, day);
    at = review.due_at;
  }
  assert.deepEqual(preview.map(point => point.interval), [1, 6, 15, 38, 95, 238]);
  const hard = previewSchedule(settings, { grade: 3, reviews: 6 });
  assert.ok(hard.at(-1).day < preview.at(-1).day, 'answering with effort grows slower');
  assert.ok(hard.every(point => point.ease >= settings.minimum_ease_factor));
  assert.equal(previewSchedule({ ...settings, initial_ease_factor: 1 }, {}), null, 'invalid values give no preview');
});

test('the SM-2 form is one compact row of number fields with a live preview chart', () => {
  const html = render(h(ScheduleSection, { settings: { ...defaults }, saved: { ...defaults }, setSettings: noop, act: noop, busy: false, setNotice: noop }));
  assert.equal((html.match(/<input type="number"/g) || []).length, 4);
  assert.match(html, /class="sm2-fields"/);
  assert.equal((html.match(/class="sh-number__suffix"/g) || []).length, 2, '天 beside the two interval fields');
  assert.match(html, /熟练系数越大，间隔增长越快；答得吃力时会下降，但不低于最低系数。/);
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-labelledby="[^"]+"/);
  assert.match(html, /<title[^>]*>/);
  assert.match(html, /一直答「熟练」：第 1、7、22、60、155、393 天复习/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?撤销未保存修改/, 'nothing to undo yet');
  const dirty = render(h(ScheduleSection, { settings: { ...defaults, second_interval_days: 4 }, saved: { ...defaults }, setSettings: noop, act: noop, busy: false, setNotice: noop }));
  assert.doesNotMatch(dirty, /<button[^>]*disabled=""[^>]*>[\s\S]*?撤销未保存修改/);
  assert.match(dirty, /第 1、5、/, 'the preview follows unsaved values');
});

/* ---------- backup ---------- */

test('backup and restore are two guided blocks without a raw file input', () => {
  const html = render(h(BackupSection, { root: 'D:\\Study\\library', busy: false, exportData: noop, act: noop, onRestored: noop }));
  const blocks = html.match(/<section class="backup-block"[\s\S]*?<\/section>/g) || [];
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /<h3[^>]*>导出<\/h3>/);
  assert.match(blocks[0], /study-library-\d{4}-\d{2}-\d{2}\.json/);
  assert.match(blocks[0], /浏览器的下载文件夹/);
  assert.match(blocks[0], /sh-btn--primary[\s\S]*?导出学习库/);
  assert.match(blocks[1], /<h3[^>]*>恢复<\/h3>/);
  assert.match(blocks[1], /D:\\Study\\library\\backups/);
  assert.match(blocks[1], /选择备份文件…/);
  assert.match(html, /<input type="file"[^>]*hidden=""/, 'the native input stays hidden behind the button');
  assert.match(backupFileName(new Date('2026-10-02T12:00:00Z')), /^study-library-2026-10-02\.json$/);
});

test('a chosen backup shows its name, size and contents before the destructive confirm', () => {
  const state = { version: 3, courses: [{ name: 'A' }, { name: 'B' }], sources: [{}, {}, {}], decks: [{ cards: [{}, {}] }, { cards: [{}] }], drafts: [], runs: [], attempts: [{}, {}, {}, {}] };
  assert.deepEqual(backupSummary(state), { courses: 2, sources: 3, decks: 2, cards: 3, attempts: 4 });
  const html = render(h(RestorePreview, { file: { name: 'study-library-2026-09-01.json', size: 20480, state }, busy: false, onConfirm: noop, onCancel: noop }));
  assert.match(html, /study-library-2026-09-01\.json/);
  assert.match(html, /20 KB/);
  assert.match(html, /2 门课程 · 3 份资料 · 2 个题组（3 道题） · 4 条作答记录/);
  assert.match(html, /sh-btn--danger[\s\S]*?用此备份替换当前学习库/);
  const en = render(h(RestorePreview, { file: { name: 'b.json', size: 2048, state }, busy: false, onConfirm: noop, onCancel: noop }), 'en');
  assert.doesNotMatch(en, han);
});

test('changing the coach consent or goal reloads the profile outside the single-flight act', async () => {
  const calls = [];
  let acting = false;
  // App's act is single-flight: a nested act() while one is running returns at once without calling.
  const act = async (action, args, after) => {
    if (acting) { calls.push(`skipped ${action}`); return undefined; }
    acting = true; calls.push(action);
    try { const result = { ok: true }; await after?.(result); return result; } finally { acting = false; }
  };
  const call = async (action) => { calls.push(`call ${action}`); return { ...profile, goal: 'work' }; };
  let shown = null;
  const { setConsent, setGoal } = coachActions({ act, call, setProfile: value => { shown = value; } });
  await setGoal('work');
  assert.deepEqual(calls, ['coach.goal', 'call coach.profile']);
  assert.equal(shown.goal, 'work');
  await setConsent(false);
  assert.deepEqual(calls.slice(2), ['coach.consent', 'call coach.profile']);
});
