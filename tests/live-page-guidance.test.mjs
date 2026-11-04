import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* The live class page says what it is doing (the owner's real class of 2026-11-04: Chinese lecture, Gemini engine, 「已检查 0 / 24 句」 with 22 timed-out
   calls and no notes): the grey line says what it is, no placeholder over streaming text, one text for a Chinese class, tidy CJK spacing, a polish line that
   shows skipped sentences and its error next to its own retry button, plain words for the audio, a selection bar that says why a button is off, and one
   quiet line about what happens after the class. */

const m = await loadUi(`
  export { default as LiveClass, Sentence } from './ui/LiveClass.jsx';
  export { default as LiveAudioMonitor } from './ui/LiveAudioMonitor.jsx';
  export { LiveAudioHealth } from './ui/live-audio-health.js';
  export { RECENT_CHARS, recentWindow, tidyCjk } from './ui/live-display.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const noop = () => {};
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const render = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };

const LONG = '分区 可以 减少 查询 读取 的 数据量,索引 帮助 快速 定位 .'.repeat(40);
const segment = (id, en, extra = {}) => ({ id, t: id * 5000, en, zh: '', zhState: 'none', ...extra });
const BASE = { id: 'class-1', title: '药学课', course: '药学', status: 'live', revision: 9, total: 5, elapsedMs: 152_000, interim: '', translating: 0, generatedIds: [], warnings: [],
  usage: { estimatedPaidUsd: 0 }, segments: [
    segment(1, LONG, { correctedAt: '2026-11-04T05:00:00.000Z', originalEn: '原稿', correctionReason: '人名' }),
    segment(2, '分区可以减少数据量。'), segment(3, '索引帮助定位。'),
    segment(4, 'A partition lets the optimizer skip data.', { zh: '分区让优化器跳过数据。', zhState: 'done' }),
    segment(5, '这一句 的 译文 重复', { zh: '这一句 的 译文 重复', zhState: 'done' })] };
const CORRECTION = { enabled: true, running: false, covered: 3, coveredThrough: 5, pending: 0, calls: 4, cacheHits: 0, error: '', usage: null, warnings: [],
  skipped: 1, skippedIds: [3], skippedItems: [{ id: 3, reason: '润色超时' }], memory: { text: '', refs: [] }, notes: [], background: { running: false, pending: 0, failed: 0, tasks: [] } };
const ENGLISH = { title: 'Pharmacy', course: 'Pharmacy' };
const page = (session, extra = {}) => h(m.LiveClass, { call: noop, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: true },
  initialSession: { ...BASE, ...session, correction: session?.correction === undefined ? CORRECTION : session.correction }, ...extra });

test('the interim line says what it is, and the placeholder is gone while text is streaming', () => {
  const streaming = render(page({ segments: [], total: 0, interim: '今天我们先讲分区', correction: { ...CORRECTION, skipped: 0, skippedIds: [], skippedItems: [], covered: 0, coveredThrough: 0 } }));
  assert.match(streaming, /class="live-interim"/);
  assert.match(textOf(streaming), /正在听写，句子说完后会定稿/);
  assert.doesNotMatch(textOf(streaming), /开始说话后，原文和译文会出现在这里/);
  const silent = render(page({ segments: [], total: 0, interim: '' }));
  assert.match(textOf(silent), /开始说话后，原文和译文会出现在这里/);
  assert.doesNotMatch(silent, /class="live-interim"/);
  assert.doesNotMatch(textOf(render(page({ interim: '' }))), /正在听写/, 'no label without a line');
});

test('the 断句停顿 hint is still the only explanation of "it never closes": the grey line does not repeat it', () => {
  assert.doesNotMatch(textOf(render(page({ interim: '一直说' }))), /断句停顿/);
});

test('English: the grey line and the placeholder are in English', () => {
  const html = render(page({ ...ENGLISH, segments: [], total: 0, interim: 'we start with partitions', correction: null }), 'en');
  assert.match(textOf(html), /Listening; the sentence is finalized once it ends/);
  assert.doesNotMatch(textOf(render(page({ ...ENGLISH, segments: [], total: 0, interim: '', correction: null }), 'en')).replace(/Simplified Chinese/g, ''), /[㐀-鿿]/);
});

test('a Chinese sentence is shown once: the polished text, with the recognised original behind 查看识别原稿', () => {
  const html = render(page({}));
  const first = html.match(/<article[^>]*data-segment-id="1"[\s\S]*?<\/article>/)[0];
  assert.doesNotMatch(first, /live-chinese/);
  assert.equal((first.match(/<p/g) || []).length, 2, 'the text, and the original inside the details');
  assert.match(first, /<details class="live-correction-original"><summary>查看识别原稿<\/summary><p>原稿<\/p>/);
  const fifth = html.match(/<article[^>]*data-segment-id="5"[\s\S]*?<\/article>/)[0];
  assert.doesNotMatch(fifth, /live-chinese/, 'a Chinese sentence that also has a (copied) translation is still one text');
  assert.equal((fifth.match(/这一句的译文重复/g) || []).length, 1);
  const fourth = html.match(/<article[^>]*data-segment-id="4"[\s\S]*?<\/article>/)[0];
  assert.match(fourth, /live-chinese/, 'an English sentence keeps its translation under it');
});

test('the transcript says one text, not original above and Chinese below, for a class that is all Chinese', () => {
  const chineseOnly = render(page({ segments: BASE.segments.slice(0, 3), total: 3 }));
  assert.doesNotMatch(textOf(chineseOnly), /原文在上，简体中文在下/);
  assert.match(textOf(chineseOnly), /勾选句子或划选文字即可出题/);
  assert.match(textOf(render(page({}))), /原文在上，简体中文在下/, 'a class with English in it keeps the sentence');
});

test('tidyCjk: spaces between CJK characters and half-width punctuation after them are normalised, English and numbers are left alone', () => {
  assert.equal(m.tidyCjk('分区 可以 减少 数据量,索引 帮助 定位 .'), '分区可以减少数据量，索引帮助定位。');
  assert.equal(m.tidyCjk('你好 ,世界 ! 今天 讲 3.5 版'), '你好，世界！今天讲 3.5 版');
  assert.equal(m.tidyCjk('什么 ? 因为 :它 快 ;'), '什么？因为：它快；');
  assert.equal(m.tidyCjk('Hello, world. It is 3.5 now'), 'Hello, world. It is 3.5 now');
  assert.equal(m.tidyCjk('用 Python 写 一个 for 循环'), '用 Python 写一个 for 循环');
  assert.equal(m.tidyCjk(''), ''); assert.equal(m.tidyCjk(undefined), '');
  assert.equal(m.tidyCjk(m.tidyCjk('分区 可以,索引 .')), m.tidyCjk('分区 可以,索引 .'), 'idempotent');
});

test('the interim line and the sentences show tidy text; the stored text is not changed', () => {
  const session = { ...BASE, interim: '今天 我们 先讲 分区,再讲 索引' };
  const html = render(page(session));
  assert.match(html, /今天我们先讲分区，再讲索引/);
  assert.match(html, /分区可以减少查询读取的数据量，索引帮助快速定位。/);
  assert.equal(session.interim, '今天 我们 先讲 分区,再讲 索引');
  assert.match(BASE.segments[0].en, /分区 可以/);
});

test('the polish line with no sentences says what it waits for', () => {
  const html = render(page({ segments: [], total: 0, correction: { ...CORRECTION, covered: 0, coveredThrough: 0, skipped: 0, skippedIds: [], skippedItems: [] } }));
  const line = html.match(/<div class="live-correction-line"[\s\S]*?<details class="live-correction-more"/)[0];
  assert.match(textOf(line), /等第一句说完后开始润色/);
  assert.doesNotMatch(textOf(line), /已检查 0 \/ 0 句/);
});

test('skipped sentences are counted, not marked as checked, and offer the retry even with nothing pending', () => {
  const html = render(page({}));
  const line = html.match(/<div class="live-correction-line"[\s\S]*?<\/div>/)[0];
  assert.match(textOf(line), /已检查 3 \/ 5 句 · 已润色 1 句/);
  assert.match(textOf(line), /已跳过 1 句（原文保留）/);
  assert.match(line, />重试待校正内容</, 'skipped > 0 and pending 0: the button shows (the class is still running)');
  assert.doesNotMatch(html.match(/<article[^>]*data-segment-id="3"[\s\S]*?<\/article>/)[0], /data-mark="checked"/, 'a skipped sentence is not ticked as checked');
  assert.match(html.match(/<article[^>]*data-segment-id="2"[\s\S]*?<\/article>/)[0], /data-mark="checked"/);
  assert.match(html.match(/<article[^>]*data-segment-id="3"[\s\S]*?<\/article>/)[0], /润色超时/, 'the skipped sentence says why it has no mark');
});

test('no retry button when nothing is skipped and nothing waits; the legend stays', () => {
  const html = render(page({ correction: { ...CORRECTION, skipped: 0, skippedIds: [], skippedItems: [], covered: 5 } }));
  assert.doesNotMatch(html, /重试待校正内容/);
  assert.match(html, /live-legend/);
});

test('an error shows inline next to its own retry button, not in a block of its own', () => {
  const html = render(page({ correction: { ...CORRECTION, error: '有 1 句太长，润色超时，已跳过（原文保留）；可点『重试待校正内容』再试。' } }));
  const fix = html.match(/<span class="live-correction-fix"[^>]*>[\s\S]*?<\/span><\/span>|<span class="live-correction-fix"[\s\S]*?<\/button><\/span>/)?.[0] || '';
  assert.match(fix, /live-correction-error/); assert.match(fix, /重试待校正内容<\/button>/);
  assert.equal((html.match(/live-correction-error/g) || []).length, 1);
  assert.doesNotMatch(html, /<p class="live-correction-error"/, 'no separate block under the line');
});

test('an error with nothing to retry is still shown, with no button', () => {
  const html = render(page({ correction: { ...CORRECTION, skipped: 0, skippedIds: [], skippedItems: [], error: '上下文校正未完成：网络中断' } }));
  assert.match(html, /上下文校正未完成：网络中断/); assert.doesNotMatch(html, /重试待校正内容/);
});

test('the tool-maker lines are gone; the usage details keep the calls, the skipped sentences and what the model gave that could not be used', () => {
  const html = render(page({ correction: { ...CORRECTION, warnings: ['第 2 条笔记没有引用，已丢弃'] } }));
  assert.doesNotMatch(html, /当前模型未提供缓存用量|没有新句子时跳过调用|重叠句会重新判断/);
  const more = html.match(/<details class="live-correction-more">[\s\S]*?<\/details>/)[0];
  assert.match(textOf(more), /模型调用 4 次/);
  assert.match(textOf(more), /句 3 · 润色超时/);
  assert.match(textOf(more), /第 2 条笔记没有引用，已丢弃/);
  assert.match(textOf(more), /每 30 秒检查一次/);
});

test('plain words for the audio: one fact and one number, no backend or upload wording', () => {
  const health = new m.LiveAudioHealth(() => 100_000);
  health.reset('microphone', 'running');
  health.update({ capturedMs: 152_000, acceptedMs: 150_000, queuedBytes: 0, lastAckAt: 99_000, lastFrameAt: 99_500, lastSoundAt: 99_500, level: 50, label: '麦克风阵列' });
  for (const compact of [true, false]) {
    const html = render(h(m.LiveAudioMonitor, { health, visible: true, recording: true, compact, sentences: 0 }));
    const text = textOf(html);
    assert.match(text, /电脑已收到声音 2 分 32 秒 · 已识别 0 句/);
    assert.doesNotMatch(text, /后端|上传|传输详情|等待后端接收/);
  }
  assert.match(textOf(render(h(m.LiveAudioMonitor, { health, visible: true, recording: true, compact: true, sentences: 0 }))), /声音详情/);
  const without = textOf(render(h(m.LiveAudioMonitor, { health, visible: true, recording: true })));
  assert.match(without, /电脑已收到声音 2 分 32 秒/); assert.doesNotMatch(without, /已识别/);
  const backlog = new m.LiveAudioHealth(() => 100_000);
  backlog.reset('microphone', 'running'); backlog.update({ queuedBytes: 200_000, lastAckAt: 99_000, lastFrameAt: 99_500 });
  assert.doesNotMatch(textOf(render(h(m.LiveAudioMonitor, { health: backlog, visible: true, recording: true, sentences: 0 }))), /上传|后端/);
});

test('English audio words are English', () => {
  const health = new m.LiveAudioHealth(() => 100_000);
  health.reset('microphone', 'running'); health.update({ capturedMs: 152_000, lastAckAt: 99_000, lastFrameAt: 99_500, level: 40, label: 'Mic' });
  const text = textOf(render(h(m.LiveAudioMonitor, { health, visible: true, recording: true, compact: true, sentences: 3 }), 'en'));
  assert.match(text, /Computer heard 2 min 32 sec · 3 sentences recognized/);
  assert.doesNotMatch(text, /[㐀-鿿]/);
});

test('the selection bar: 最近一段 is capped by characters, and a disabled button says why', () => {
  const fresh = render(page({ segments: [], total: 0, correction: null }));
  assert.match(textOf(fresh), /最近一段/); assert.doesNotMatch(textOf(fresh), /最近 8 句/);
  for (const reason of [/还没有句子可选/, /还没有选中的句子/]) assert.match(textOf(fresh), reason);
  assert.match(fresh, /role="tooltip"/);
  assert.doesNotMatch(fresh.replace(/title="[^"]*"/g, m => (/选|句|出题|字符/.test(m) ? 'BAD' : '')), /BAD/, 'no title= on the buttons');
  const some = render(page({}));
  assert.doesNotMatch(textOf(some), /还没有句子可选/, 'enabled: no reason');
});

test('recentWindow takes the newest sentences up to a character budget, and always at least the newest', () => {
  const s = (id, length) => ({ id, en: 'a'.repeat(length) });
  assert.equal(m.RECENT_CHARS, 1200);
  assert.deepEqual(m.recentWindow([s(1, 100), s(2, 100), s(3, 100)]).map(x => x.id), [1, 2, 3]);
  assert.deepEqual(m.recentWindow([s(1, 500), s(2, 500), s(3, 500)]).map(x => x.id), [2, 3], 'two fit in 1,200; the third would not');
  assert.deepEqual(m.recentWindow([s(1, 100), s(2, 2000)]).map(x => x.id), [2], 'one 2,000-character sentence is the window by itself');
  assert.deepEqual(m.recentWindow(Array.from({ length: 30 }, (_, i) => s(i + 1, 10))).length, 30, 'thirty short sentences are all recent: not capped at eight');
  assert.deepEqual(m.recentWindow([]), []);
});

test('after the class: one quiet line where the end button is, only while the class runs', () => {
  const running = render(page({}));
  assert.equal((textOf(running).match(/结束后会先补完润色/g) || []).length, 1);
  assert.match(textOf(running), /保存为资料/);
  assert.ok(running.indexOf('结束实录') < running.indexOf('结束后会先补完润色'), 'it stands under the end button');
  assert.doesNotMatch(textOf(render(page({ status: 'ended' }))), /结束后会先补完润色/);
});

test('English: the whole running page has no Chinese chrome (the transcript is content)', () => {
  const english = render(page({ ...ENGLISH, segments: [segment(1, 'Partitions reduce the data read.', { zh: '分区减少读取量。', zhState: 'done' })], total: 1, interim: 'then indexes',
    correction: { ...CORRECTION, skipped: 1, skippedIds: [1], skippedItems: [{ id: 1, reason: 'timed out' }], error: '' } }), 'en');
  const chrome = english.replace(/<p class="live-chinese"[^>]*>[^<]*<\/p>/g, '').replace(/<small class="live-skipped"[^>]*>[^<]*<\/small>/g, '');
  assert.doesNotMatch(textOf(chrome), /[㐀-鿿]/);
  assert.match(textOf(english), /Skipped 1 sentence/);
});
