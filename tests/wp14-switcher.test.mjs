/* WP14 · the library course switcher ranks courses like every course picker
   and groups "Course / Chapter" names under their course (an <optgroup>),
   without renaming anything. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

const compiled = await build({ entryPoints: ['ui/StudyMap.jsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const StudyMap = module.exports.default;
const CNSD = 'Cloud Native Solution Design';
const names = ['Databases', `${CNSD} / 02 容器与镜像`, `${CNSD} / 01 云计算概览与参考架构`, `${CNSD}/01 云计算概览与参考架构`, 'TCP/IP Basics'];

test('the course switcher puts chapters under their course, in a Combobox that searches', () => {
  const noop = () => {};
  const data = { root: '/tmp/lib', decks: [], progress: {}, sources: [], drafts: [], jobs: [], runs: [], today: { due: 0, weak: 0, new: 0, size: 0 },
    focus: { mode: 'class', course: `${CNSD} / 02 容器与镜像`, courses: names.map(name => ({ name })), fresh: [] } };
  const html = renderToStaticMarkup(React.createElement(StudyMap, { data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop,
    continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, notebooks: [], onFocus: noop }));
  // The server-render tests draw a Combobox as a native <select> (tests/helpers/native-select-stub.jsx): what it offers is what is asserted.
  const select = html.match(/<select[^>]*aria-label="切换当前课程"[\s\S]*?<\/select>/)?.[0] || '';
  assert.match(select, /data-combobox="heading"/);
  assert.doesNotMatch(select, /<optgroup/, 'chapters are a tree of levels now, not an optgroup of indented names');
  const options = [...select.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)];
  assert.equal(options.filter(([, value]) => value === CNSD || value.startsWith(`${CNSD} /`) || value.startsWith(`${CNSD}/`)).length, 4, 'the parent (a scope of its own, nothing is filed under it) and three chapters');
  assert.match(select, new RegExp(`<option value="${CNSD}"[^>]*>${CNSD} · 3 章</option>`), 'the parent carries its chapter count');
  assert.match(select, new RegExp(`<option value="${CNSD} / 01 云计算概览与参考架构"[^>]*data-level="2"[^>]*>01 云计算概览与参考架构</option>`), 'the chapter is shown by its last segment at level 2, the full name is the value');
  assert.match(select, new RegExp(`value="${CNSD} / 02 容器与镜像" data-level="2"[^>]*selected="">02 容器与镜像<`), 'the current chapter is the selected one (the option may carry more attributes: its trigger label)');
  assert.match(select, /<option value="Databases"[^>]*>Databases<\/option>/);
  assert.match(select, /<option value="TCP\/IP Basics"[^>]*>TCP\/IP Basics<\/option>/);
  assert.ok(select.indexOf(`value="${CNSD}"`) < select.indexOf('value="Databases"'), 'ranked like the other pickers: the current course (and its tree) first');
});

test('a parent course lists its chapters in the library (chapters short, in natural order); a chapter lists only itself', () => {
  const noop = () => {};
  const deck = (id, course) => ({ id, title: `题组 ${id}`, folder: course, course, topics: ['t'], available: 3, count: 3, quizCount: 1, createdAt: '2026-09-01T00:00:00Z' });
  const decks = [deck('o', 'Databases'), deck('c10', `${CNSD} / 10 总结`), deck('c2', `${CNSD} / 02 容器与镜像`), deck('c1', `${CNSD}/01 云计算概览与参考架构`), deck('p', CNSD)];
  const progress = Object.fromEntries(decks.map(item => [item.id, { counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 3 }, total: 3, mastery: 0, due: 0, status: 'active', topics: [] }]));
  const render = course => renderToStaticMarkup(React.createElement(StudyMap, { data: { root: '/tmp/lib', decks, progress, sources: [], drafts: [], jobs: [], runs: [], today: { due: 0, weak: 0, new: 0, size: 0 },
    focus: { mode: 'class', course, courses: decks.map(item => ({ name: item.course })), fresh: [] } },
  busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop,
  importLibrary: noop, notebooks: { notebooks: [] }, onFocus: noop, cancelJob: noop, dismissJob: noop, generateFromSources: noop, openModelSettings: noop, canChat: false }));
  const folders = html => [...html.matchAll(/<strong title="([^"]*)">([^<]*)<\/strong>/g)].map(([, title, text]) => [text, title]);
  const parent = folders(render(CNSD));
  assert.deepEqual(parent.map(([text]) => text), [CNSD, '01 云计算概览与参考架构', '02 容器与镜像', '10 总结'], 'the parent first, then its chapters by their last segment, "02" before "10"');
  assert.equal(parent[2][1], `${CNSD} / 02 容器与镜像`, 'the full path stays in the tooltip');
  assert.match(render(CNSD), /查看其他课程 · 1/, 'only the other course is folded away');
  const chapter = render(`${CNSD} / 02 容器与镜像`);
  assert.doesNotMatch(chapter, /题组 c10|题组 c1\b|题组 p\b/, 'a chapter shows only its own decks');
  assert.match(chapter, /题组 c2/);
  assert.match(chapter, /查看其他课程 · 4/);
});
