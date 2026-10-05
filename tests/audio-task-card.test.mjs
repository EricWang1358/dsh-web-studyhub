import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The audio task card (WP-AU): effective parallelism (#212), and below the history, the sub-agent links (#211, #214). */

const compiled = await build({
  stdin: { contents: `export { AudioJobs, parallelNote, reuseNote } from './ui/audio/AudioJobs.jsx'; export { AudioDashboardView } from './ui/AudioDashboard.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.json': 'json', '.css': 'text' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AudioJobs, parallelNote, reuseNote, AudioDashboardView, setUiLanguage } = module.exports;
const HAN = /[㐀-鿿]/;
const inLanguage = (language, run) => { try { setUiLanguage(language); return run(); } finally { setUiLanguage('zh'); } };
const noop = () => {};
const render = (job, props = {}) => renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [job] }, busy: false, act: noop, ...props }));
const running = (extra = {}) => ({ id: 'j1', type: 'audio-import', filename: 'lecture.mp3', status: 'running', phase: 'proofread', done: 2, total: 6,
  steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 2, total: 6 } }, warnings: [], startedAt: new Date().toISOString(), ...extra });

test('the card says how many windows run at once, and when a rate limit lowered it', () => {
  assert.equal(parallelNote({ limit: 3, effective: 3, lowest: 3 }), '并行 3');
  assert.equal(parallelNote({ limit: 6, effective: 4, lowest: 4 }), '并行 4（已因限流从 6 降到 4）');
  assert.equal(parallelNote({ limit: 6, effective: 6, lowest: 3 }), '并行 6（曾因限流降到 3，已恢复）');
  assert.equal(parallelNote(null), '');
  assert.match(render(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4（已因限流从 6 降到 4）/);
  assert.doesNotMatch(render(running({ phase: 'transcribe', parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4/, 'only while the text steps run');
  inLanguage('en', () => {
    const page = render(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } }));
    assert.match(page, /4 in parallel \(lowered from 6 because of rate limits\)/);
    assert.doesNotMatch(page, HAN);
  });
});

test('a recording resumed from a saved transcript says so on its card (#209)', () => {
  assert.equal(reuseNote({ transcribe: { done: 2, total: 2, reused: 2 } }), '复用已保存的转写，没有向转写服务发请求');
  assert.equal(reuseNote({ transcribe: { done: 3, total: 3, reused: 1 } }), '复用已保存的转写 1/3 段，其余 2 段重新转写');
  assert.equal(reuseNote({ transcribe: { done: 2, total: 2, reused: 0 } }), '');
  assert.match(render(running({ steps: { transcribe: { done: 2, total: 2, reused: 2 }, proofread: { done: 1, total: 6 } } })), /复用已保存的转写，没有向转写服务发请求/);
  inLanguage('en', () => {
    const page = render(running({ steps: { transcribe: { done: 2, total: 2, reused: 2 }, proofread: { done: 1, total: 6 } } }));
    assert.match(page, /Reused the saved transcript; nothing was sent to the transcription provider/);
    assert.doesNotMatch(page, HAN);
  });
});

const emptyCount = { requests: 0, success: 0, failures: 0, limited: 0, inputTokens: 0, outputTokens: 0, outputUnknown: 0, audioSeconds: 0 };
const usage = { providers: ['free', 'siliconflow', 'groq', 'paid'].map(tier => ({ tier, configured: tier === 'free', today: { ...emptyCount, requests: tier === 'free' ? 3 : 0 }, total: emptyCount, models: [],
  ...(tier === 'free' ? { quotaDay: { timeZone: 'America/Los_Angeles', day: '2026-10-04', resetTime: '15:00', resetsAt: 0 } } : {}) })),
  trend: [{ date: '2026-10-05', free: 3, groq: 0, paid: 0, siliconflow: 0 }], timings: [], other: { today: { ...emptyCount, requests: 2 }, total: { ...emptyCount, requests: 5 } } };
const keySet = { set: true, hint: '••••1234' }, settings = { freeKey: keySet, siliconflowKey: { set: false }, groqKey: { set: false }, paidKey: { set: false }, dailyLimits: {}, proofreadReasoning: 'default', translateReasoning: 'low' };

test('the usage console keeps the Pacific quota day apart from the local day, with the reset in local time (#210)', () => {
  const page = renderToStaticMarkup(React.createElement(AudioDashboardView, { data: usage, settings, busy: false, refresh: noop, save: noop }));
  assert.match(page, /额度按太平洋时间每天 0 点重置（本地时间 15:00）· 当前额度日 2026-10-04/);
  assert.match(page, /按你所在时区的日期/);
  assert.doesNotMatch(page, /今日按太平洋时间/);
  assert.match(page, /其他（未归类的服务或密钥）：今日 2 次请求，累计 5 次/);
  inLanguage('en', () => {
    const english = renderToStaticMarkup(React.createElement(AudioDashboardView, { data: usage, settings, busy: false, refresh: noop, save: noop }));
    assert.match(english, /resets every day at 00:00 Pacific time \(15:00 your local time\)/);
    assert.doesNotMatch(english, HAN);
  });
});
