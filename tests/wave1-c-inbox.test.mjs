import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as registry from '../lib/inbox-kinds.js';
import { INBOX_KINDS, notify, inboxView } from '../lib/inbox.js';
import { localizeAppResponse, localizeAppMessage } from '../lib/application-messages.js';

// UI wave 1 · WP-C: the inbox kinds registry (#93), tones (#92) and the panel (#94).
const han = /[㐀-鿿]/;
const read = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Inbox } from './ui/Inbox.jsx'; export { setUiLanguage, ui } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Inbox, setUiLanguage, ui: translate } = module.exports;
const h = React.createElement;
const GROUPS = ['card', 'job', 'note'], TONES = ['success', 'warning', 'error', 'info', 'neutral'];

test('every inbox kind is described once, in the registry', () => {
  const kinds = Object.keys(registry.INBOX_REGISTRY);
  assert.ok(kinds.length >= 19);
  for (const kind of kinds) {
    const info = registry.INBOX_REGISTRY[kind];
    assert.match(info.label, han, `${kind} label`);
    assert.ok(GROUPS.includes(info.group), `${kind} group`);
    assert.ok(TONES.includes(info.tone), `${kind} tone is a status tone, never accent (${info.tone})`);
    assert.match(info.openHint, han, `${kind} open hint`);
    assert.match(info.topic, han, `${kind} topic`);
    if (info.group === 'job') {
      assert.ok(['audio', 'pdf', 'translate'].includes(info.jobDomain), `${kind} job domain`);
      assert.match(info.deckTitle, han, `${kind} deck title`);
    }
  }
  assert.deepEqual(Object.keys(INBOX_KINDS), kinds, 'lib/inbox.js exposes the registry labels');
  for (const kind of kinds) assert.equal(INBOX_KINDS[kind], registry.INBOX_REGISTRY[kind].label);
});

test('failures are error, partial results are warning, nothing defaults to accent', () => {
  for (const [kind, info] of Object.entries(registry.INBOX_REGISTRY)) {
    if (kind.endsWith('-failed')) assert.equal(info.tone, 'error', kind);
    if (kind.endsWith('-warning')) assert.equal(info.tone, 'warning', kind);
    assert.notEqual(info.tone, 'accent', kind);
  }
  assert.equal(registry.inboxTone('pdf-failed'), 'error');
  assert.equal(registry.inboxTone('audio-proofread-warning'), 'warning');
  assert.equal(registry.inboxTone('pdf-result'), 'success');
  assert.equal(registry.inboxTone('no-such-kind'), 'neutral');
});

test('registry helpers answer from the table: job kinds, hints, deck titles, missing copy', () => {
  assert.equal(registry.isJobKind('pdf-result'), true);
  assert.equal(registry.isJobKind('translate-failed'), true);
  assert.equal(registry.isJobKind('improve'), false);
  assert.equal(registry.isInboxKind('grade'), true);
  assert.equal(registry.isInboxKind('hasOwnProperty'), false);
  assert.equal(registry.inboxOpenHint('pdf-result'), '打开 PDF 转换结果');
  assert.equal(registry.inboxOpenHint('translate-result'), '打开这份资料');
  assert.equal(registry.inboxOpenHint('audio-failed'), '打开音频转写结果');
  assert.equal(registry.inboxOpenHint('note'), '打开笔记草稿');
  assert.equal(registry.inboxOpenHint('improve'), '跳到这道题');
  assert.equal(registry.inboxOpenHint('improve', { missing: true }), '这道题已经不在题库里了');
  assert.equal(registry.inboxOpenHint('note', { missing: true }), '笔记已不存在');
  assert.equal(registry.inboxMissingPrompt('note'), '（笔记已删除）');
  assert.equal(registry.inboxMissingPrompt('followup'), '（题目已删除）');
  assert.equal(registry.inboxDeckTitle('pdf-result'), 'PDF 转换');
  assert.equal(registry.inboxDeckTitle('translate-result'), '中英对照翻译');
  assert.equal(registry.inboxDeckTitle('audio-result'), '音频转写');
  assert.equal(registry.inboxDeckTitle('improve'), '');
});

test('the letters that open the explanation panel are named in the table', () => {
  const kinds = Object.keys(registry.INBOX_REGISTRY).filter(kind => registry.opensExplanation(kind));
  assert.deepEqual(kinds.sort(), ['followup', 'improve', 'rewrite']);
  assert.equal(registry.opensExplanation('pdf-result'), false);
  assert.equal(registry.opensExplanation('nope'), false);
  assert.equal(registry.jobDomainOf('pdf-failed'), 'pdf');
  assert.equal(registry.jobDomainOf('audio-result'), 'audio');
  assert.equal(registry.jobDomainOf('translate-result'), 'translate');
  assert.equal(registry.jobDomainOf('improve'), null);
});

test('the topics list covers every kind, so the empty state never goes stale', () => {
  const topics = registry.inboxTopics();
  assert.equal(new Set(topics).size, topics.length, 'no duplicate topic');
  for (const info of Object.values(registry.INBOX_REGISTRY)) assert.ok(topics.includes(info.topic), info.topic);
  });

test('notify and inboxView read the registry: job kinds need a jobId, titles come from the table', () => {
  const state = { decks: [], inbox: [] };
  assert.equal(notify(state, { kind: 'pdf-result', jobId: '' }), null, 'a job letter without a job id is refused');
  assert.equal(notify(state, { kind: 'improve', cardId: '' }), null, 'a card letter without a card id is refused');
  assert.equal(notify(state, { kind: 'bogus', cardId: 'c' }), null);
  assert.ok(notify(state, { kind: 'pdf-result', jobId: 'j1', filename: 'a.pdf' }));
  assert.ok(notify(state, { kind: 'translate-failed', jobId: 'j2', filename: 'b.pdf' }));
  assert.ok(notify(state, { kind: 'audio-failed', jobId: 'j3', filename: 'c.mp3' }));
  const items = Object.fromEntries(inboxView(state).items.map(item => [item.kind, item]));
  assert.equal(items['pdf-result'].deckTitle, 'PDF 转换');
  assert.equal(items['translate-failed'].deckTitle, '中英对照翻译');
  assert.equal(items['audio-failed'].deckTitle, '音频转写');
  assert.equal(items['pdf-result'].label, 'PDF 转换完成');
});

test('English views translate every label and job deck title from the registry', () => {
  const items = Object.keys(registry.INBOX_REGISTRY).map(kind => ({ kind, label: registry.INBOX_REGISTRY[kind].label, deckTitle: registry.inboxDeckTitle(kind), detail: '' }));
  const view = localizeAppResponse({ inbox: { unread: 0, items } }, 'snapshot', 'en').inbox.items;
  for (const item of view) {
    assert.doesNotMatch(item.label, han, `${item.kind} label in English`);
    if (registry.isJobKind(item.kind)) assert.doesNotMatch(item.deckTitle, han, `${item.kind} deck title in English`);
  }
  assert.equal(localizeAppMessage('音频转写'), 'Audio transcription');
  assert.equal(view.find(item => item.kind === 'audio-result').deckTitle, 'Audio transcription');
  assert.equal(view.find(item => item.kind === 'translate-result').deckTitle, 'Bilingual translation');
});

test('kind prefixes are decided only in the registry', async () => {
  for (const file of ['lib/inbox.js', 'lib/application-messages.js', 'ui/Inbox.jsx']) {
    const source = await read(file);
    assert.doesNotMatch(source, /startsWith\(\s*['"](?:pdf|audio|translate)-/, file);
    assert.doesNotMatch(source, /\(\?:audio\|pdf\|translate\)/, file);
  }
});

const letters = [
  { id: 'm1', kind: 'pdf-failed', label: 'PDF 转换未完成', prompt: 'big.pdf', deckTitle: 'PDF 转换', detail: '令牌已过期', at: new Date().toISOString(), read: false },
  { id: 'm2', kind: 'pdf-result', label: 'PDF 转换完成', prompt: 'ok.pdf', deckTitle: 'PDF 转换', detail: '', at: new Date().toISOString(), read: true },
  { id: 'm3', kind: 'audio-proofread-warning', label: '录音校对部分未完成', prompt: 'a.mp3', deckTitle: '音频转写', detail: '', at: new Date().toISOString(), read: false },
  { id: 'm4', kind: 'improve', label: '质量提升', prompt: '为什么用 Bridge？', deckTitle: '设计模式', detail: '补充提示', at: new Date().toISOString(), read: true, count: 2 },
];
const panel = (props = {}) => renderToStaticMarkup(h(Inbox, { inbox: { unread: 2, items: letters }, onOpen() {}, onReadAll() {}, defaultOpen: true, ...props }));

test('the panel shows kind pills by tone, with an icon, never the old accent pill', () => {
  setUiLanguage('zh');
  const out = panel();
  const pill = kind => out.match(new RegExp(`<span class="sh-badge[^"]*"[^>]*data-tone="[a-z]+"[^>]*>(?:(?!</span>).)*?${kind}`, 's'))?.[0] || '';
  assert.match(pill('PDF 转换未完成'), /data-tone="error"/);
  assert.match(pill('PDF 转换完成'), /data-tone="success"/);
  assert.match(pill('录音校对部分未完成'), /data-tone="warning"/);
  assert.match(pill('质量提升'), /data-tone="info"/);
  assert.match(pill('PDF 转换未完成'), /<svg/, 'the failure pill carries an icon, not colour alone');
  assert.doesNotMatch(out, /inbox-kind|data-tone="accent"/);
});

test('the panel reads tooltips from the registry and limits its height with ScrollWindow', () => {
  setUiLanguage('zh');
  const out = panel();
  // The open hint is the last line of the entry's card (#178), not a native title, so two tooltips never show.
  assert.match(out, /mailbox-preview__hint">打开 PDF 转换结果</);
  assert.match(out, /mailbox-preview__hint">打开音频转写结果</);
  assert.match(out, /mailbox-preview__hint">跳到这道题</);
  assert.doesNotMatch(out, /class="mailbox__item[^"]*"[^>]*\btitle=/);
  assert.match(out, /class="sh-scroll /);
  assert.match(out, /role="region"[^>]*aria-label="信箱消息"|aria-label="信箱消息"[^>]*role="region"/);
  assert.doesNotMatch(out, /max-height:\s*\d+px/, 'no hand-measured height');
});

test('every string the registry hands to ui() has an English translation', () => {
  setUiLanguage('en');
  const strings = new Set(registry.inboxTopics());
  for (const kind of Object.keys(registry.INBOX_REGISTRY)) {
    strings.add(registry.inboxOpenHint(kind));
    strings.add(registry.inboxOpenHint(kind, { missing: true }));
    strings.add(registry.inboxMissingPrompt(kind));
  }
  const missing = [...strings].filter(text => han.test(translate(text)));
  setUiLanguage('zh');
  assert.deepEqual(missing, []);
});

test('the mailbox icon comes from the icon family and the toggle is named', async () => {
  setUiLanguage('zh');
  const closed = renderToStaticMarkup(h(Inbox, { inbox: { unread: 3, items: letters }, onOpen() {}, onReadAll() {} }));
  assert.match(closed, /aria-label="信箱，3 条未读"/);
  assert.match(closed, /<svg class="sh-icon"/);
  assert.doesNotMatch(await read('ui/Inbox.jsx'), /<svg|<path/, 'no hand-drawn icon in Inbox.jsx');
  assert.doesNotMatch(await read('ui/Inbox.jsx'), /addEventListener\(["']resize|style\.maxHeight|maxHeight\s*=/, 'no hand-measured height');
});

test('the empty mailbox says what lands here, for every group, in both languages', () => {
  setUiLanguage('zh');
  const empty = renderToStaticMarkup(h(Inbox, { inbox: { unread: 0, items: [] }, onOpen() {}, onReadAll() {}, defaultOpen: true }));
  assert.match(empty, /sh-empty sh-empty--sm/);
  for (const topic of registry.inboxTopics()) assert.ok(empty.includes(topic), topic);
  for (const word of ['PDF', '录音', '翻译', '批改', '原文补题']) assert.ok(empty.includes(word), word);
  setUiLanguage('en');
  const english = renderToStaticMarkup(h(Inbox, { inbox: { unread: 0, items: [] }, onOpen() {}, onReadAll() {}, defaultOpen: true }));
  assert.doesNotMatch(english, han);
  assert.match(english, /PDF/);
  setUiLanguage('zh');
});

test('read failures use the shared error message, not the job-error class', () => {
  setUiLanguage('zh');
  const out = panel({ readError: '网络断了' });
  assert.match(out, /sh-inline--error/);
  assert.match(out, /没能标为已读：网络断了/);
  assert.doesNotMatch(out, /job-error/);
});

test('inbox styles live in ui/inbox.css with tokens only', async () => {
  const css = (await read('ui/inbox.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /font-size:\s*\d+px/);
  assert.doesNotMatch(css, /\b15px\b/);
  assert.doesNotMatch(css, /z-index:\s*\d/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});
