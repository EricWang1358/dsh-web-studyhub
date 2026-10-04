/* Wave 1 · WP-E QA page (built by scripts/qa/wave1-e.mjs): the MinerU settings (token form on SecretKeyForm), the audio job rows,
   the mailbox opened from the keyboard, and the exam error state, with fake data.
   Query: ?lang=zh|en&theme=dark|light&scene=mineru|audio|inbox|exam */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage } from '../../ui/i18n.js';
import Inbox from '../../ui/Inbox.jsx';
import { AudioJobs } from '../../ui/AudioImport.jsx';
import MineruSettings from '../../ui/MineruSettings.jsx';
import Exam from '../../ui/Exam.jsx';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'mineru';
setUiLanguage(lang);
const t = (zh, en) => (lang === 'en' ? en : zh);
const now = Date.now();
const ago = ms => new Date(now - ms).toISOString();

const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { height: 100%; margin: 0; }
  .qa-bar { display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line-soft); }
  .qa-body { padding: 16px; display: grid; gap: 14px; }
`;
document.head.appendChild(style);

const letters = [
  { id: 'm1', kind: 'pdf-failed', label: t('PDF 转换未完成', 'PDF conversion did not finish'), prompt: 'Platform Engineering Lecture 05.pdf', deckTitle: t('PDF 转换', 'PDF conversion'),
    detail: t('MinerU 令牌已过期：请到设置里换一个令牌。', 'The MinerU token has expired: replace it in Settings.'), at: ago(61000), read: false },
  { id: 'm2', kind: 'pdf-result', label: t('PDF 转换完成', 'PDF conversion finished'), prompt: 'Software Design Patterns.pdf', deckTitle: t('PDF 转换', 'PDF conversion'), detail: '', at: ago(70 * 60000), read: true },
  { id: 'm3', kind: 'audio-proofread-warning', label: t('录音校对部分未完成', 'Recording proofreading partially incomplete'), prompt: 'lecture-week4.mp3', deckTitle: t('音频转写', 'Audio transcription'),
    detail: '', at: ago(26 * 3600000), read: false },
  { id: 'm4', kind: 'improve', label: t('质量提升', 'Quality improvement'), prompt: t('为什么用 Bridge 分离报表与渲染器？', 'Why use Bridge to separate reports and renderers?'),
    deckTitle: t('设计模式', 'Design patterns'), detail: '', at: ago(2 * 86400000), read: true, count: 2, canRevert: true },
];

const job = (extra = {}) => ({ type: 'audio-import', id: 'j', status: 'running', filename: 'lecture-week4.mp3', phase: 'proofread', done: 1, total: 5, minutes: 47.8,
  startedAt: ago(3 * 60000), steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 5 } }, pace: { proofread: { at: now - 10000, each: 40000 } }, warnings: [], tasks: [], ...extra });
const audioJobs = [
  job(),
  job({ id: 'f', status: 'failed', filename: 'lecture-week5.mp3', phase: 'translate', stage: t('翻译第 1/8 部分失败：服务暂时不可用', 'Translation of part 1/8 failed: the service is temporarily unavailable'),
    retryable: true, finishedAt: ago(60000), steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 5, total: 5 }, translate: { done: 0, total: 8 } } }),
  job({ id: 'c', status: 'complete', filename: 'lecture-week3.mp3', phase: 'done', sourceIds: ['s1'], corrected: 4, finishedAt: ago(30000) }),
];

const settings = { token: { set: true, hint: '••••a9f2', source: 'file' }, acknowledged: true, docsUrl: 'https://mineru.net/apiManage/docs', settingsFile: 'C:\\Users\\qa\\.mineru\\settings.json' };
const local = { state: 'ready', next: null, tier: 'basic', version: '4.0.10', estimates: { basic: 1.6, standard: 2.5 } };
const call = async () => ({ ok: true, state: 'valid' });

const exam = { root: 'qa-e', decks: [{ id: 'd1', title: t('设计模式', 'Design patterns'), course: 'SWE5001', examCount: 12, examQuizCount: 8, examMultiCount: 4, available: 12 }],
  focus: { course: 'SWE5001', courses: [{ name: 'SWE5001' }], mode: 'study' }, runs: [] };
const examCall = async action => { if (action === 'review.get') throw new Error(t('找不到这场笔试', 'That exam could not be found')); return {}; };

const scenes = {
  mineru: () => <div className="qa-body"><MineruSettings call={call} initialSettings={settings} initialLocal={local} /></div>,
  audio: () => <div className="qa-body"><AudioJobs data={{ jobs: audioJobs }} busy={false} act={() => {}} openAgent={() => {}} onOpenSources={() => {}} /></div>,
  inbox: () => <div className="qa-bar"><Inbox inbox={{ unread: 2, items: letters }} onOpen={() => {}} onReadAll={() => {}} onUndo={() => {}} /></div>,
  exam: () => <Exam call={examCall} data={exam} initialRunId="missing" onExit={() => {}} onCreate={() => {}} onCreateCase={() => {}} onStartRun={() => {}} />,
};
createRoot(document.getElementById('root')).render(
  <div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'} style={{ height: '100%', overflow: 'auto' }}><main style={{ flex: 1, minWidth: 0 }}>{(scenes[scene] || scenes.mineru)()}</main></div>,
);
