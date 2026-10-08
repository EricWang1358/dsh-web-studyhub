import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { estimateRun } from '../lib/token-estimate.js';

const compiled = await build({ stdin: { contents: `export * from './ui/audio/run-plan.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.json': 'json', '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { estimateRequest, runPlan, startLabel, subtitleChars, textLanguage, setUiLanguage } = module.exports;

/* The audio form's one start button says what it will do (a long recording is split, several recordings become one transcript), and the estimate under it
   does not assume English: a recording's language is unknown before it is transcribed, a subtitle file's is not. */

const mp3 = (key, seconds = 1800) => [{ key, kind: 'upload', name: `${key}.mp3` }, { seconds, requests: 1 }];
const long = (key, minutes, parts) => [{ key, kind: 'upload', name: `${key}.m4a` }, { seconds: minutes * 60, issue: { code: 'long-split', minutes, parts, requests: parts } }];
const plan = (...entries) => ({ files: entries.map(([file]) => file), checks: Object.fromEntries(entries.map(([file, check]) => [file.key, check])) });

test('one short recording: the plain button', () => {
  setUiLanguage('zh');
  const { files, checks } = plan(mp3('a'));
  assert.equal(startLabel(files, checks), '开始导入');
  assert.deepEqual(runPlan(files, checks), { count: 1, known: true, split: false, minutes: 30, parts: 1, requests: 1, merged: false });
});

test('a recording over the request length is split by the start button, and the button says how', () => {
  setUiLanguage('zh');
  const { files, checks } = plan(long('pe', 95, 2));
  assert.equal(startLabel(files, checks), '开始（约 95 分钟，分 2 段，2 次请求）');
  setUiLanguage('en');
  try { assert.match(startLabel(files, checks), /^Start \(about 95 min, 2 parts, 2 requests\)$/); } finally { setUiLanguage('zh'); }
});

test('several recordings are one transcript, and the button says so (a merge cannot be undone)', () => {
  setUiLanguage('zh');
  const two = plan(mp3('a'), mp3('b'));
  assert.equal(startLabel(two.files, two.checks), '开始（2 个录音合成 1 份逐字稿）');
  const mixed = plan(long('pe', 95, 2), mp3('b', 600));
  assert.match(startLabel(mixed.files, mixed.checks), /^开始（约 105 分钟，分 3 段，3 次请求；2 个录音合成 1 份逐字稿）$/);
  setUiLanguage('en');
  try { assert.match(startLabel(two.files, two.checks), /2 recordings merged into 1 transcript/); } finally { setUiLanguage('zh'); }
});

test('while a check is missing or a file is blocked the button promises no numbers', () => {
  setUiLanguage('zh');
  const { files } = plan(long('pe', 95, 2));
  assert.equal(startLabel(files, {}), '开始导入');
  assert.equal(startLabel(files, { pe: { checking: true } }), '开始导入');
  assert.equal(startLabel(files, { pe: { blocked: true, issue: { message: 'x' } } }), '开始导入');
});

test('a recording\'s estimate asks for both languages; a subtitle file\'s is exact', () => {
  const { files, checks } = plan(mp3('a', 3600));
  assert.deepEqual(estimateRequest(files, checks, { subject: ' SQL ', terms: 'a, b\nc' }),
    { enabled: true, request: { feature: 'audio', terms: 3, subject: 'SQL', minutes: 60, language: 'auto' } });
  assert.equal(estimateRequest([], {}).enabled, false);
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello everyone\n\n2\n00:00:03,000 --> 00:00:05,000\nToday: paging\n';
  assert.equal(subtitleChars(srt), 'Hello everyone'.length + 'Today: paging'.length);
  assert.equal(subtitleChars(JSON.stringify({ body: [{ from: 0, to: 1, content: '大家好' }, { from: 1, to: 2, content: '今天讲分页' }] })), 8);
  assert.equal(subtitleChars('[00:00:01.000] 你好\n[00:00:02.000] 世界'), 4);
  const request = estimateRequest([{ key: 's', kind: 'subtitle', name: 'a.srt', text: srt }], {}).request;
  assert.deepEqual([request.language, request.transcriptChars, request.minutes], ['en', 27, undefined]);
  assert.equal(textLanguage('今天讲分页，大家好'), 'zh');
});

test('the estimate of a recording whose language is unknown covers an English and a Chinese lecture', () => {
  const english = estimateRun('audio', { minutes: 60, language: 'en' }), chinese = estimateRun('audio', { minutes: 60, language: 'zh' });
  const unknown = estimateRun('audio', { minutes: 60, language: 'auto' });
  assert.ok(chinese.totalTokens.high < english.totalTokens.high, 'a Chinese lecture costs less than the English one the estimate used to assume');
  assert.equal(unknown.totalTokens.low, Math.min(english.totalTokens.low, chinese.totalTokens.low));
  assert.equal(unknown.totalTokens.high, Math.max(english.totalTokens.high, chinese.totalTokens.high));
  assert.equal(unknown.calls.low, Math.min(english.calls.low, chinese.calls.low));
  assert.equal(unknown.calls.high, Math.max(english.calls.high, chinese.calls.high));
  assert.ok(unknown.notes.includes('language-unknown'));
  assert.ok(unknown.stages.some(stage => stage.id === 'proofread') && unknown.stages.some(stage => stage.id === 'translate'));
  // With the text in hand there is nothing to cover: one language, exactly as before.
  assert.deepEqual(estimateRun('audio', { transcriptChars: 54000, language: 'auto' }), estimateRun('audio', { transcriptChars: 54000, language: 'zh' }));
  assert.ok(!estimateRun('audio', { transcriptChars: 54000, language: 'zh' }).notes.includes('language-unknown'));
  assert.equal(estimateRun('audio', { minutes: 0, language: 'auto' }).calls.low, 0);
});
