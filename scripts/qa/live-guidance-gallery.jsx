/* The live class page with the owner's class of 2026-11-04 (QA only), built and screenshotted by scripts/qa/live-guidance-shots.mjs.
   Query: ?lang=zh|en&theme=light|dark&scene=running|ended
   A Chinese lecture whose every polish batch timed out: one 2,000-character "sentence" that was skipped, a few short ones, a polished one, an English one
   with its translation, a growing grey line, an error and the retry. The page is driven only through its own buttons (开始实录 / 打开), so the same gallery
   builds against an older copy of ui/ for the "before" shots. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage } from '../../ui/i18n.js';
import LiveClass from '../../ui/LiveClass.jsx';
import { StudyServicesContext } from '../../ui/study-context.jsx';
import { AppContext } from '../../ui/app/app-context.js';
import { fakeApp } from '../../tests/helpers/fake-app.mjs';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const scene = params.get('scene') === 'ended' ? 'ended' : 'running';
setUiLanguage(lang);

const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { min-height: 100%; margin: 0; }
  .gallery { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
  @media (max-width: 480px) { .gallery { padding: 16px 16px 48px; } }`;
document.head.appendChild(style);

// What the recogniser wrote: a space between every word, half-width punctuation.
const LONG = '今天 我们 讲 数据库 的 分区 和 索引 ,分区 可以 减少 查询 需要 读取 的 数据量 ,索引 则 帮助 优化器 快速 定位 记录 .'.repeat(26);
const seg = (id, en, extra = {}) => ({ id, t: id * 21_000, en, zh: '', zhState: 'none', ...extra });
const SEGMENTS = [
  seg(1, LONG),
  seg(2, '好 ,我们 先 看 一下 分区 表 的 创建 语句 .'),
  seg(3, '这里 的 范围 分区 按 日期 切分 ,每 个 月 一个 分区 .', { correctedAt: '2026-11-04T05:10:00.000Z', originalEn: '这里 的 范围 分区 按 日期 切分 ,每 个 月 一个 患者 .', correctionReason: '「患者」应为「分区」' }),
  seg(4, 'A partition lets the optimizer skip data it does not need.', { zh: '分区让优化器跳过不需要的数据。', zhState: 'done' }),
  seg(5, '索引 也 是 一样 ,先 看 它 的 选择性 .'),
  seg(6, 'An index is only useful when it is selective.', { zhState: 'error' }),
  seg(7, 'So the leftmost prefix rule matters.', { zhState: 'pending' }),
];
const INTERIM = '那 接下来 我们 看 一下 复合 索引 的 最左 前缀 原则 ,也 就是 说 查询 条件 要';
const correction = {
  enabled: true, running: false, covered: 3, coveredThrough: 7, pending: 0, calls: 6, cacheHits: 0, usage: null,
  error: '有 1 句太长，润色超时，已跳过（原文保留）；可点『重试待校正内容』再试。', warnings: ['第 2 条笔记没有引用，已丢弃'],
  skipped: 1, skippedIds: [1], skippedItems: [{ id: 1, reason: '润色超时' }], memory: { text: '', refs: [] }, notes: [], background: { running: false, pending: 0, failed: 0, tasks: [] },
};
// After the class: the polish stopped because the model's reply format was wrong, with sentences it never reached.
const pausedCorrection = { ...correction, covered: 3, coveredThrough: 5, pending: 2, paused: 'format', error: '润色模型的回复格式不对，已暂停自动重试。可以到音频设置换一个文字模型，再点重试。' };
const snapshot = () => ({
  id: 'class-0001', title: '数据库 · 分区与索引', course: '数据库', engine: 'gemini', status: scene === 'ended' ? 'ended' : 'live', archivedAt: null, message: '',
  startedAt: '2026-11-04T05:00:00.000Z', tier: 'free', elapsedMs: 152_000, revision: 9, total: SEGMENTS.length, interim: scene === 'ended' ? '' : INTERIM, translating: 0, generatedIds: [],
  warnings: [], usage: { freeSeconds: 152, paidSeconds: 0, estimatedPaidUsd: 0 }, segments: SEGMENTS, correction: scene === 'ended' ? pausedCorrection : correction,
  // Fresh every call: the monitor reads how old the last sound is.
  inputAudio: { source: 'system', phase: scene === 'ended' ? 'stopped' : 'running', label: '电脑系统声音', level: 58, peak: 0.4, capturedMs: 152_000, acceptedMs: 150_000, frameAgeMs: 120, soundAgeMs: 200, ackAgeMs: 300 },
});
const readiness = { providers: { free: true, siliconflow: false, groq: false, paid: false }, transcription: true, textProvider: 'host', liveChoice: 'auto', live: true, liveProvider: 'gemini',
  liveLocal: { supported: false, ready: false }, liveLoopback: { supported: true, ready: true } };
const listed = [{ id: 'class-0001', title: '数据库 · 分区与索引', startedAt: '2026-11-04T05:00:00.000Z', elapsedMs: 152_000, segments: SEGMENTS.length, active: scene !== 'ended' }];

async function call(action) {
  if (action === 'audio.preflight') return readiness;
  if (action === 'live.list') return { sessions: listed };
  if (action === 'live.start' || action === 'live.get' || action === 'live.poll') return snapshot();
  return {};
}
const services = { call, act: async (action, args) => call(action, args), busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {} };
const data = { root: '/library', focus: { course: '数据库', courses: ['数据库'] } };

createRoot(document.getElementById('root')).render(<div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'}>
  <StudyServicesContext.Provider value={services}><main className="gallery"><AppContext.Provider value={fakeApp({ data, call })}>
    <LiveClass call={call} data={data} visible onSettings={() => {}} onSources={() => {}} initialReadiness={readiness} initialKind="system" />
  </AppContext.Provider></main></StudyServicesContext.Provider></div>);
