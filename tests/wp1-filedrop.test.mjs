import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// P05 / P20: one file entry for every import. It must keep a dropped file away
// from the DSH chat (stopPropagation), filter by extension and size with a
// readable rejection list, and offer a real, localized button.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/FileDrop.jsx'; export { default } from './ui/components/FileDrop.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { default: FileDrop, partitionFiles, formatBytes, createDropHandlers, guardFileDrag, setUiLanguage } = module.exports;
const MB = 1024 * 1024;
const han = /[㐀-鿿]/;
const file = (name, size, type = '', lastModified = 1) => ({ name, size, type, lastModified });
const render = props => renderToStaticMarkup(React.createElement(FileDrop, { onFiles() {}, ...props }));

function dragEvent(type, { files = [], types = files.length ? ['Files'] : [] } = {}) {
  const event = { type, defaultPrevented: false, propagationStopped: false,
    dataTransfer: { files, types, dropEffect: 'none' },
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
  return event;
}

test('files are filtered by extension, size and emptiness with a reason for each rejection', () => {
  setUiLanguage('zh');
  const { accepted, rejected } = partitionFiles([
    file('notes.md', 1200), file('Slides.PDF', 2 * MB), file('virus.exe', 10), file('big.pdf', 60 * MB), file('empty.txt', 0),
  ], { accept: ['.pdf', 'md', '.TXT'], maxBytes: 50 * MB, multiple: true });
  assert.deepEqual(accepted.map(item => item.name), ['notes.md', 'Slides.PDF']);
  assert.deepEqual(rejected.map(item => [item.name, item.reason]), [['virus.exe', 'type'], ['big.pdf', 'size'], ['empty.txt', 'empty']]);
  for (const item of rejected) assert.match(item.message, han);
  assert.match(rejected[1].message, /50 MB/);
  assert.equal(rejected[0].file.name, 'virus.exe');
});

test('single-file entries keep the first file and explain the rest; duplicates collapse', () => {
  const single = partitionFiles([file('a.md', 5), file('b.md', 5)], { accept: ['.md'], multiple: false });
  assert.deepEqual(single.accepted.map(item => item.name), ['a.md']);
  assert.deepEqual(single.rejected.map(item => [item.name, item.reason]), [['b.md', 'count']]);
  const twice = partitionFiles([file('a.md', 5, '', 7), file('a.md', 5, '', 7)], { accept: ['.md'] });
  assert.deepEqual(twice.accepted.map(item => item.name), ['a.md']);
  assert.deepEqual(twice.rejected, []);
  assert.equal(partitionFiles([file('x.anything', 3)], {}).accepted.length, 1, 'no accept list means any type');
  assert.equal(partitionFiles([file('clip.bin', 3, 'audio/mpeg')], { accept: ['audio/*'] }).accepted.length, 1, 'MIME wildcards work');
});

test('rejection reasons are localized', () => {
  setUiLanguage('en');
  const { rejected } = partitionFiles([file('a.exe', 1), file('b.md', 9 * MB), file('c.md', 0)], { accept: ['.md'], maxBytes: 8 * MB });
  for (const item of rejected) assert.doesNotMatch(item.message, han);
  assert.match(rejected[1].message, /8 MB/);
  setUiLanguage('zh');
});

test('byte sizes read like people write them', () => {
  assert.equal(formatBytes(8 * MB), '8 MB');
  assert.equal(formatBytes(512 * 1024), '512 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1.25 * 1024 * MB), '1.3 GB');
});

test('a file drop is consumed here and never bubbles to the chat composer', () => {
  const received = [], states = [];
  const options = { accept: ['.md'], maxBytes: 10, multiple: true, disabled: false, busy: false };
  const handlers = createDropHandlers({ getOptions: () => options, onFiles: (accepted, rejected) => received.push([accepted, rejected]), onDragState: state => states.push(state) });
  for (const type of ['dragenter', 'dragover']) {
    const event = dragEvent(type, { files: [file('a.md', 3)] });
    handlers[type](event);
    assert.equal(event.defaultPrevented, true, `${type} prevents the browser default`);
    assert.equal(event.propagationStopped, true, `${type} stops propagation`);
  }
  const over = dragEvent('dragover', { files: [] , types: ['Files'] });
  handlers.dragover(over);
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  const drop = dragEvent('drop', { files: [file('a.md', 3), file('b.pdf', 3)] });
  handlers.drop(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(drop.propagationStopped, true);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0][0].map(item => item.name), ['a.md']);
  assert.deepEqual(received[0][1].map(item => item.reason), ['type']);
  assert.deepEqual(states, [true, false]);
});

test('a disabled or busy drop zone still swallows the drop but ignores the files', () => {
  for (const flag of ['disabled', 'busy']) {
    const received = [];
    const handlers = createDropHandlers({ getOptions: () => ({ accept: [], [flag]: true }), onFiles: files => received.push(files) });
    const over = dragEvent('dragover', { files: [file('a.md', 3)] });
    handlers.dragover(over);
    assert.equal(over.dataTransfer.dropEffect, 'none');
    const drop = dragEvent('drop', { files: [file('a.md', 3)] });
    handlers.drop(drop);
    assert.equal(drop.defaultPrevented, true);
    assert.equal(drop.propagationStopped, true);
    assert.deepEqual(received, []);
  }
});

test('dragging text or page elements is left alone', () => {
  const handlers = createDropHandlers({ getOptions: () => ({}), onFiles() { throw new Error('not a file drop'); } });
  const event = dragEvent('drop', { types: ['text/plain'] });
  handlers.drop(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.propagationStopped, false);
});

test('guardFileDrag keeps stray file drops inside an area away from host handlers', () => {
  const listeners = new Map();
  const element = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const detach = guardFileDrag(element);
  assert.deepEqual([...listeners.keys()].sort(), ['dragenter', 'dragover', 'drop']);
  const drop = dragEvent('drop', { files: [file('a.md', 3)] });
  listeners.get('drop')(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(drop.propagationStopped, true);
  const over = dragEvent('dragover', { files: [file('a.md', 3)] });
  listeners.get('dragover')(over);
  assert.equal(over.dataTransfer.dropEffect, 'none');
  const text = dragEvent('drop', { types: ['text/plain'] });
  listeners.get('drop')(text);
  assert.equal(text.propagationStopped, false);
  detach();
  assert.equal(listeners.size, 0);
});

test('the drop zone renders a real localized button, a hidden picker and labelled regions', () => {
  setUiLanguage('zh');
  const html = render({ accept: ['.pdf', '.md'], multiple: true, maxBytes: 8 * MB, label: '把资料拖到这里', hint: 'PDF · Markdown' });
  assert.match(html, /<input[^>]*type="file"[^>]*>/);
  const input = html.match(/<input[^>]*type="file"[^>]*>/)[0];
  assert.match(input, /accept="\.pdf,\.md"/);
  assert.match(input, /multiple=""/);
  assert.match(input, /hidden=""/);
  assert.match(input, /tabindex="-1"/);
  const group = html.match(/<div[^>]*role="group"[^>]*>/)?.[0];
  assert.ok(group, 'the zone is a labelled group');
  const labelledBy = group.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(html, new RegExp(`id="${labelledBy}"[^>]*>把资料拖到这里`));
  const button = html.match(/<button[^>]*type="button"[^>]*>(.*?)<\/button>/)[0];
  assert.match(button, /选择文件/);
  const hintId = button.match(/aria-describedby="([^"]+)"/)[1];
  assert.match(html, new RegExp(`id="${hintId}"`));
  assert.match(html, /PDF · Markdown/);
  assert.match(html, /8 MB/, 'the size limit is stated');
});

test('per-file status chips and actions are rendered and announced politely', () => {
  setUiLanguage('zh');
  const html = render({ accept: ['.pdf'], items: [
    { id: '1', name: 'a.pdf', status: 'working', detail: '正在提取文字' },
    { id: '2', name: 'b.pdf', status: 'error', detail: '读取失败', action: { label: '重试', onClick() {} } },
    { id: '3', name: 'c.pdf', status: 'done' }, { id: '4', name: 'd.pdf', status: 'pending' },
  ] });
  assert.match(html, /<ul[^>]*aria-live="polite"/);
  for (const text of ['a.pdf', '处理中', '正在提取文字', '失败', '读取失败', '重试', '完成', '等待中']) assert.ok(html.includes(text), text);
  assert.match(html, /sh-file-chip--error/);
  assert.match(html, /sh-file-chip--done/);
});

test('disabled and busy states are exposed to assistive technology', () => {
  const disabled = render({ accept: ['.md'], disabled: true });
  assert.match(disabled, /role="group"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*role="group"/);
  assert.match(disabled.match(/<button[^>]*>/)[0], /disabled=""/);
  const busy = render({ accept: ['.md'], busy: true });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy.match(/<button[^>]*>/)[0], /disabled=""/);
});

test('English defaults contain no Chinese', () => {
  setUiLanguage('en');
  const html = render({ accept: ['.pdf', '.md'], multiple: false, maxBytes: 8 * MB,
    items: [{ id: '1', name: 'a.pdf', status: 'working' }, { id: '2', name: 'b.pdf', status: 'error' }] });
  assert.doesNotMatch(html, han);
  assert.match(html, /Choose a file/);
  assert.match(render({ accept: ['.md'], multiple: true }), /Choose files/);
  setUiLanguage('zh');
});
