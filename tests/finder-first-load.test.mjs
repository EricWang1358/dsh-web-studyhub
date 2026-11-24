import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import React from 'react';
import { renderToStaticMarkup, renderToReadableStream } from 'react-dom/server';
import { buildHostClient } from '../scripts/build.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* 找功能 (#653) is opened now and then, but its data (ui/finder/entries.js, the largest single input of the study workspace) and its sheet used to
   arrive with the first screen. They are a chunk of their own now: what the daily path reads of the finder (where a trip stands, what 「也可以」 says
   of six activities) is in ui/finder/entries-base.js, and the sheet comes through deferredView the first time the finder is opened. The size of the
   whole first load is tests/workspace-closure-pages.test.mjs. */

const LATER = ['ui/finder/entries.js', 'ui/finder/FinderSheet.jsx'];

test('the finder sheet and its entries are not in the workspace first load; each is reached by a dynamic import', async () => {
  const { metafile } = await buildHostClient({ write: false });
  const outputs = new Map(Object.entries(metafile.outputs).map(([path, output]) => [basename(path), output]));
  const statics = (name) => outputs.get(name).imports.filter((edge) => !edge.external && edge.kind === 'import-statement').map((edge) => basename(edge.path));
  const workspace = [...outputs].find(([, output]) => output.entryPoint === 'ui/host/workspace.jsx')?.[0];
  assert.ok(workspace, 'the workspace has a chunk of its own');
  const chunks = new Set(), pending = [workspace];
  while (pending.length) { const name = pending.pop(); if (!chunks.has(name)) { chunks.add(name); pending.push(...statics(name)); } }
  const inFirstLoad = new Set([...chunks].flatMap((name) => Object.keys(outputs.get(name).inputs)));
  const lazy = new Set([...outputs.values()].flatMap((output) => output.imports.filter((edge) => edge.kind === 'dynamic-import').map((edge) => basename(edge.path))));
  for (const input of LATER) {
    assert.ok(!inFirstLoad.has(input), `${input} is loaded when the finder is opened, not with the workspace`);
    const holder = [...outputs].find(([, output]) => input in output.inputs)?.[0];
    assert.ok(holder, `${input} is in some chunk`);
    assert.ok(lazy.has(holder), `${input} sits in a chunk that only a dynamic import reaches`);
  }
});

const m = await loadUi(`
  export { default as FinderSheet } from './ui/finder/lazy-sheet.jsx';
  export { FINDER_ENTRIES, FEATURES, PREPARE_STEPS } from './ui/finder/entries.js';
  export { pageEntries, DAILY_FEATURES, PREPARE_STEPS as BASE_PREPARE_STEPS } from './ui/finder/entries-base.js';
  export { PAGES } from './ui/pages.js';
`);
const HOST = { features: { examBlueprint: true }, contexts: ['bank', 'study', 'materials', 'generation', 'authoring', 'audio', 'recording', 'notes', 'workflows', 'skeleton', 'system'] };
const noop = () => {};
const props = { data: HOST, onGo: noop, onClose: noop, onTour: noop };

test('before the entries arrive the finder is a dialog with the loading state: no list, no empty-result line', () => {
  const html = renderToStaticMarkup(React.createElement(m.FinderSheet, props));
  assert.match(html, /<dialog[^>]*role="dialog"/);
  assert.match(html, />找功能</);
  assert.doesNotMatch(html, /role="listbox"/);
  assert.doesNotMatch(html, /没找到/);
  assert.match(html, /role="status"|aria-busy/, 'the loading state is announced');
});

test('once the sheet has loaded it lists every area and its entries, as the sheet always did', async () => {
  const stream = await renderToReadableStream(React.createElement(m.FinderSheet, props));
  await stream.allReady;
  const html = await new Response(stream).text();
  assert.match(html, /role="listbox"/);
  assert.equal([...html.matchAll(/<details[^>]*class="finder-group"/g)].length, 8, 'eight areas');
  for (const label of ['每天学习', '资料与阅读', '出题', '练习与复习', '考试与统计', '课程与录音', '设置', '名词']) assert.ok(html.includes(`>${label}<`), label);
  assert.ok([...html.matchAll(/role="option"/g)].length > 5, 'the open area lists its entries');
});

test('what the daily path reads from entries-base.js is the same entry the index lists, not a copy that can drift', () => {
  const base = [...m.pageEntries(m.PAGES), ...m.DAILY_FEATURES];
  assert.ok(base.length > 7);
  for (const entry of base) assert.deepEqual(entry, m.FINDER_ENTRIES.find((candidate) => candidate.id === entry.id), entry.id);
  assert.equal(m.BASE_PREPARE_STEPS, m.PREPARE_STEPS, 'entries.js re-exports the same steps');
  for (const entry of m.DAILY_FEATURES) assert.ok(m.FEATURES.includes(entry), `${entry.id} is listed once, in entries-base.js, and FEATURES holds that object`);
});
