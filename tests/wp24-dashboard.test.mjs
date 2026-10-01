import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP24: three readable charts (trend + due forecast + mastery) with their own
// empty states, accessible titles and tables, in zh and en.
const compiled = await build({ stdin: { contents: `export { TrendPanel, ForecastPanel, MasteryPanel } from './ui/charts/DashboardCharts.jsx';
  export { StatsView } from './ui/Dashboard.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { TrendPanel, ForecastPanel, MasteryPanel, StatsView, setUiLanguage } = module.exports;
const noop = () => {};
const html = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const day = (date, g, gc, s, sc) => ({ date, gradedAvg: g, gradedCount: gc, selfAvg: s, selfCount: sc, avg: g, count: gc, oralCount: 0 });
const trend = [day('2026-09-20', 3.5, 4, null, 0), day('2026-09-21', 4, 2, 2.5, 2), day('2026-09-25', 2, 3, null, 0),
  day('2026-09-26', null, 0, 3, 5), day('2026-10-01', 4.5, 6, 4, 3)];
const days = (counts, extra = {}) => counts.map((count, i) => ({ date: `2026-10-${String(2 + i).padStart(2, '0')}`, count, cards: Array.from({ length: count }, (_, k) => ({ deckId: 'd', cardId: `c${i}-${k}` })), ...(i === 0 ? { overdue: Math.min(count, 2) } : {}), ...extra }));
const forecast = { days: days([8, 0, 3, 0, 0, 5, 0, 0, 2, 0, 0, 0, 1, 0]), later: 4 };
const mastery = { windowDays: 30, minAnswers: 3,
  levels: [{ id: 'recall', n: 10, met: 8, rate: 80, enough: true }, { id: 'concept', n: 2, met: 1, rate: null, enough: false }, { id: 'apply', n: 5, met: 2, rate: 40, enough: true }],
  kinds: [{ id: 'quiz', n: 12, met: 9, rate: 75, enough: true }, { id: 'multi', n: 1, met: 0, rate: null, enough: false }, { id: 'flashcard', n: 6, met: 5, rate: 83, enough: true }] };

test('trend: one wide accessible svg with legend, focusable points, a hidden data table and gaps instead of lines through empty days', () => {
  const out = html(TrendPanel, { trend, today: '2026-10-02' });
  assert.match(out, /<svg[^>]*role="img"[^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(out, /<svg[\s\S]*?<title[^>]*>[^<]+<\/title>[\s\S]*?<desc[^>]*>[^<]+<\/desc>/);
  assert.match(out, /客观判分/);
  assert.match(out, /自评/);
  assert.equal((out.match(/class="dash-point[ "]/g) || []).length, 4 + 3, 'one point per graded and per self value');
  assert.match(out, /<circle[^>]*class="dash-point[^"]*"[^>]*tabindex="0"[^>]*aria-label="[^"]*2026-09-25[^"]*2[^"]*3[^"]*"/, 'a point is focusable and says date, value, count');
  const table = out.match(/<table class="dash-sr"[\s\S]*?<\/table>/)?.[0] || '';
  assert.equal((table.match(/<tr>/g) || []).length, 1 + 5, 'header + one row per studied day');
  assert.match(table, /2026-09-25/);
  const graded = out.match(/<path class="dash-line graded"[^>]*d="([^"]+)"/)?.[1] || '';
  assert.equal((graded.match(/M/g) || []).length, 1, 'Sep 20-21 is a line; Sep 25 and Oct 1 are lone points drawn as dots only');
});

test('trend: gaps are real - a run of three days with a hole makes two subpaths', () => {
  const rows = [day('2026-09-30', 4, 1, null, 0), day('2026-10-01', 3, 1, null, 0), day('2026-10-02', null, 0, 2, 1)];
  const spaced = [day('2026-09-10', 4, 1, null, 0), day('2026-09-11', 3, 1, null, 0), day('2026-09-20', 2, 1, null, 0), day('2026-09-21', 5, 1, null, 0)];
  const one = html(TrendPanel, { trend: rows, today: '2026-10-02' }).match(/<path class="dash-line graded"[^>]*d="([^"]+)"/)?.[1];
  const two = html(TrendPanel, { trend: spaced, today: '2026-10-02' }).match(/<path class="dash-line graded"[^>]*d="([^"]+)"/)?.[1];
  assert.equal((one.match(/M/g) || []).length, 1);
  assert.equal((two.match(/M/g) || []).length, 2);
});

test('trend: axis text is at least 12px and the series use tokens, not hard-coded colours', async () => {
  const css = (await import('node:fs')).readFileSync('ui/charts/charts.css', 'utf8');
  const sizes = [...css.matchAll(/font-size:\s*([^;}]+)[;}]/g)].map(m => m[1].trim());
  assert.ok(sizes.length > 0);
  for (const size of sizes) assert.ok(/^var\(--fs-(xs|sm|md|lg|xl|2xl|3xl)\)$/.test(size) || parseFloat(size) >= 12, `font-size ${size}`);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/, 'colours come from tokens');
});

test('trend: empty state replaces the chart', () => {
  const out = html(TrendPanel, { trend: [], today: '2026-10-02' });
  assert.doesNotMatch(out, /<svg/);
  assert.match(out, /完成第一次学习后/);
});

test('forecast: 14 bars, today is labelled with overdue, and a bar with cards starts that day', () => {
  const out = html(ForecastPanel, { forecast, onStart: noop });
  assert.equal((out.match(/class="dash-bar[ "]/g) || []).length, 14);
  assert.match(text(out), /今天（含逾期）/);
  assert.match(out, /<svg[^>]*role="img"/);
  assert.match(out, /<title[^>]*>[^<]*未来 14 天[^<]*<\/title>/);
  const buttons = out.match(/<g class="dash-bar[^"]*"[^>]*role="button"[^>]*>/g) || [];
  assert.equal(buttons.length, 5, 'only the five days with due cards are buttons');
});

test('forecast: without a start handler nothing is clickable; the table lists all 14 days', () => {
  const out = html(ForecastPanel, { forecast });
  assert.doesNotMatch(out, /role="button"/);
  const table = out.match(/<table class="dash-sr"[\s\S]*?<\/table>/)?.[0] || '';
  assert.equal((table.match(/<tr>/g) || []).length, 1 + 14);
  assert.match(text(out), /更远的 4 题/);
});

test('forecast: empty state names the next step instead of a blank chart', () => {
  const none = html(ForecastPanel, { forecast: { days: days(Array(14).fill(0)), later: 0 }, onStart: noop });
  assert.doesNotMatch(none, /<svg/);
  assert.match(none, /未来 14 天没有到期的复习/);
  const far = html(ForecastPanel, { forecast: { days: days(Array(14).fill(0)), later: 7 }, onStart: noop });
  assert.match(far, /7 题/);
});

test('mastery: levels with enough answers get a bar and a percentage, thin ones say data is insufficient', () => {
  const out = html(MasteryPanel, { mastery });
  assert.match(text(out), /记忆/);
  assert.match(text(out), /概念辨析/);
  assert.match(text(out), /应用分析/);
  assert.match(text(out), /80%/);
  assert.match(text(out), /10 次作答/);
  assert.match(text(out), /40%/);
  assert.equal((out.match(/数据不足/g) || []).length, 1, 'concept has only 2 answers');
  assert.equal((out.match(/class="dash-mastery-fill/g) || []).length, 2);
  assert.match(out, /aria-pressed="true"[^>]*>按认知层次/);
});

test('mastery: the kind view lists single/multi/flashcard rows, and the toggle exists', () => {
  const out = html(MasteryPanel, { mastery, defaultView: 'kind' });
  assert.match(text(out), /单选/);
  assert.match(text(out), /多选/);
  assert.match(text(out), /闪卡/);
  assert.doesNotMatch(text(out), /记忆/);
  assert.equal((out.match(/数据不足/g) || []).length, 1);
  assert.match(out, /aria-pressed="true"[^>]*>按题型/);
});

test('mastery: nothing answered yet gives a short empty state', () => {
  const empty = { windowDays: 30, minAnswers: 3, levels: ['recall', 'concept', 'apply'].map(id => ({ id, n: 0, met: 0, rate: null, enough: false })), kinds: [] };
  const out = html(MasteryPanel, { mastery: empty });
  assert.match(out, /近 30 天还没有足够的作答/);
  assert.doesNotMatch(out, /dash-mastery-fill/);
});

const stats = (patch = {}) => ({ generatedAt: '2026-10-02T04:00:00Z', today: '2026-10-02',
  totals: { attempts: 25, activeDays: 4, streak: 2, due: 8, gradedRate: 33, gradedAttempts: 15, selfRate: 60, selfAttempts: 10, oralAttempts: 0, oralStrong: 0 },
  heatmap: [], trend, forecast, mastery,
  weakTopics: [{ deckId: 'd1', deckTitle: 'Platform Engineering｜期末综合卷04｜90题', course: 'Platform Engineering', topic: 'SLO', wrong: 1 },
    { deckId: 'd2', deckTitle: 'Platform Engineering｜期末综合卷05｜90题', course: 'Platform Engineering', topic: 'Memento', wrong: 2 }], ...patch });
const view = (patch, props = {}) => html(StatsView, { stats: stats(patch), course: '*', data: { decks: [], focus: {} }, busy: false, onStartScope: noop, onLibrary: noop, onCreate: noop, onSources: noop, ...props });

test('stats view: three charts in one grid, trend first, companions after it', () => {
  const out = view();
  const order = ['dash-trend-panel', 'dash-forecast-panel', 'dash-mastery-panel'].map(name => out.indexOf(name));
  assert.ok(order.every(i => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(out, /class="dash-charts"/);
});

test('stats view: the oral-evaluation line is a muted footnote that is hidden at zero', () => {
  assert.doesNotMatch(text(view()), /口头 AI 评估/);
  const out = view({ totals: { ...stats().totals, oralAttempts: 3, oralStrong: 2 } });
  assert.match(out, /<p class="dash-footnote[^"]*"[^>]*>[^<]*口头 AI 评估 · 3 次/);
});

test('stats view: weak topics show the topic first and a shortened deck as secondary text', () => {
  const out = view();
  assert.match(out, /<strong>SLO<\/strong>/);
  assert.match(text(out), /期末综合卷04/);
  assert.doesNotMatch(text(out), /90题/);
  assert.match(text(out), /Platform Engineering/, 'the course is secondary text when all courses are shown');
  const scoped = text(view({}, { course: 'Platform Engineering' }));
  assert.equal((scoped.match(/Platform Engineering/g) || []).length, 0, 'inside one course the course name is not repeated');
});

test('stats view: without any attempt each chart still has its own short empty state', () => {
  const out = view({ totals: { ...stats().totals, attempts: 0, gradedRate: null, selfRate: null }, trend: [],
    forecast: { days: days(Array(14).fill(0)), later: 0 }, mastery: { ...mastery, levels: mastery.levels.map(l => ({ ...l, n: 0, rate: null, enough: false })), kinds: [] }, weakTopics: [] });
  assert.match(out, /完成第一次学习后/);
  assert.match(out, /未来 14 天没有到期的复习/);
  assert.match(out, /近 30 天还没有足够的作答/);
});

test('english: chart copy is translated and no Chinese is left in the chart panels', () => {
  try {
    setUiLanguage('en');
    const out = [html(TrendPanel, { trend, today: '2026-10-02' }), html(ForecastPanel, { forecast, onStart: noop }), html(MasteryPanel, { mastery }),
      html(MasteryPanel, { mastery, defaultView: 'kind' })].join('');
    assert.match(out, /Due in the next 14 days/);
    assert.match(out, /Today \(incl\. overdue\)/);
    assert.match(out, /Recall/);
    assert.match(out, /Insufficient data/);
    assert.match(out, /Daily average/);
    assert.doesNotMatch(out.replace(/<[^>]+>/g, ' '), /[一-鿿]/);
    assert.match(text(view({ totals: { ...stats().totals, oralAttempts: 2, oralStrong: 1 } })), /Oral AI assessments/);
  } finally { setUiLanguage('zh'); }
});
