import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// #107 / #123: the live-class and audio pages speak through the catalogue (ui / uiFormat) like every other page, so the
// English is complete, one Chinese sentence has one English, and nothing keeps a private zh/en dictionary.
const m = await loadUi(`
  export { default as LiveClass, Sentence, SentenceMark } from './ui/LiveClass.jsx';
  export { default as LiveHistory } from './ui/LiveHistory.jsx';
  export { default as LiveNotes } from './ui/LiveNotes.jsx';
  export { default as LiveAudioMonitor } from './ui/LiveAudioMonitor.jsx';
  export { default as AudioReasoning } from './ui/AudioReasoning.jsx';
  export { AudioDashboardView, AudioDashboardPanel } from './ui/AudioDashboard.jsx';
  export { LiveAudioHealth } from './ui/live-audio-health.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const han = /[㐀-鿿]/;
const noop = () => {};
const render = (element, language) => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };
const text = html => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

const segments = [{ id: 1, t: 1000, en: 'Hello class.', zh: '同学们好。', zhState: 'done' },
  { id: 2, t: 61000, en: 'Today we study joins.', zh: '', zhState: 'error', correctedAt: 5, originalEn: 'Today we studied joins', correctionReason: 'wording' },
  { id: 3, t: 3_725_000, en: 'Pending.', zh: '', zhState: 'pending' }];
const sessions = [{ id: 'a', title: 'Databases', elapsedMs: 125_000, segments: 12, active: false }, { id: 'b', title: 'Networks', elapsedMs: 3_661_000, segments: 4, active: true },
  { id: 'c', title: 'Archived', elapsedMs: 1000, segments: 1, archivedAt: '2026-10-01T00:00:00Z' }];
const correction = { memory: { text: 'summary', refs: [1] }, notes: [{ kind: 'amendment', text: 'note', refs: [2] }], background: { pending: 1, failed: 1, running: false,
  tasks: [{ id: 't1', status: 'failed', reason: 'ambiguity', ids: [3], error: 'busy' }, { id: 't2', status: 'queued', reason: 'x', ids: [] }] } };
const health = new m.LiveAudioHealth(() => 100_000);
health.reset('tab', 'running');
health.update({ capturedMs: 65_000, acceptedMs: 60_000, queuedBytes: 200_000, lastAckAt: 1, lastFrameAt: 99_000, label: 'Chrome tab' });
const providers = ['free', 'siliconflow', 'groq', 'paid'].map((tier, index) => ({ tier, configured: index !== 3,
  today: { requests: index + 1, limited: 0, failures: 0, audioSeconds: 600, inputTokens: 1234, outputTokens: 56, outputUnknown: 0 },
  models: [{ model: 'm-' + tier, limit: tier === 'paid' ? null : 20, remaining: 12, used: 8, source: tier === 'groq' ? 'unknown' : 'local-estimate', lastQuota: tier === 'groq' ? {} : undefined }] }));
const dashboard = { providers, timings: [], trend: [{ date: '2026-10-01', free: 1, siliconflow: 2, groq: 3, paid: 4 }, { date: '2026-10-02', free: 0, siliconflow: 0, groq: 0, paid: 0 }] };
const keys = { freeKey: { set: true, hint: '••••1' }, siliconflowKey: { set: true, hint: '••••2' }, groqKey: { set: false, hint: '' }, paidKey: { set: false, hint: '' } };
const audioSettings = { ...keys, dailyLimits: {}, transcribeModel: 'gemini-x', textModel: 'gemini-y', proofreadReasoning: 'default', translateReasoning: 'low' };

const pages = () => [
  h(m.LiveClass, { call: noop, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: true } }),
  h(m.LiveClass, { call: noop, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: false }, onSettings: noop }),
  ...segments.map((segment, index) => h(m.Sentence, { segment, selected: index === 0, generated: index === 0, checked: index === 2, onToggle: noop, language: 'x' })),
  h(m.SentenceMark, { segment: segments[1], checked: false }), h(m.SentenceMark, { segment: segments[0], checked: true }),
  h(m.LiveHistory, { sessions, disabled: false, capturing: false, onOpen: noop, onArchive: noop, onDelete: noop }),
  h(m.LiveNotes, { correction, onSentence: noop, onRetry: noop, disabled: false }),
  h(m.LiveAudioMonitor, { health, visible: true, recording: true }), h(m.LiveAudioMonitor, { health, visible: true, recording: true, compact: true }),
  h(m.AudioReasoning, { settings: audioSettings, busy: false, onSave: noop, timings: [{ stage: 'proofread', averageMs: 4200, count: 3 }] }),
  h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }),
  h(m.AudioDashboardPanel, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }),
];

test('English: no Chinese on any live-class or audio-dashboard surface', () => {
  for (const element of pages()) {
    const html = render(element, 'en').replace(/<p class="live-chinese"[^>]*>[^<]*<\/p>/g, ''); // the transcript's own Chinese translation is content
    assert.doesNotMatch(html, han, `${element.type.name || element.type.displayName || 'component'}: ${text(html).match(/[^|]*[㐀-鿿][^|]*/)?.[0]}`);
  }
});

test('Chinese: the Chinese source copy is shown and no English template placeholder leaks', () => {
  for (const element of pages()) {
    const html = render(element, 'zh');
    assert.doesNotMatch(html, /\{\d+\}/, 'a placeholder was left unfilled');
  }
  const live = text(render(h(m.LiveClass, { call: noop, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: true } }), 'zh'));
  assert.match(live, /课堂实录/);
  assert.match(live, /开始实录/);
  const history = text(render(h(m.LiveHistory, { sessions, disabled: false, capturing: false, onOpen: noop, onArchive: noop, onDelete: noop }), 'zh'));
  assert.match(history, /历史课堂 \(2\)/);
  assert.match(history, /2:05 · 12 句/);
});

test('English wording keeps the meaning the inline dictionaries gave it', () => {
  const history = text(render(h(m.LiveHistory, { sessions, disabled: false, capturing: false, onOpen: noop, onArchive: noop, onDelete: noop }), 'en'));
  assert.match(history, /Previous classes \(2\)/);
  assert.match(history, /2:05 · 12 sentences/);
  assert.match(history, /1:01:01 · 4 sentences · Recording/, 'clocks go to h:mm:ss after an hour');
  const notes = text(render(h(m.LiveNotes, { correction, onSentence: noop, onRetry: noop, disabled: false }), 'en'));
  assert.match(notes, /View class notes · 1 entries/);
  assert.match(notes, /1 pending · 1 incomplete|Pending 1 · Incomplete 1/i);
  const monitor = text(render(h(m.LiveAudioMonitor, { health, visible: true, recording: true }), 'en'));
  assert.match(monitor, /Audio captured 1 min 5 sec · Backend accepted 1 min 0 sec/);
  const sentence = text(render(h(m.Sentence, { segment: segments[2], selected: false, generated: false, checked: false, onToggle: noop, language: 'en' }), 'en'));
  assert.match(sentence, /1:02:05/);
  assert.match(render(h(m.Sentence, { segment: segments[0], selected: false, generated: false, checked: false, onToggle: noop, language: 'en' }), 'en'), /aria-label="Select sentence 1"/);
});

test('the dashboard names providers once, translated, in request order', () => {
  const zh = text(render(h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'zh'));
  const en = text(render(h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'en'));
  for (const [chinese, english] of [['Gemini 免费', 'Gemini Free'], ['硅基流动', 'SiliconFlow'], ['Groq', 'Groq'], ['Gemini 付费', 'Gemini Paid']]) {
    assert.ok(zh.includes(chinese), chinese);
    assert.ok(en.includes(english), english);
  }
  assert.ok(en.indexOf('Gemini Free') < en.indexOf('SiliconFlow') && en.indexOf('SiliconFlow') < en.indexOf('Groq') && en.indexOf('Groq') < en.indexOf('Gemini Paid'));
  const links = render(h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'en').match(/href="https:[^"]+"/g);
  assert.deepEqual(links, ['href="https://aistudio.google.com/usage"', 'href="https://cloud.siliconflow.cn"', 'href="https://console.groq.com/settings/limits"']);
});

test('dashboard numbers follow the interface language', () => {
  const big = { ...dashboard, providers: dashboard.providers.map(provider => ({ ...provider, today: { ...provider.today, inputTokens: 1234567, requests: 1234 } })) };
  const en = text(render(h(m.AudioDashboardView, { data: big, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'en'));
  assert.match(en, /\|4,938,268\|/);
  assert.match(en, /\|1,234\|calls\|/);
});

test('no live or audio page keeps a private zh/en dictionary or reads the language to pick copy', async () => {
  for (const file of ['LiveClass', 'LiveHistory', 'LiveNotes', 'LiveAudioMonitor', 'AudioDashboard', 'AudioReasoning', 'AudioSettings', 'JevSettings', 'WorkflowPortal']) {
    const source = await readFile(new URL(`../ui/${file}.jsx`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /const t = \(zh/, `${file}: local t(zh, en)`);
    assert.doesNotMatch(source, /language === 'en' \?|getUiLanguage\(\) === 'en'/, `${file}: a language ternary`);
    assert.doesNotMatch(source, /\}\{ui\(["'` ]/, `${file}: a sentence glued from fragments`);
    assert.doesNotMatch(source, /setInterval\(/, `${file}: its own timer`);
  }
});
