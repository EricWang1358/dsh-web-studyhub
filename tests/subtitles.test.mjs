import test from 'node:test';
import assert from 'node:assert/strict';
import { clockLabel, cueParagraphs, parseSubtitles } from '../lib/subtitles.js';
import { applyCorrections, buildDocuments } from '../lib/transcript.js';

const bilibili = `[00:00:00.080] 朋友们唉
[00:00:01.900] 今天有点情绪低落
[00:00:03.700] 被OpenAI这个开发者日搞了
[00:01:09.550] 就连deep sk也涨价了
[00:01:11.770] 而这次OpenAI连演都不演了`;
const mixed = `[00:00:00.000] Hey ChatGPT, how's it going?
[00:00:01.640] Hey there, I'm doing great. Thanks for asking.
[00:00:29.280] 当然,我喜欢帮助。
[00:00:30.780] 让我认识哪个语言,我们可以试试。
[00:05:59.969] 所以,要说明,没有 robot扇子吗?
[00:06:39.864] 下文字幕。
[00:07:09.864] In the fun context of all the hex and the playful robot uprising jokes, I'm going to say a big enthusiastic yes.`;

test('timestamped lines: the next line ends a cue, Chinese AI subtitles are joined with commas', () => {
  const cues = parseSubtitles(bilibili, 'lecture.txt');
  assert.equal(cues.length, 5); assert.equal(cues[0].start, 0.08); assert.equal(cues[0].end, 1.9);
  const { paragraphs, labels, seconds } = cueParagraphs(cues, { target: 30, pause: 4 });
  assert.deepEqual(labels, ['[0:00]', '[1:09]'], 'a long pause starts a new paragraph');
  assert.equal(paragraphs[0], '朋友们唉，今天有点情绪低落，被OpenAI这个开发者日搞了');
  assert.equal(seconds, 77, 'the last cue ends by its estimated speaking time');
});

test('mixed-language lines keep their own punctuation and spacing', () => {
  const { paragraphs, labels } = cueParagraphs(parseSubtitles(mixed, 'chat.txt'), { target: 60, pause: 10 });
  assert.equal(paragraphs[0], "Hey ChatGPT, how's it going? Hey there, I'm doing great. Thanks for asking.");
  assert.equal(paragraphs[1], '当然,我喜欢帮助。让我认识哪个语言,我们可以试试。');
  assert.equal(paragraphs[2], '所以,要说明,没有 robot扇子吗?下文字幕。', 'a short fragment is not left on its own');
  assert.deepEqual(labels, ['[0:00]', '[0:29]', '[5:59]', '[7:09]']);
});

test('SRT, WebVTT and Bilibili BCC JSON give the same cues', () => {
  const srt = '1\r\n00:00:01,500 --> 00:00:03,000\r\n第一句\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<i>第二句</i>\r\n';
  const vtt = 'WEBVTT\n\n00:01.500 --> 00:03.000 align:start\n第一句\n\n00:03.000 --> 00:04.000\n第二句\n';
  const bcc = JSON.stringify({ font_size: 0.4, body: [{ from: 1.5, to: 3, content: '第一句' }, { from: 3, to: 4, content: '第二句' }] });
  const expected = [{ start: 1.5, end: 3, text: '第一句' }, { start: 3, end: 4, text: '第二句' }];
  assert.deepEqual(parseSubtitles(srt, 'a.srt'), expected);
  assert.deepEqual(parseSubtitles(vtt, 'a.vtt'), expected);
  assert.deepEqual(parseSubtitles('﻿' + bcc, 'a.json'), expected);
  assert.throws(() => parseSubtitles('just some notes', 'a.txt'), /没有找到带时间戳的字幕/);
  assert.throws(() => parseSubtitles('{"x":1}', 'a.json'), /缺少 body/);
  assert.equal(clockLabel(3725.2), '[1:02:05]');
});

test('a Latin word written between Chinese characters is still a whole word, but not inside a longer Latin word', () => {
  const fix = (text, wrong, right, context) => applyCorrections(text, [{ wrong, right, context, confidence: 'high' }]);
  assert.equal(fix('就连deep sk也涨价了', 'deep sk', 'DeepSeek', '就连deep sk也涨价了').text, '就连DeepSeek也涨价了');
  assert.equal(fix('GPU6pro每周', 'GPU6pro', 'GPT-5 Pro', 'GPU6pro每周').applied.length, 1);
  assert.equal(fix('the patients were', 'patient', 'partition', 'the patients were').skipped[0].skipped, 'context-mismatch');
  assert.equal(fix('naïvepatient', 'patient', 'partition', 'naïvepatient').skipped[0].skipped, 'context-mismatch');
});

test('start times lead both paragraphs of a bilingual pair', () => {
  const [text] = buildDocuments({ filename: 'x', titleEn: 'X', parts: [{ titleZh: '一', titleEn: 'One', labels: ['[0:00]', '[1:09]'],
    chinese: ['朋友们', '涨价了'], english: ['Friends', 'Prices rose'], sourceLanguage: 'zh' }] });
  assert.match(text, /【中文原文】\n\[0:00\] 朋友们\n\n\[1:09\] 涨价了\n\n【英文对照】\n\[0:00\] Friends\n\n\[1:09\] Prices rose/);
});
