import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 5A, #89: one error look (ErrorState / InlineMessage tone="error"), one crash fallback, retries through Button.
const walk = (dir, extensions) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, extensions) : extensions.some(ext => entry.name.endsWith(ext)) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sources = walk('ui', ['.jsx', '.js', '.css']).map(file => ({ file, text: read(file) }));

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;

test('#89 the per-page error classes are gone from markup and styles', () => {
  const names = ['dash-error', 'exam-error', 'wb-error', 'wf-error', 'job-error', 'graph-error', 'coach-consent-error', 'audio-dashboard-error', 'agent-link__error'];
  const found = sources.flatMap(({ file, text }) => names.filter(name => text.includes(name)).map(name => `${file}: ${name}`));
  assert.deepEqual(found, []);
});

test('#89 an ErrorState is an error alert with an icon and a Button retry', () => {
  m.setUiLanguage('zh');
  const html = renderToStaticMarkup(React.createElement(m.ErrorState, { error: new Error('学习库读取失败'), onRetry() {}, retryLabel: '重新读取' }));
  assert.match(html, /role="alert"/);
  assert.match(html, /<svg[^>]*sh-inline__icon/);
  assert.match(html, /<button[^>]*class="sh-btn[^"]*"[^>]*>重新读取<\/button>/);
  const crash = renderToStaticMarkup(React.createElement(m.CrashFallback, { error: new Error('boom'), onRetry() {} }));
  assert.match(crash, /role="alert"/);
  assert.doesNotMatch(crash, /⚠|️/);
});

test('#89 the two error boundaries share CrashFallback', () => {
  assert.match(read('ui/host/StudyBoundary.jsx'), /CrashFallback/);
  assert.match(read('ui/deferred-view.jsx'), /CrashFallback/);
});

test('#89 the workflow page shows read and save failures through ErrorState', () => {
  for (const file of ['ui/Workflows.jsx', 'ui/WorkflowPortal.jsx']) assert.doesNotMatch(read(file), /<p className="wf-error"/);
  assert.match(read('ui/Workflows.jsx'), /<ErrorState error=\{error\} onRetry=\{refresh\} retryLabel=\{ui\("重新读取"\)\} \/>/);
});
