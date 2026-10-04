import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* Wave 1, package E: call sites that moved onto the shared primitives and logic once packages A to D were merged. */

const h = React.createElement;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/* ---------- 1. MinerU token form (#118) ---------- */

const mineru = await loadUi(`export { MineruTokenForm } from './ui/MineruSettings.jsx'; export { SecretKeyForm } from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`);

test('the MinerU token form is a thin adapter over SecretKeyForm', async () => {
  const calls = [];
  const call = async (name, args) => { calls.push([name, args]); return name === 'mineru.test' ? { ok: true, state: 'valid' } : { token: { set: true, hint: '••••abcd' } }; };
  const saved = [];
  const element = mineru.MineruTokenForm({ call, settings: { token: { set: true, hint: '••••abcd', source: 'file' } }, onSaved: (next) => saved.push(next) });
  assert.equal(element.type, mineru.SecretKeyForm);
  const props = element.props;
  assert.equal(props.name, 'mineru-token');
  assert.equal(props.saved.hint, '••••abcd');
  await props.onSave('tok');
  assert.deepEqual(calls[0], ['mineru.settings.set', { token: 'tok' }]);
  assert.equal(saved.length, 1);
  const verdict = await props.onVerify();
  assert.deepEqual(calls[1], ['mineru.test', {}]);
  assert.equal(verdict.ok, true);
  await props.onClear();
  assert.deepEqual(calls[2], ['mineru.settings.set', { token: '' }]);
  assert.match(props.resultText({ ok: false, state: 'invalid' }), /令牌无效/);
  assert.equal(props.clearLabel, '清除已保存的令牌');
});

test('the MinerU token form renders the shared form, not hand-made key classes', () => {
  mineru.setUiLanguage('zh');
  const html = renderToStaticMarkup(h(mineru.MineruTokenForm, { call: async () => ({}), settings: { token: { set: true, hint: '••••abcd', source: 'file' } } }));
  assert.match(html, /sh-secret/);
  assert.doesNotMatch(html, /audio-key-/);
  assert.match(html, /name="mineru-token"/);
});

test('type="password" lives only inside ui/components', async () => {
  const walk = async (dir) => (await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }))
    .flatMap((entry) => (entry.isDirectory() ? [] : [`${dir}/${entry.name}`]));
  const offenders = [];
  const roots = ['ui', 'ui/document-preview', 'ui/tour', 'ui/usage', 'ui/board', 'ui/charts', 'ui/host', 'ui/reading-settings'];
  for (const dir of roots) for (const file of await walk(dir)) if (/\.(jsx?|css)$/.test(file) && /type="password"/.test(await read(file))) offenders.push(file);
  assert.deepEqual(offenders, []);
});

test('the old audio-key-* classes are gone from the stylesheets and the pages', async () => {
  for (const file of ['ui/audio-settings.css', 'ui/jev.css', 'ui/mineru.css', 'ui/MineruSettings.jsx', 'ui/JevSettings.jsx', 'ui/JevLevelCheck.jsx']) {
    assert.doesNotMatch(await read(file), /audio-key-(form|input|actions|foot|clear)\b/, file);
  }
});

/* ---------- 2. Audio import on the shared upload, format and file-name logic (#120 #126 #127) ---------- */

const source = async (path) => (await read(path)).replace(/\r\n/g, '\n');

test('audio import has no local copy of the upload loop, the size and clock formats, the extension lists or the path helpers', async () => {
  const page = await source('ui/AudioImport.jsx');
  assert.match(page, /uploadInChunks\(call, 'audio', /);
  assert.match(page, /maxChunkBytes: 3 \* 1024 \* 1024/);
  for (const [name, pattern] of [['toBase64', /const toBase64/], ['formatSize', /formatSize/], ['spent', /const spent/], ['extensionOf', /const extensionOf/], ['baseName', /const baseName/],
    ['isAbsolutePath', /const isAbsolutePath/], ['unquote', /const unquote/], ['MAX_BYTES', /const MAX_BYTES/], ['MAX_SUBTITLE_BYTES', /const MAX_SUBTITLE_BYTES/], ['EXTENSIONS', /const EXTENSIONS/], ['SUBTITLES', /const SUBTITLES/]]) {
    assert.doesNotMatch(page, pattern, `${name} comes from a shared module`);
  }
  for (const from of ['./format.js', './upload.js', './file-names.js', './paths.js', '../lib/audio-formats.js']) assert.ok(page.includes(`'${from}'`) || page.includes(`"${from}"`), from);
});

/* ---------- 3. Inbox: shared "ago" and dismiss (#94 #82 #80) ---------- */

const inboxModule = await loadUi(`export { default as Inbox } from './ui/Inbox.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const letterAt = (ms, id = 'm') => ({ id, kind: 'pdf-result', label: 'PDF 转换完成', prompt: 'ok.pdf', deckTitle: 'PDF 转换', detail: '', at: new Date(Date.now() - ms).toISOString(), read: true });
const timeLabels = (ms, language) => {
  inboxModule.setUiLanguage(language);
  try { return renderToStaticMarkup(h(inboxModule.Inbox, { inbox: { unread: 0, items: [letterAt(ms)] }, onOpen() {}, onReadAll() {}, defaultOpen: true })).match(/<small class="mailbox__time">(.*?)<\/small>/)?.[1]; }
  finally { inboxModule.setUiLanguage('zh'); }
};

test('the inbox writes its ages with the shared formatter: singular and plural are right in English', () => {
  assert.equal(timeLabels(30_000, 'en'), 'Just now');
  assert.equal(timeLabels(61_000, 'en'), '1 minute ago');
  assert.equal(timeLabels(5 * 60_000, 'en'), '5 minutes ago');
  assert.equal(timeLabels(70 * 60_000, 'en'), '1 hour ago');
  assert.equal(timeLabels(3 * 3600_000, 'en'), '3 hours ago');
  for (const days of [1, 2, 5]) assert.doesNotMatch(timeLabels(days * 86_400_000 + 3600_000, 'en'), /days? ago/, 'older than a day is a date, never "1 days ago"');
  assert.equal(timeLabels(5 * 60_000, 'zh'), '5 分钟前');
});

test('the inbox closes through useDismiss and puts focus inside the panel and back on the toggle', async () => {
  const page = await source('ui/Inbox.jsx');
  assert.doesNotMatch(page, /addEventListener|removeEventListener/, 'no document listeners of its own');
  assert.match(page, /useDismiss\(\{[^}]*returnFocusRef/s);
  assert.match(page, /formatAgo/);
  assert.doesNotMatch(page, /const ago\b/);
});
