import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, exportUsage, REPORT_PERIODS } from '../lib/usage-report.js';
import { USAGE_REGISTRY, usageEntry } from '../lib/usage-registry.js';

/* The personal report is computed from the aggregated counts alone: ranking, shares by page and tier, the daily rhythm, what was never
   used, and a few rule-based observations. No model, no scoring. */

const TODAY = '2026-10-03';
const DAY = 86400000;
const at = back => { const d = new Date(new Date(`${TODAY}T12:00:00`).getTime() - back * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const han = /[㐀-鿿]/;

function control(days, { older = 0 } = {}) {
  const entries = Object.entries(days);
  const sorted = entries.map(([back]) => at(Number(back))).sort();
  const inWindow = Object.fromEntries(entries.map(([back, n]) => [at(Number(back)), n]));
  return { first: sorted[0], last: sorted.at(-1), older, total: Object.values(days).reduce((a, b) => a + b, 0) + older, days: inWindow };
}
const every = (from, to, n) => Object.fromEntries(Array.from({ length: from - to + 1 }, (_, i) => [to + i, n]));
function seeded() {
  const controls = {
    'nav.library': control(every(9, 0, 5)),                  // 10 days x 5 = 50, every day, daily tier
    'review.grade': control({ 0: 10, 1: 10, 2: 10, 3: 10 }), // 40
    'nav.sources': control(every(6, 0, 4)),                  // 7 days x 4 = 28 in the quiet group 课程准备与管理
    'nav.exam': control({ 40: 3 }),                          // last used 40 days ago
    'nav.resume': control({ 0: 2, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 }), // 12 clicks
    'shortcut.resume': control({ 0: 1 }),
    'library/button/保存': control({ 0: 6 }),                // not in the registry
  };
  return { version: 1, enabled: true, paused: false, since: at(60), controls,
    areas: { library: { total: 90, older: 0, days: { [at(0)]: 30, [at(1)]: 30, [at(2)]: 30 } }, review: { total: 40, older: 0, days: { [at(0)]: 40 } }, sources: { total: 28, older: 0, days: { [at(0)]: 28 } } } };
}
const interactionsIn = (state, days) => Object.values(state.controls).reduce((sum, c) => sum + Object.entries(c.days).filter(([d]) => d >= at(days - 1)).reduce((s, [, n]) => s + n, 0), 0);

test('the summary counts days with data, interactions and distinct controls in the chosen period', () => {
  const state = seeded();
  assert.deepEqual(REPORT_PERIODS, [7, 30, 'all']);
  const week = buildReport(state, { period: 7, today: TODAY, language: 'en' });
  assert.equal(week.period, 7);
  assert.equal(week.summary.interactions, interactionsIn(state, 7));
  assert.equal(week.summary.daysWithData, 7);
  assert.equal(week.summary.distinctControls, 6, 'nav.exam was not used in the last 7 days');
  const month = buildReport(state, { period: 30, today: TODAY, language: 'en' });
  assert.equal(month.summary.interactions, interactionsIn(state, 30));
  assert.equal(month.summary.distinctControls, 6);
  const all = buildReport(state, { period: 'all', today: TODAY, language: 'en' });
  assert.equal(all.summary.interactions, Object.values(state.controls).reduce((s, c) => s + c.total, 0));
  assert.equal(all.summary.distinctControls, 7);
  assert.equal(all.summary.daysWithData, 11, 'ten recent days and the one 40 days ago');
});

test('the ranking is by count, with the plain registry name in the report language, a share, and unregistered keys marked as such', () => {
  const state = seeded();
  const en = buildReport(state, { period: 7, today: TODAY, language: 'en' });
  assert.deepEqual(en.ranking.slice(0, 3).map(row => row.key), ['review.grade', 'nav.library', 'nav.sources']);
  assert.equal(en.ranking[0].name, 'Grade yourself (0–5)');
  assert.equal(en.ranking[1].name, 'Study library');
  assert.equal(en.ranking[1].count, 35, 'only the last 7 days of nav.library: 7 x 5');
  assert.ok(en.ranking.every((row, i, rows) => i === 0 || rows[i - 1].count >= row.count));
  assert.ok(Math.abs(en.ranking.reduce((sum, row) => sum + row.share, 0) - 1) < 0.02);
  const derived = en.ranking.find(row => row.key === 'library/button/保存');
  assert.equal(derived.registered, false);
  assert.equal(derived.name, null, 'the page turns the key into a name; the server does not guess');
  const zh = buildReport(state, { period: 7, today: TODAY, language: 'zh' });
  assert.equal(zh.ranking[1].name, '学习库');
  assert.equal(zh.ranking[1].tier, 'daily');
  assert.equal(zh.ranking[2].group, 'nav');
  assert.ok(en.ranking.length <= 15);
});

test('usage by page and by tier is a share of the period; tiers come from the registry and unknown keys are "other"', () => {
  const state = seeded();
  const report = buildReport(state, { period: 7, today: TODAY, language: 'en' });
  const tiers = Object.fromEntries(report.byTier.map(row => [row.tier, row]));
  const total = report.summary.interactions;
  assert.equal(tiers.daily.count, 35 + 40 + 12 + 1, 'library, grade, resume and its shortcut');
  assert.equal(tiers.once.count, 28);
  assert.equal(tiers.other.count, 6);
  assert.equal(tiers.periodic.count, 0);
  assert.ok(Math.abs(report.byTier.reduce((s, row) => s + row.share, 0) - 1) < 0.01);
  assert.equal(tiers.daily.share, Math.round((tiers.daily.count / total) * 1000) / 1000);
  assert.deepEqual(report.byTier.map(row => row.tier), ['daily', 'periodic', 'once', 'other']);
  assert.equal(tiers.daily.name, 'Every day');
  assert.equal(report.byArea[0].area, 'library');
  assert.equal(report.byArea[0].name, 'Study library');
  assert.ok(report.byArea.every(row => row.count > 0));
});

test('the daily rhythm has one entry per day of the period, zeros included, oldest first; "all" shows the last 60 days at most', () => {
  const state = seeded();
  const week = buildReport(state, { period: 7, today: TODAY, language: 'en' });
  assert.equal(week.rhythm.length, 7);
  assert.equal(week.rhythm.at(-1).day, TODAY);
  assert.equal(week.rhythm[0].day, at(6));
  assert.equal(week.rhythm.at(-1).n, 5 + 10 + 4 + 2 + 1 + 6);
  assert.equal(buildReport(state, { period: 30, today: TODAY, language: 'en' }).rhythm.length, 30);
  assert.equal(buildReport(state, { period: 'all', today: TODAY, language: 'en' }).rhythm.length, 60);
  assert.equal(buildReport(state, { period: 30, today: TODAY, language: 'en' }).rhythm.find(day => day.day === at(40)), undefined);
});

test('"available but never used" lists registry controls with no use at all, with plain names, tier and group', () => {
  const report = buildReport(seeded(), { period: 30, today: TODAY, language: 'en' });
  const keys = report.neverUsed.map(row => row.key);
  assert.ok(keys.includes('nav.board'));
  assert.ok(keys.includes('review.flip'));
  assert.ok(!keys.includes('nav.library') && !keys.includes('nav.exam'), 'used once 40 days ago is not "never"');
  const board = report.neverUsed.find(row => row.key === 'nav.board');
  assert.deepEqual({ name: board.name, tier: board.tier, group: board.group }, { name: 'Tasks', tier: 'daily', group: 'nav' });
  assert.equal(report.neverUsed.length + report.usedRegistered, USAGE_REGISTRY.length);
});

test('observations are rule-based and each explains itself: a busy control in a quiet group, one idle for 30 days, a shortcut that exists', () => {
  const state = seeded();
  const report = buildReport(state, { period: 30, today: TODAY, language: 'en' });
  const byId = Object.fromEntries(report.observations.map(item => [item.id, item]));
  assert.ok(report.observations.length >= 3 && report.observations.length <= 6, `${report.observations.length} observations`);
  assert.ok(byId['quiet-busy'], 'Sources is used about every day but sits in the quiet group');
  assert.equal(byId['quiet-busy'].key, 'nav.sources');
  assert.match(byId['quiet-busy'].text, /Sources/);
  assert.match(byId['quiet-busy'].text, /Setup & manage/);
  assert.match(byId['quiet-busy'].text, /Every day/);
  assert.ok(byId['idle-fold'], 'Mock exam was last used 40 days ago');
  assert.match(byId['idle-fold'].text, /Mock exam/);
  assert.match(byId['idle-fold'].text, /30 days/);
  assert.ok(byId.shortcut, 'the Return to question button is clicked while the S key is hardly used');
  assert.equal(byId.shortcut.key, 'nav.resume');
  assert.match(byId.shortcut.text, /\bS\b/);
  for (const item of report.observations) {
    assert.equal(item.optional, true, 'every suggestion is optional');
    assert.ok(item.text.length > 20 && !han.test(item.text), item.text);
    assert.ok(!/score|index|metric|coefficient|z-?value/i.test(item.text), 'no scoring jargon');
  }
  const zh = buildReport(state, { period: 30, today: TODAY, language: 'zh' });
  assert.match(zh.observations.find(item => item.id === 'quiet-busy').text, /资料.*课程准备与管理.*每天/);
  assert.deepEqual(zh.observations.map(item => item.id), report.observations.map(item => item.id), 'the same observations in both languages');
});

test('too little data says so instead of inventing advice', () => {
  const state = { version: 1, enabled: true, paused: false, since: TODAY, controls: { 'nav.library': control({ 0: 3 }) }, areas: { library: { total: 3, older: 0, days: { [TODAY]: 3 } } } };
  const report = buildReport(state, { period: 30, today: TODAY, language: 'en' });
  assert.deepEqual(report.observations.map(item => item.id), ['few-data']);
  assert.match(report.observations[0].text, /few days|not enough|too little/i);
  const empty = buildReport({ version: 1, enabled: true, paused: false, since: TODAY, controls: {}, areas: {} }, { period: 7, today: TODAY, language: 'en' });
  assert.equal(empty.summary.interactions, 0);
  assert.deepEqual(empty.ranking, []);
  assert.equal(empty.rhythm.length, 7);
});

test('the JSON export is aggregated counts only, with app version, period and the registry names; no timestamps finer than a day', () => {
  const state = seeded();
  const out = exportUsage(state, { format: 'json', period: 30, today: TODAY, language: 'en', version: '2.5.1' });
  assert.equal(out.filename, 'studyhub-usage-2026-10-03.json');
  assert.equal(out.mime, 'application/json');
  const data = JSON.parse(out.content);
  assert.equal(data.app, 'StudyHub');
  assert.equal(data.version, '2.5.1');
  assert.equal(data.period, 30);
  assert.equal(data.generatedOn, TODAY);
  assert.deepEqual(Object.keys(data).sort(), ['app', 'areas', 'controls', 'generatedOn', 'language', 'observations', 'period', 'registry', 'rhythm', 'summary', 'tiers', 'version']);
  assert.equal(data.controls.find(row => row.key === 'nav.library').count, 50);
  assert.deepEqual(data.registry['nav.library'], { zh: '学习库', en: 'Study library', tier: 'daily', group: 'nav' });
  assert.equal(Object.keys(data.registry).length, USAGE_REGISTRY.length, 'the whole key → name table, so a developer can read the numbers');
  const times = out.content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g);
  assert.equal(times, null, 'no time of day anywhere');
  assert.ok(!/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(out.content), 'no path');
});

test('the Markdown export is a readable report in the chosen language and has no Han in English except unregistered keys the page named', () => {
  const state = seeded();
  const en = exportUsage(state, { format: 'markdown', period: 7, today: TODAY, language: 'en', version: '2.5.1', labels: { 'library/button/保存': 'Save' } });
  assert.equal(en.filename, 'studyhub-usage-2026-10-03.md');
  assert.equal(en.mime, 'text/markdown');
  assert.match(en.content, /^# StudyHub usage report/m);
  assert.match(en.content, /Last 7 days/);
  assert.match(en.content, /\| Study library \| 35 \|/);
  assert.match(en.content, /Save/);
  assert.ok(!han.test(en.content), `no Han: ${en.content.match(/.{0,20}[㐀-鿿]+.{0,20}/)?.[0]}`);
  assert.match(en.content, /never sent anywhere/i);
  const zh = exportUsage(state, { format: 'markdown', period: 'all', today: TODAY, language: 'zh', version: '2.5.1' });
  assert.match(zh.content, /^# StudyHub 使用报告/m);
  assert.match(zh.content, /全部时间/);
  assert.match(zh.content, /\| 学习库 \| 50 \|/);
});

test('every registry control used in a report has a name in both languages and a valid tier', () => {
  for (const item of USAGE_REGISTRY) {
    assert.ok(item.zh && item.en, item.key);
    assert.ok(['daily', 'periodic', 'once'].includes(item.tier), item.key);
    assert.equal(usageEntry(item.key), item);
  }
});
