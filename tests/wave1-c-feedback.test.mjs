import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 1 · WP-C: the feedback and status primitives (issues #88-#103).
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const read = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
const emoji = /[☀-➿\u{1f300}-\u{1faff}]/u;

test('the feedback primitives are exported from the library', () => {
  for (const name of ['Badge', 'Chip', 'Hint', 'ProgressBar', 'StackedBar', 'Spinner', 'LoadingState', 'ErrorState', 'CrashFallback', 'JobRow', 'useNow']) {
    assert.equal(typeof m[name], 'function', name);
  }
  assert.ok(m.ICON_NAMES.includes('mail'), 'the mailbox icon lives in the icon family');
});

test('Badge is a tone-driven pill with two sizes, an optional icon and dot', () => {
  const plain = html(m.Badge, {}, '新');
  assert.match(plain, /^<span class="sh-badge sh-badge--md" data-tone="neutral">新<\/span>$/);
  assert.match(html(m.Badge, { tone: 'error', size: 'sm' }, 'x'), /class="sh-badge sh-badge--sm"[^>]*data-tone="error"|data-tone="error"[^>]*class="sh-badge sh-badge--sm"/);
  assert.match(html(m.Badge, { tone: 'shiny' }, 'x'), /data-tone="neutral"/, 'unknown tones fall back to neutral');
  for (const tone of ['neutral', 'info', 'success', 'warning', 'error', 'accent']) assert.match(html(m.Badge, { tone }, 'x'), new RegExp(`data-tone="${tone}"`));
  const withIcon = html(m.Badge, { tone: 'error', icon: true }, '失败');
  assert.match(withIcon, /<svg[^>]*aria-hidden="true"/, 'icon: true uses the tone icon');
  assert.match(html(m.Badge, { icon: 'file' }, 'x'), /<svg/);
  assert.match(html(m.Badge, { dot: true, tone: 'success' }, '完成'), /<span class="sh-badge__dot" aria-hidden="true"><\/span>/);
  assert.match(html(m.Badge, { className: 'extra', title: 't' }, 'x'), /class="sh-badge sh-badge--md extra"[^>]*title="t"|title="t"[^>]*class="sh-badge sh-badge--md extra"/);
});

test('Chip is a real toggle button, with an optional named remove button', () => {
  const toggle = html(m.Chip, { onClick() {}, selected: true }, '第一章');
  assert.match(toggle, /<button[^>]*type="button"[^>]*aria-pressed="true"[^>]*>第一章<\/button>/);
  assert.match(toggle, /sh-chip sh-chip--md is-selected/);
  assert.match(html(m.Chip, { onClick() {} }, 'x'), /aria-pressed="false"/);
  const removable = html(m.Chip, { onRemove() {}, removeLabel: '移除 第一章' }, '第一章');
  assert.match(removable, /<span class="sh-chip__label">第一章<\/span>/, 'without onClick the label is plain text');
  assert.match(removable, /<button[^>]*aria-label="移除 第一章"/);
  assert.doesNotMatch(html(m.Chip, {}, 'x'), /<button/, 'a chip with no handler is not a control');
});

test('Hint is the one small muted note', () => {
  assert.equal(html(m.Hint, {}, '说明'), '<p class="sh-hint sh-hint--sm">说明</p>');
  assert.match(html(m.Hint, { size: 'xs' }, 'x'), /sh-hint--xs/);
  assert.match(html(m.Hint, { as: 'small' }, 'x'), /^<small class="sh-hint/);
  assert.match(html(m.Hint, { tone: 'warning', id: 'h' }, 'x'), /data-tone="warning"[^>]*id="h"|id="h"[^>]*data-tone="warning"/);
});

test('ProgressBar is the only progressbar: named, bounded, drawn with scaleX', () => {
  const out = html(m.ProgressBar, { value: 3, max: 12, label: '已解析 3/12 页' });
  assert.match(out, /role="progressbar"/);
  assert.match(out, /aria-label="已解析 3\/12 页"/);
  assert.match(out, /aria-valuemin="0"/);
  assert.match(out, /aria-valuemax="12"/);
  assert.match(out, /aria-valuenow="3"/);
  assert.match(out, /transform:scaleX\(0\.25\)/);
  assert.doesNotMatch(out, /width:/, 'the fill is never sized with width');
  assert.match(html(m.ProgressBar, { value: 99, max: 10, label: 'x' }), /aria-valuenow="10"[\s\S]*scaleX\(1\)/, 'values are clamped to the maximum');
  assert.match(html(m.ProgressBar, { value: -4, label: 'x' }), /aria-valuenow="0"/);
  const unnamed = html(m.ProgressBar, { value: 1 });
  assert.match(unnamed, /aria-label="[^"]+"/, 'a progressbar always has an accessible name');
  const waiting = html(m.ProgressBar, { indeterminate: true, label: '处理中' });
  assert.doesNotMatch(waiting, /aria-valuenow/);
  assert.match(waiting, /sh-progress--indeterminate/);
  assert.match(html(m.ProgressBar, { value: 1, label: 'x', tone: 'success', size: 'sm' }), /sh-progress--sm[^>]*data-tone="success"|data-tone="success"[^>]*sh-progress--sm/);
  assert.match(html(m.ProgressBar, { value: 20, ahead: 10, max: 100, label: 'x' }), /sh-progress__ahead[^>]*scaleX\(0\.3\)/, 'the segment in flight is drawn behind the fill');
});

test('StackedBar names the whole breakdown and skips empty segments', () => {
  const out = html(m.StackedBar, { label: '掌握程度', segments: [
    { value: 6, tone: 'success', label: '已掌握' }, { value: 0, tone: 'info', label: '熟悉' }, { value: 2, tone: 'error', label: '薄弱' }] });
  assert.match(out, /role="img"/);
  assert.match(out, /aria-label="掌握程度[^"]*已掌握 6[^"]*薄弱 2/);
  assert.doesNotMatch(out, /熟悉/, 'a zero segment is neither drawn nor named');
  assert.equal((out.match(/class="sh-stacked__segment"/g) || []).length, 2);
  assert.doesNotMatch(out, /<ul/, 'no legend unless asked for');
  const legend = html(m.StackedBar, { label: 'x', legend: true, segments: [{ value: 1, tone: 'success', label: 'a' }] });
  assert.match(legend, /<ul class="sh-stacked__legend">/);
});

test('Spinner and LoadingState: one spinner, a loading line that announces itself', () => {
  assert.match(html(m.Spinner, {}), /^<span class="sh-spinner" aria-hidden="true"><\/span>$/);
  assert.match(html(m.Spinner, { size: 'sm' }), /sh-spinner sh-spinner--sm/);
  const state = html(m.LoadingState, { label: '正在读取…' });
  assert.match(state, /role="status"/);
  assert.match(state, /sh-spinner/);
  assert.match(state, /正在读取…/);
  assert.match(html(m.LoadingState, { inline: true }), /^<span[^>]*sh-loading--inline/);
  assert.match(html(m.LoadingState, {}), /正在载入…/, 'a default label exists');
});

test('ErrorState: an error alert with an optional retry through Button', () => {
  const out = html(m.ErrorState, { error: new Error('boom') });
  assert.match(out, /role="alert"/);
  assert.match(out, /sh-inline--error/);
  assert.match(out, /boom/);
  assert.doesNotMatch(out, /<button/, 'no retry button without a handler');
  const retry = html(m.ErrorState, { error: '读取失败', onRetry() {} });
  assert.match(retry, /读取失败/);
  assert.match(retry, /<button[^>]*sh-btn--link[^>]*>重试<\/button>/);
  assert.match(html(m.ErrorState, { error: 'x', onRetry() {}, retryLabel: '再试一次' }), />再试一次<\/button>/);
  assert.match(html(m.ErrorState, { error: 'x', compact: true }), /sh-error-state--compact/);
  assert.match(html(m.ErrorState, {}), /role="alert"/, 'an error with no message still alerts');
});

test('CrashFallback tells the learner what to do and keeps the raw error behind a disclosure', () => {
  const error = new Error('Cannot read properties of undefined');
  const out = html(m.CrashFallback, { error, onRetry() {}, title: '这部分没能显示' });
  assert.match(out, /role="alert"/);
  assert.doesNotMatch(out, emoji, 'no emoji');
  assert.match(out, /这部分没能显示/);
  assert.match(out, /<details[^>]*sh-disclosure/);
  const main = out.slice(0, out.indexOf('<details'));
  assert.doesNotMatch(main, /Cannot read properties/, 'the raw message is not the main text');
  assert.match(out.slice(out.indexOf('<details')), /Cannot read properties of undefined/);
  assert.match(out, /<button[^>]*sh-btn[\s\S]*?重试<\/button>/);
});

test('JobRow renders a status mark from Icon or Spinner, never a text glyph', () => {
  for (const status of ['queued', 'running', 'complete', 'failed', 'partial', 'cancelled', 'interrupted']) {
    const out = html(m.JobRow, { status, title: 'a.mp3' });
    assert.match(out, new RegExp(`sh-job sh-job--${status}`), status);
    assert.match(out, /<span class="sh-job__mark" aria-hidden="true">/, `${status} mark is hidden from assistive technology`);
    assert.doesNotMatch(out, /[◌✓×]|>!</, `${status} has no text glyph`);
  }
  assert.match(html(m.JobRow, { status: 'running', title: 'x' }), /sh-job__mark" aria-hidden="true"><span class="sh-spinner"/);
  assert.match(html(m.JobRow, { status: 'complete', title: 'x' }), /data-tone="success"/);
  assert.match(html(m.JobRow, { status: 'failed', title: 'x' }), /data-tone="error"/);
  assert.match(html(m.JobRow, { status: 'partial', title: 'x' }), /data-tone="warning"/);
  assert.match(html(m.JobRow, { status: 'complete', title: 'x' }), /<svg/);
});

test('JobRow is not a live region; only its hidden status node is', () => {
  const out = html(m.JobRow, { status: 'running', title: 'a.mp3', meta: '已用 5 秒', progress: { value: 2, max: 10, label: '转写 2/10' } });
  const row = out.match(/^<article[^>]*>/)[0];
  assert.doesNotMatch(row, /role=/, 'the row itself carries no live role');
  assert.doesNotMatch(row, /aria-live/);
  assert.match(out, /<small class="sh-job__meta" aria-live="off">已用 5 秒<\/small>/);
  assert.equal((out.match(/role="status"/g) || []).length, 1, 'exactly one status node');
  assert.match(out, /<span class="sh-visually-hidden" role="status"><\/span>/, 'empty until a discrete change happens');
  assert.match(out, /role="progressbar"[^>]*aria-label="转写 2\/10"|aria-label="转写 2\/10"[^>]*role="progressbar"/);
});

test('JobRow shows the failure, the fixes and the dismiss control through shared components', () => {
  const out = html(m.JobRow, { status: 'failed', title: 'a.mp3',
    failure: { title: '转写服务没有响应', hint: '检查网络后接着做。', detail: 'ECONNRESET at 12:00' },
    actions: [{ label: '接着做', variant: 'primary', onClick() {} }, { label: '停止', onClick() {} }], onDismiss() {} });
  assert.match(out, /sh-inline--error/);
  assert.match(out, /转写服务没有响应/);
  assert.match(out, /检查网络后接着做。/);
  assert.match(out, /<details[^>]*sh-disclosure[\s\S]*ECONNRESET at 12:00/, 'the raw detail is behind a disclosure');
  assert.match(out, /<button[^>]*sh-btn--primary[^>]*>接着做<\/button>/);
  assert.match(out, /<button[^>]*>知道了<\/button>/);
  assert.match(html(m.JobRow, { status: 'partial', title: 'x', failure: { title: 't' } }), /sh-inline--warning/);
  assert.match(html(m.JobRow, { status: 'running', title: 'x', leaving: true }), /aria-hidden="true"[^>]*inert|inert[^>]*aria-hidden="true"/);
  assert.match(html(m.JobRow, { status: 'running', title: 'x' }, h('p', { className: 'extra' }, '补充')), /<p class="extra">补充<\/p>/);
});

test('jobAnnouncement speaks only at discrete status or stage changes', () => {
  const seen = [];
  let previous = null;
  const feed = (state) => { const text = m.jobAnnouncement(previous, state); previous = state; if (text) seen.push(text); return text; };
  assert.equal(feed({ status: 'running', stage: '转写', title: 'a.mp3' }), '', 'the first render announces nothing');
  // A minute of one-second timer ticks changes only the meta text, never the announcement.
  for (let second = 0; second < 60; second++) assert.equal(feed({ status: 'running', stage: '转写', title: 'a.mp3', meta: `已用 ${second} 秒` }), '');
  assert.match(feed({ status: 'running', stage: '校对', title: 'a.mp3' }), /a\.mp3.*校对/);
  assert.match(feed({ status: 'complete', title: 'a.mp3' }), /a\.mp3.*已完成/);
  assert.equal(seen.length, 2, 'two discrete events in the whole run');
  assert.match(m.jobAnnouncement({ status: 'running', title: 'a' }, { status: 'failed', title: 'a' }), /失败/);
  assert.match(m.jobAnnouncement({ status: 'running', title: 'a' }, { status: 'cancelled', title: 'a' }), /已取消/);
  assert.match(m.jobAnnouncement({ status: 'running', title: 'a' }, { status: 'partial', title: 'a' }), /部分/);
  assert.equal(m.jobAnnouncement({ status: 'queued', title: 'a' }, { status: 'queued', title: 'a' }), '');
  assert.equal(m.jobAnnouncement({ status: 'running', title: 'a' }, { status: 'failed', title: 'a', silent: true }), '', 'a visible alert already says it');
  assert.match(m.jobAnnouncement({ status: 'running', title: h('b') }, { status: 'complete', title: h('b') }), /已完成/, 'a non-text title still announces the status');
});

test('the shared clock ticks only while enabled subscribers exist and the page is visible', () => {
  const timers = new Map();
  let next = 1, visible = true, onVisible = () => {};
  const clock = m.createClock({
    setTimer: (fn, ms) => { timers.set(next, { fn, ms }); return next++; },
    clearTimer: id => timers.delete(id),
    isVisible: () => visible,
    watchVisibility: fn => { onVisible = fn; return () => { onVisible = () => {}; }; },
  });
  const a = [], b = [];
  const offA = clock.subscribe(1000, () => a.push(1)), offB = clock.subscribe(1000, () => b.push(1));
  assert.equal(timers.size, 1, 'subscribers of one interval share one timer');
  [...timers.values()][0].fn();
  assert.deepEqual([a.length, b.length], [1, 1]);
  visible = false; onVisible();
  assert.equal(timers.size, 0, 'a hidden page stops the clock');
  visible = true; onVisible();
  assert.equal(timers.size, 1, 'it resumes when the page is visible again');
  assert.equal(a.length, 2, 'and subscribers are told at once so the time is not stale');
  offA();
  assert.equal(timers.size, 1);
  offB();
  assert.equal(timers.size, 0, 'the last unsubscribe clears the timer');
  const other = clock.subscribe(250, () => {});
  assert.equal([...timers.values()][0].ms, 250);
  other();
});

test('feedback.css uses tokens, scopes to the study surfaces and never transitions width', async () => {
  const css = await read('ui/components/feedback.css');
  assert.match(css, /:is\(\.study-app, \.study-seat\)/);
  assert.doesNotMatch(css, /transition[^;]*\bwidth\b/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b(?![^{]*\})/, 'no raw colours');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /font-size:\s*\d+px/, 'font sizes come from tokens');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /z-index/);
  for (const selector of ['.sh-badge', '.sh-chip', '.sh-hint']) {
    const rules = [...css.matchAll(new RegExp(String.raw`${selector.replace('.', String.raw`\.`)}[^{,]*\{[^}]*\}`, 'g'))].map(match => match[0]);
    assert.ok(rules.length, selector);
    for (const size of rules.join('').matchAll(/font-size:\s*([^;]+);/g)) assert.match(size[1], /var\(--fs-(xs|sm)\)/, `${selector} font size`);
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
});
