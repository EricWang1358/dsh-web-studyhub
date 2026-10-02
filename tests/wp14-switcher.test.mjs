/* WP14 · the library course switcher ranks courses like every course picker
   and groups "Course / Chapter" names under their course (an <optgroup>),
   without renaming anything. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ entryPoints: ['ui/StudyMap.jsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const StudyMap = module.exports.default;
const CNSD = 'Cloud Native Solution Design';
const names = ['Databases', `${CNSD} / 02 容器与镜像`, `${CNSD} / 01 云计算概览与参考架构`, `${CNSD}/01 云计算概览与参考架构`, 'TCP/IP Basics'];

test('the course switcher puts chapters in an optgroup under their course', () => {
  const noop = () => {};
  const data = { root: '/tmp/lib', decks: [], progress: {}, sources: [], drafts: [], jobs: [], runs: [], today: { due: 0, weak: 0, new: 0, size: 0 },
    focus: { mode: 'class', course: `${CNSD} / 02 容器与镜像`, courses: names.map(name => ({ name })), fresh: [] } };
  const html = renderToStaticMarkup(React.createElement(StudyMap, { data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop,
    continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, notebooks: [], onFocus: noop }));
  const select = html.match(/<select aria-label="切换当前课程"[\s\S]*?<\/select>/)?.[0] || '';
  assert.match(select, new RegExp(`<optgroup label="${CNSD}">`));
  const group = select.match(/<optgroup[\s\S]*?<\/optgroup>/)[0];
  assert.equal((group.match(/<option/g) || []).length, 4, 'the parent (a scope of its own, nothing is filed under it) and three chapters');
  assert.match(group, new RegExp(`<option value="${CNSD}">${CNSD} · 含子课程</option>`));
  assert.match(group, new RegExp(`<option value="${CNSD} / 01 云计算概览与参考架构">01 云计算概览与参考架构</option>`), 'the chapter is shown, the full name is the value');
  assert.match(group, new RegExp(`value="${CNSD} / 02 容器与镜像" selected="">02 容器与镜像<`));
  assert.match(select, /<option value="Databases">Databases<\/option>/);
  assert.match(select, /<option value="TCP\/IP Basics">TCP\/IP Basics<\/option>/);
  assert.ok(select.indexOf('<optgroup') < select.indexOf('Databases'), 'ranked like the other pickers: the current course (and its group) first');
});
