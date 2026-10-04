/* Wave 1 · WP-C QA page (built by scripts/qa/wave1-c.mjs): the real mailbox, audio job rows, dashboard empty state and
   graph error state with fake data, plus the feedback primitives. Query: ?lang=zh|en&theme=dark|light&scene=inbox|inbox-empty|audio|dashboard|graph|primitives|livejob */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage } from '../../ui/i18n.js';
import Inbox from '../../ui/Inbox.jsx';
import { AudioJobs } from '../../ui/AudioImport.jsx';
import Dashboard from '../../ui/Dashboard.jsx';
import Graph from '../../ui/Graph.jsx';
import {
  Badge, Chip, CrashFallback, ErrorState, Hint, JobRow, LoadingState, ProgressBar, StackedBar,
} from '../../ui/components/index.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'inbox';
setUiLanguage(lang);
const t = (zh, en) => lang === 'en' ? en : zh;
const now = Date.now();
const ago = ms => new Date(now - ms).toISOString();

const style = document.createElement('style');
style.textContent = styleCss + `
  html, body, #root { height: 100%; margin: 0; }
  .qa-bar { display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line-soft); }
  .qa-body { padding: 16px; display: grid; gap: 14px; }
  .qa-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
`;
document.head.appendChild(style);

const letters = [
  { id: 'm1', kind: 'pdf-failed', label: t('PDF 转换未完成', 'PDF conversion did not finish'), prompt: 'Platform Engineering Lecture 05.pdf', deckTitle: t('PDF 转换', 'PDF conversion'),
    detail: t('MinerU 令牌已过期：请到设置里换一个令牌。', 'The MinerU token has expired: replace it in Settings.'), at: ago(4 * 60000), read: false },
  { id: 'm2', kind: 'pdf-result', label: t('PDF 转换完成', 'PDF conversion finished'), prompt: 'Software Design Patterns.pdf', deckTitle: t('PDF 转换', 'PDF conversion'), detail: '', at: ago(3 * 3600000), read: true },
  { id: 'm3', kind: 'audio-proofread-warning', label: t('录音校对部分未完成', 'Recording proofreading partially incomplete'), prompt: 'lecture-week4.mp3', deckTitle: t('音频转写', 'Audio transcription'),
    detail: t('第 2 段校对失败，已保留转写原文。', 'Part 2 could not be proofread; the transcript is kept as it was.'), at: ago(26 * 3600000), read: false },
  { id: 'm4', kind: 'improve', label: t('质量提升', 'Quality improvement'), prompt: t('为什么用 Bridge 分离报表与渲染器？', 'Why use Bridge to separate reports and renderers?'),
    deckTitle: t('设计模式', 'Design patterns'), detail: t('补充了提示。', 'Added a hint.'), at: ago(2 * 86400000), read: true, count: 2, canRevert: true },
];
const inbox = { unread: 2, items: letters };

const job = (extra = {}) => ({ type: 'audio-import', id: 'j', status: 'running', filename: 'lecture-week4.mp3', phase: 'proofread', done: 1, total: 5, minutes: 47.8,
  startedAt: ago(3 * 60000), steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 5 } }, pace: { proofread: { at: now - 10000, each: 40000 } }, warnings: [], tasks: [], ...extra });
const audioJobs = [
  job(),
  job({ id: 'f', status: 'failed', filename: 'lecture-week5.mp3', phase: 'translate', stage: t('翻译第 1/8 部分失败：服务暂时不可用', 'Translation of part 1/8 failed: the service is temporarily unavailable'),
    retryable: true, finishedAt: ago(60000), steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 5, total: 5 }, translate: { done: 0, total: 8 } } }),
  job({ id: 'c', status: 'complete', filename: 'lecture-week3.mp3', phase: 'done', sourceIds: ['s1'], corrected: 4, finishedAt: ago(30000) }),
];

const emptyStats = { generatedAt: new Date(now).toISOString(), today: new Date(now).toISOString().slice(0, 10), totals: { attempts: 0, activeDays: 0, streak: 0, due: 0 },
  heatmap: [], trend: [], forecast: { days: [], later: 0 }, mastery: { windowDays: 30, minAnswers: 3, levels: [], kinds: [] }, weakTopics: [] };
const dashboardCall = async action => { if (action === 'stats') return emptyStats; throw new Error('no data'); };
const graphCall = async () => { throw new Error(t('连接中断，请稍后再试', 'The connection was interrupted. Try again in a moment.')); };

/* A running job whose elapsed text ticks every 100 ms: the hidden status node must not change. */
function LiveJob() {
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState('running');
  const [stage, setStage] = useState('transcribe');
  useEffect(() => {
    window.__liveJob = { setStatus, setStage };
    const timer = setInterval(() => setTick(value => value + 1), 100);
    return () => clearInterval(timer);
  }, []);
  return <JobRow status={status} stage={stage} title="lecture.mp3" meta={`${status} · ${tick}`}
    progress={{ value: tick % 100, max: 100, label: 'lecture.mp3' }} />;
}

function Primitives() {
  return <div className="qa-body">
    <div className="qa-row">{['neutral', 'info', 'success', 'warning', 'error', 'accent'].map(tone => <Badge key={tone} tone={tone} icon={tone !== 'neutral' && tone !== 'accent'}>{tone}</Badge>)}</div>
    <div className="qa-row">{['neutral', 'info', 'success', 'warning', 'error', 'accent'].map(tone => <Badge key={tone} tone={tone} size="sm" dot>{tone}</Badge>)}</div>
    <div className="qa-row"><Chip onClick={() => {}} selected>{t('第一章', 'Chapter 1')}</Chip><Chip onClick={() => {}}>{t('第二章', 'Chapter 2')}</Chip><Chip onRemove={() => {}} removeLabel="x">{t('可移除', 'Removable')}</Chip></div>
    <Hint>{t('这是一条小号灰色说明。', 'A small muted note.')}</Hint>
    <Hint size="xs" tone="warning">{t('更小的提示。', 'A smaller hint.')}</Hint>
    <ProgressBar value={35} label="a" /><ProgressBar value={60} ahead={15} label="b" size="sm" /><ProgressBar indeterminate label="c" />
    <StackedBar label={t('掌握程度', 'Mastery')} legend segments={[{ value: 6, tone: 'success', label: t('已掌握', 'Mastered') }, { value: 3, tone: 'info', label: t('熟悉', 'Familiar') }, { value: 2, tone: 'error', label: t('薄弱', 'Weak') }]} />
    <LoadingState label={t('正在读取…', 'Reading…')} />
    <ErrorState error={t('读取失败', 'Read failed')} onRetry={() => {}} />
    <CrashFallback error={new Error('TypeError: x is undefined')} onRetry={() => {}} />
    <JobRow status="partial" title="draft" meta="9/12" failure={{ title: t('部分题目没通过审阅', 'Some questions failed review'), hint: t('已保存通过的题。', 'Passing questions are saved.') }} onDismiss={() => {}} />
  </div>;
}

const scenes = {
  inbox: () => <><div className="qa-bar"><Inbox inbox={inbox} onOpen={() => {}} onReadAll={() => {}} onUndo={() => {}} defaultOpen /></div></>,
  'inbox-empty': () => <><div className="qa-bar"><Inbox inbox={{ unread: 0, items: [] }} onOpen={() => {}} onReadAll={() => {}} defaultOpen /></div></>,
  audio: () => <div className="qa-body"><AudioJobs data={{ jobs: audioJobs }} busy={false} act={() => {}} openAgent={() => {}} onOpenSources={() => {}} /></div>,
  dashboard: () => <Dashboard call={dashboardCall} data={{ root: 'qa', decks: [], drafts: [], focus: { courses: [] } }} busy={false} onStartScope={() => {}} onLibrary={() => {}} onCreate={() => {}} onSources={() => {}} />,
  graph: () => <div className="page"><Graph call={graphCall} library={{ root: 'qa', focus: { courses: [] } }} onClose={() => {}} /></div>,
  primitives: () => <Primitives />,
  livejob: () => <div className="qa-body"><LiveJob /></div>,
};
createRoot(document.getElementById('root')).render(
  <div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'} style={{ height: '100%', overflow: 'auto' }}><main style={{ flex: 1, minWidth: 0 }}>{(scenes[scene] || scenes.inbox)()}</main></div>,
);
