/* 置顶 on the 资料 page, as the learner sees it: a 置顶 group above the day groups (only when something is pinned, open, in the learner's
   order, a pinned row nowhere else), a small pin on pinned rows, and 置顶 / 取消置顶 / 上移 / 下移 / 置顶到最前 in the row's 更多 menu, in
   Chinese and English. Static markup; the order, the requests and the stored format are tests/material-pins.test.mjs, the layout is
   checked in the browser preview. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withStudy } from './helpers/study-services.mjs';

const compiled = await build({ stdin: { contents: `
  export { default as Sources, RowMenuItems, sourceRowPropsEqual } from './ui/Sources.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };

const note = (id, createdAt, extra = {}) => ({ id, title: `笔记 ${id}`, text: `内容 ${id}`.repeat(3), createdAt, courses: ['DB'], usedBy: [], ...extra });
const sources = [note('n1', '2025-03-04T09:00:00.000Z'), note('n2', '2025-03-04T08:00:00.000Z'), note('n3', '2025-02-01T09:00:00.000Z'), note('n4', '2025-01-01T09:00:00.000Z', { courses: ['OS'] })];
const base = { root: 'lib', sources, decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [{ name: 'DB' }, { name: 'OS' }] }, modelReady: true };
const withPins = (pins, over = {}) => ({ ...base, settings: pins === undefined ? {} : { materialPins: pins }, ...over });
const render = (data, props = {}) => renderToStaticMarkup(withStudy(lib.StudyServicesContext, h(lib.Sources, { data, setModal: noop, onGenerate: noop, ...props }), { act: noop, call: noop }));
const articles = html => html.split('<article').slice(1).map(part => '<article' + part.split('</article>')[0]);
const articleOf = (html, key) => articles(html).find(part => part.includes(`data-document-key="${key}"`));
const keysInOrder = html => [...html.matchAll(/data-document-key="([^"]+)"/g)].map(match => match[1]);
const heads = html => [...html.matchAll(/<button class="source-group-head"([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ open: /aria-expanded="true"/.test(match[1]), text: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));

test('nothing pinned: the page is byte for byte what it was (no field, an empty list, keys of nothing)', () => {
  const plain = render(withPins(undefined));
  assert.doesNotMatch(plain, /已置顶|source-pin|份置顶|--drop-|--dragging/, 'no group, no pin, no sentence about pins');
  assert.equal(render(withPins([])), plain);
  assert.equal(render(withPins(['source:gone', 'doc:gone'])), plain, 'keys that match no material change nothing');
  assert.equal(render(withPins('source:n1')), plain, 'a malformed field is ignored');
  assert.equal(render({ ...base }), plain, 'a library with no settings at all');
});

test('a 置顶 group sits above the day groups, is open, keeps the learner\'s order and holds each pinned row once', () => {
  const html = render(withPins(['source:n3', 'source:n1']));
  const groups = heads(html);
  assert.match(groups[0].text, /^已置顶 /, 'first');
  assert.equal(groups[0].open, true, 'open without being asked');
  assert.match(groups[0].text, /2 份/);
  assert.deepEqual(keysInOrder(html).slice(0, 2), ['source:n3', 'source:n1'], 'the order of the pins, not of the days');
  assert.equal(keysInOrder(html).filter(key => key === 'source:n1').length, 1, 'never drawn twice');
  assert.equal(keysInOrder(html).filter(key => key === 'source:n3').length, 1);
  // The day groups keep their own rows: 3月4日 now holds n2 only, and its totals say so.
  assert.equal(groups.length, 3, 'the pinned group and the two days that still hold a row');
  assert.match(groups[1].text, /1 份 · \d+ 字符/, 'the newest day counts only the row that is left in it');
  assert.deepEqual(keysInOrder(html), ['source:n3', 'source:n1', 'source:n2'], 'n2 stays in its day, which is open');
});

test('the page says how many are pinned, and what the day groups are about', () => {
  assert.match(render(withPins([])), /共 4 份资料，按导入日期分为 3 组/, 'unchanged without pins');
  assert.match(render(withPins(['source:n1'])), /共 4 份资料，其中 1 份置顶，其余按导入日期分为 3 组/);
  assert.match(render(withPins(['source:n1'])), /1 份 · \d+ 字符/);
  assert.match(render(withPins(['source:n1', 'source:n2', 'source:n3', 'source:n4'])), /共 4 份资料，全部置顶/);
  inLanguage('en', () => {
    assert.match(render(withPins(['source:n1'])), /4 source\(s\), 1 pinned, the rest grouped by import date \(3 group\(s\)\)/);
    const english = render(withPins(['source:n1']));
    assert.doesNotMatch(/sh-page-header__description">([^<]*)</.exec(english)[1] + heads(english)[0].text, han);
  });
});

test('a pinned row shows a pin; unpinned rows do not', () => {
  const html = render(withPins(['source:n3', 'source:n1']));
  for (const key of ['source:n3', 'source:n1']) assert.match(articleOf(html, key), /class="source-pin" role="img" aria-label="已置顶"/);
  assert.doesNotMatch(articleOf(html, 'source:n2'), /source-pin/);
  inLanguage('en', () => assert.match(articleOf(render(withPins(['source:n1'])), 'source:n1'), /aria-label="Pinned"/));
});

test('the 更多 menu: 置顶 on a row that is not pinned; 取消置顶, 上移, 下移 and 置顶到最前 on one that is; the ends are disabled', () => {
  const html = render(withPins(['source:n3', 'source:n1', 'source:n2']));
  const entry = (row, label) => new RegExp(`<button[^>]*>${label}</button>`).exec(row)?.[0];
  const off = articleOf(render(withPins(['source:n3'])), 'source:n1');
  assert.ok(entry(off, '置顶'), 'a plain row offers 置顶');
  assert.ok(!entry(off, '取消置顶') && !/上移|下移|置顶到最前/.test(off), 'and no ordering');
  const first = articleOf(html, 'source:n3'), middle = articleOf(html, 'source:n1'), last = articleOf(html, 'source:n2');
  for (const row of [first, middle, last]) { assert.ok(entry(row, '取消置顶')); for (const label of ['上移', '下移', '置顶到最前']) assert.ok(entry(row, label), label); }
  const disabled = (row, label) => /disabled=""/.test(entry(row, label));
  assert.deepEqual(['上移', '置顶到最前', '下移'].map(label => disabled(first, label)), [true, true, false], 'the first row cannot go up');
  assert.deepEqual(['上移', '置顶到最前', '下移'].map(label => disabled(middle, label)), [false, false, false]);
  assert.deepEqual(['上移', '置顶到最前', '下移'].map(label => disabled(last, label)), [false, false, true], 'the last row cannot go down');
  assert.ok(!disabled(first, '取消置顶'));
});

test('the menu in English, and no pin entries on an archived row or where the page offers no way to pin', () => {
  const item = { sourceIds: ['a'], key: 'source:a', format: 'md', title: 'x', usedBy: [], courses: [], pages: [], archived: false };
  const menu = (over = {}) => renderToStaticMarkup(h(lib.RowMenuItems, { item, busy: false, onChangeCourse: noop, onRemove: noop, ...over }));
  assert.doesNotMatch(menu(), /置顶/, 'with no handler there is no entry');
  const pinned = { pinned: true, first: false, last: false };
  inLanguage('en', () => {
    const html = menu({ onPin: noop, onPinMove: noop, pin: pinned });
    for (const label of ['Unpin', 'Move up', 'Move down', 'Move to top']) assert.match(html, new RegExp(`<button[^>]*>${label}</button>`), label);
    assert.match(menu({ onPin: noop, pin: { pinned: false } }), /<button[^>]*>Pin<\/button>/);
    assert.doesNotMatch(html, han);
  });
  assert.doesNotMatch(menu({ item: { ...item, archived: true }, onPin: noop, onPinMove: noop, pin: pinned }), /置顶|上移/, 'an archived row is not pinned from the archive');
  assert.doesNotMatch(menu({ onPin: noop, pin: { pinned: false } }).replace(/<button[^>]*>置顶<\/button>/, ''), /置顶/);
  assert.match(menu({ busy: true, onPin: noop, pin: { pinned: false } }), /<button[^>]*disabled=""[^>]*>置顶<\/button>/, 'a busy page does not take clicks');
});

test('a pin outside the course being shown is not drawn, and brings back no group by itself', () => {
  const data = withPins(['source:n4'], { focus: { course: 'DB', courses: [{ name: 'DB' }, { name: 'OS' }] } });
  const html = render(data);
  assert.doesNotMatch(html, /source:n4/);
  assert.doesNotMatch(html, /已置顶|份置顶/);
  assert.deepEqual(keysInOrder(html).sort(), keysInOrder(render(withPins(undefined, { focus: data.focus }))).sort());
  const all = render(withPins(['source:n4'], { focus: { course: '*', courses: data.focus.courses } }));
  assert.deepEqual(keysInOrder(all)[0], 'source:n4', 'in the all-courses view it is there, first');
});

test('a row is drawn again when it gets or loses a pin, or moves to the end of the list', () => {
  const props = { item: { key: 'k' }, pinned: false, pinFirst: false, pinLast: false, dragging: false, dropMark: '' };
  assert.equal(lib.sourceRowPropsEqual(props, { ...props }), true);
  for (const change of [{ pinned: true }, { pinFirst: true }, { pinLast: true }, { dragging: true }, { dropMark: 'after' }])
    assert.equal(lib.sourceRowPropsEqual(props, { ...props, ...change }), false, JSON.stringify(change));
});
