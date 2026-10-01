import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP16 item 2 (UI): a quiet disk-use line under the library path.
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { LibraryUsageView, formatUsageBytes, usageSummary, shouldHintBackups } from './ui/LibraryUsage.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { LibraryUsageView, formatUsageBytes, usageSummary, shouldHintBackups, setUiLanguage } = module.exports;
const render = (state, props = {}) => renderToStaticMarkup(React.createElement(LibraryUsageView, { state, onRefresh() {}, ...props }));
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const han = /[㐀-鿿]/;
const MB = 1024 ** 2, GB = 1024 ** 3;

const part = (id, bytes, files = 1) => ({ id, bytes, files, label: ({ materials: '资料原文与提取文字', audio: '音频与转写', bank: '题库与复习记录', backups: '备份', other: '其他' })[id] });
const usage = (bytes = {}, extra = {}) => {
  const parts = [part('materials', bytes.materials ?? 820 * MB), part('audio', bytes.audio ?? 300 * MB), part('bank', bytes.bank ?? 12 * MB),
    part('backups', bytes.backups ?? 90 * MB), part('other', bytes.other ?? 0)];
  return { root: 'D:\\lib', total: parts.reduce((sum, item) => sum + item.bytes, 0), parts, computedAt: '2026-10-02T00:00:00.000Z', paths: { backups: 'D:\\lib\\backups' }, ...extra };
};

test('byte sizes use B / KB / MB / GB with at most one decimal', () => {
  setUiLanguage('zh');
  assert.equal(formatUsageBytes(0), '0 B');
  assert.equal(formatUsageBytes(1023), '1023 B');
  assert.equal(formatUsageBytes(1536), '1.5 KB');
  assert.equal(formatUsageBytes(1024), '1 KB');
  assert.equal(formatUsageBytes(12 * MB), '12 MB');
  assert.equal(formatUsageBytes(820 * MB), '820 MB');
  assert.equal(formatUsageBytes(1.2 * GB), '1.2 GB');
  assert.equal(formatUsageBytes(2048 * GB), '2048 GB');
  assert.equal(formatUsageBytes(-5), '0 B');
  assert.equal(formatUsageBytes(NaN), '0 B');
});

test('the summary names the total and every non-empty part in a fixed order', () => {
  setUiLanguage('zh');
  assert.equal(usageSummary(usage()).text, `占用 ${formatUsageBytes(usage().total)} · 资料 820 MB · 音频 300 MB · 题库 12 MB · 备份 90 MB`);
  assert.match(usageSummary(usage()).text, /^占用 1\.2 GB/);
  assert.doesNotMatch(usageSummary(usage()).text, /其他/, 'empty parts are left out');
  assert.match(usageSummary(usage({ other: 3 * MB })).text, /其他 3 MB$/);
  assert.match(usageSummary(usage({}, { partial: true })).text, /^占用至少 1\.2 GB（目录很大，只统计了一部分）/);
});

test('while counting, one reserved line says so', () => {
  setUiLanguage('zh');
  const out = render({ status: 'loading' });
  assert.match(out, /class="usage-line"/);
  assert.match(out, /role="status"/);
  assert.match(text(out), /占用空间计算中…/);
  assert.doesNotMatch(out, /usage-bar/);
});

test('idle and failed counts show nothing at all', () => {
  setUiLanguage('zh');
  assert.equal(render({ status: 'idle' }), '');
  assert.equal(render({ status: 'error' }), '');
  assert.equal(render({ status: 'ready' }), '', 'a ready state without a result is not rendered either');
});

test('the result line carries the summary, a proportional bar and a recalculate button', () => {
  setUiLanguage('zh');
  const out = render({ status: 'ready', usage: usage() });
  assert.match(out, /class="usage-line"/, 'same container as the loading line, so nothing jumps');
  assert.match(text(out), /占用 1\.2 GB · 资料 820 MB · 音频 300 MB · 题库 12 MB · 备份 90 MB/);
  const bar = /<span class="usage-bar"[^>]*role="img"[^>]*aria-label="([^"]+)"/.exec(out);
  assert.ok(bar, 'the bar is an image with a text alternative');
  assert.match(bar[1], /资料原文与提取文字 67%/);
  assert.equal((out.match(/class="usage-seg /g) || []).length, 4, 'one segment per non-empty part');
  assert.match(out, /class="usage-seg usage-seg--materials"[^>]*style="flex-grow:\d+/);
  assert.match(out, /<button[^>]*aria-label="重新计算"[^>]*title="重新计算"/);
});

test('refreshing keeps the old figures and disables the button', () => {
  setUiLanguage('zh');
  const out = render({ status: 'ready', usage: usage(), refreshing: true });
  assert.match(text(out), /占用 1\.2 GB/);
  assert.match(out, /aria-busy="true"/);
  assert.match(out, /disabled=""/);
});

test('large backups earn one hint with the folder, never an automatic deletion', () => {
  setUiLanguage('zh');
  assert.equal(shouldHintBackups(usage()), false, '90 MB of 1.2 GB is fine');
  assert.equal(shouldHintBackups(usage({ backups: 600 * MB })), true, 'more than 500 MB');
  assert.equal(shouldHintBackups(usage({ materials: 100 * MB, audio: 0, bank: 10 * MB, backups: 90 * MB })), true, 'over 30% and big enough to matter');
  assert.equal(shouldHintBackups(usage({ materials: 1000, audio: 0, bank: 1000, backups: 1500 })), false, 'a tiny library is not nagged');
  const out = render({ status: 'ready', usage: usage({ backups: 600 * MB }) });
  assert.match(text(out), /旧备份可以手动删除：D:\\lib\\backups（程序不会自动删除）/);
  assert.doesNotMatch(render({ status: 'ready', usage: usage() }), /旧备份/);
});

test('English locale has no Chinese in the line', () => {
  setUiLanguage('en');
  try {
    const out = text(render({ status: 'ready', usage: usage({ backups: 600 * MB }) }));
    assert.match(out, /Using 1\.7 GB · Sources 820 MB · Audio 300 MB · Question bank 12 MB · Backups 600 MB/);
    assert.match(out, /Old backups can be deleted by hand: D:\\lib\\backups \(nothing is deleted automatically\)/);
    assert.doesNotMatch(out, han);
    const full = render({ status: 'ready', usage: usage() });
    assert.doesNotMatch(full.replace(/<[^>]*>/g, ' '), han);
    assert.doesNotMatch(/aria-label="([^"]*)"/.exec(full.match(/<span class="usage-bar"[^>]*>/)[0])[1], han);
    assert.match(full, /aria-label="Recalculate"/);
    const loading = text(render({ status: 'loading' }));
    assert.match(loading, /Calculating disk use…/);
    assert.match(text(render({ status: 'ready', usage: usage({}, { partial: true }) })), /Using at least 1\.2 GB \(large folder; only part was counted\)/);
  } finally { setUiLanguage('zh'); }
});
