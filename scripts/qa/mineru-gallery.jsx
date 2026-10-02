/* MinerU conversion gallery (QA only): every state of the settings section, the import route panel, the local setup panel and
   the job card, with fixed props (no backend), built and screenshotted by scripts/qa/mineru-shots.mjs.
   Query: ?lang=zh|en&theme=dark|light&scene=settings|route|local|jobs|history|case|flow
   scene=case&case=<key>: ONE settings section in one state (the layout matrix, measured by scripts/qa/mineru-layout.mjs);
   scene=flow: the settings section with a stand-in backend that behaves like the real service, to click through start -> set up. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/style.css';
import { setUiLanguage } from '../../ui/i18n.js';
import MineruSettings, { LocalMineruPanel } from '../../ui/MineruSettings.jsx';
import MineruRoute from '../../ui/MineruRoute.jsx';
import { PdfConvertHistory, PdfConvertJobs } from '../../ui/PdfConvertJob.jsx';
import LargeDocumentCard from '../../ui/LargeDocumentCard.jsx';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'settings';
setUiLanguage(lang);

const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { height: 100%; margin: 0; }
  .gallery { max-width: 1040px; margin: 0 auto; padding: 24px 28px 96px; }
  .g-section { padding: 24px 0; border-top: 1px solid var(--line-soft); }
  .g-section > h2 { margin: 0 0 14px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
  @container study (max-width: 640px) { .gallery { padding: 16px 12px 72px; } }`;
document.head.appendChild(style);

const call = async () => ({});
const TOKEN_HINT = '••••sig-';
const unset = { token: { set: false, hint: '' }, acknowledged: false, docsUrl: 'https://mineru.net/apiManage/docs', settingsFile: 'C:\\Users\\student\\.dsh\\study\\mineru.json' };
const saved = { token: { set: true, hint: TOKEN_HINT, source: 'file' }, acknowledged: true, docsUrl: unset.docsUrl, settingsFile: unset.settingsFile };
// The owner's state: a token saved (shown only as its last four characters), the privacy box not ticked yet.
const savedOnly = { ...saved, token: { set: true, hint: '••••aBQb', source: 'file' }, acknowledged: false };
const est = { basic: 1.6, standard: 2.5 };
const local = {
  missing: { state: 'not-installed', next: 'install' },
  needs: { state: 'needs-models', next: 'download-models', tier: 'flash', modelsMbByTier: { basic: 800, standard: 1200 }, estimates: est },
  stopped: { state: 'server-stopped', next: 'start-server', tier: 'basic', version: '4.0.10', estimates: est },
  ready: { state: 'ready', next: null, tier: 'basic', version: '4.0.10', estimates: est, windowPages: 50 },
  // What the real CLI gives while its service is stopped: only the version (the settings live in the service).
  stoppedBlind: { state: 'server-stopped', next: 'start-server', version: '4.0.10', running: false, tier: '', mode: '', modelsDownloaded: null, estimates: est },
  unknown: { state: 'unknown', next: 'recheck', version: '4.0.10', running: true, estimates: est },
  running: { state: 'needs-models', next: 'download-models', tier: 'flash', modelsMbByTier: { basic: 800, standard: 1200 }, estimates: est,
    setup: { status: 'running', step: 'download', tier: 'basic', modelsMb: 800, lastLine: 'Downloading basic/layout.onnx … 312 MB', startedAt: new Date(Date.now() - 95_000).toISOString() } },
};
const plan = {
  name: 'Operating Systems.pdf', pages: 422, bytes: 96 * 1024 * 1024, byChapters: true, maySplitFurther: false,
  pieces: [[1, 118], [119, 281], [282, 422]].map(([startPage, endPage], i) => ({ index: i + 1, startPage, endPage, pages: endPage - startPage + 1 })),
  windows: Array.from({ length: 9 }, (_, i) => ({ index: i + 1, startPage: i * 50 + 1, endPage: Math.min(422, i * 50 + 50), pages: Math.min(50, 422 - i * 50) })),
};
const file = { name: 'Operating Systems.pdf', size: 96 * 1024 * 1024 };
const job = (extra = {}) => ({ id: `j${Math.random()}`, type: 'pdf-convert', route: 'cloud', filename: 'Operating Systems.pdf', status: 'running', phase: 'parse', done: 211, total: 422,
  chunk: { index: 2, count: 3 }, chunks: [{ index: 1, startPage: 1, endPage: 118, pages: 118, state: 'done' }, { index: 2, startPage: 119, endPage: 281, pages: 163, state: 'parsing' }, { index: 3, startPage: 282, endPage: 422, pages: 141, state: 'planned' }],
  stage: '第 2/3 段 · 正在解析', warnings: [], note: '', startedAt: new Date(Date.now() - 185_000).toISOString(), ...extra });

/* The 解析历史: every state of a row (complete, local, failed, interrupted, cancelled, running, document deleted, a very long name), many days, the
   confirm to clear, the empty state, and the panel the "用 MinerU 解析" link opens. Fixed records, a fixed clock. */
const HOUR = 3_600_000, NOW = Date.now(), MB = 1024 * 1024;
let recordNumber = 0;
const ago = hours => new Date(NOW - hours * HOUR).toISOString();
const row = (extra = {}) => { const started = extra.hours ?? 0.2; const { hours, ...rest } = extra; return { id: `job-${String(++recordNumber).padStart(4, '0')}`, version: 1, filename: 'Operating Systems.pdf', bytes: 96 * MB, pages: 422, pieces: 3,
  route: 'cloud', status: 'complete', phase: 'done', pagesDone: 422, attempts: 1, elapsedMs: 260_000, startedAt: ago(started + 0.08), finishedAt: ago(started), importedPages: 420, skippedPages: 2,
  documentId: 'document-a-json', title: 'Operating Systems', canRetry: false, live: false, document: { exists: true, title: 'Operating Systems', pages: 420, sourceIds: ['s1'] }, ...rest }; };
const gone = { documentId: undefined, importedPages: undefined, skippedPages: undefined, document: undefined };
const historyRows = () => [
  row({ hours: 0.05, status: 'running', phase: 'parse', finishedAt: undefined, elapsedMs: 0, pagesDone: 211, live: true, ...gone, filename: 'Databases Lecture Notes.pdf', pages: 330, bytes: 18 * MB }),
  row({ hours: 0.3 }),
  row({ hours: 0.9, route: 'local', tier: 'basic', filename: 'Algorithms.pdf', pages: 120, pieces: 3, bytes: 7 * MB, elapsedMs: 310_000, importedPages: 120, skippedPages: 0, document: { exists: true, title: 'Algorithms', pages: 120, sourceIds: ['s2'] } }),
  row({ hours: 2.5, status: 'failed', phase: 'parse', pagesDone: 200, elapsedMs: 600_000, ...gone, canRetry: true, failure: { stage: 'parse', piece: 2, reason: 'MinerU 没能转换这一段文件（可能是文件受保护或内容异常）。' } }),
  row({ hours: 3, status: 'failed', phase: 'upload', pagesDone: 0, elapsedMs: 4000, ...gone, canRetry: false, failure: { stage: 'upload', reason: '连不上 MinerU：请检查网络后重试（已完成的部分会保留）。' }, filename: 'Networks.pdf', pages: 88 }),
  row({ hours: 4, status: 'failed', route: 'local', tier: 'basic', phase: 'local', pagesDone: 50, elapsedMs: 130_000, ...gone, canRetry: true, filename: 'Compilers.pdf', pages: 120, failure: { stage: 'local', piece: 2, code: 'server-stopped', reason: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。' } }),
  row({ hours: 5, status: 'failed', phase: 'parse', pagesDone: 0, elapsedMs: 3000, ...gone, canRetry: true, failure: { stage: 'parse', code: 'invalid-token', reason: 'MinerU 令牌无效：请到「设置 › MinerU 云端解析」重新粘贴一个有效的令牌。' }, filename: 'Security.pdf' }),
  row({ hours: 7, status: 'interrupted', phase: 'parse', finishedAt: undefined, elapsedMs: 0, pagesDone: 200, ...gone, canRetry: true, filename: 'Distributed Systems.pdf' }),
  row({ hours: 8, status: 'interrupted', phase: 'parse', finishedAt: undefined, elapsedMs: 0, pagesDone: 0, ...gone, canRetry: false, filename: 'Old Notes.pdf', pages: 40 }),
  row({ hours: 10, status: 'cancelled', phase: 'parse', pagesDone: 118, elapsedMs: 90_000, ...gone, filename: 'Machine Learning.pdf' }),
  row({ hours: 26, document: { exists: false, title: 'Gone', pages: 0, sourceIds: [] }, filename: 'A very long file name that keeps going and going so that the row has to wrap somewhere sensible 2026 final FINAL (copy 3).pdf', elapsedMs: 4_000_000 }),
  ...Array.from({ length: 12 }, (_, index) => row({ hours: 30 + index * 20, filename: `Chapter pack ${index + 1}.pdf`, route: index % 3 ? 'cloud' : 'local', tier: index % 3 ? undefined : 'standard', elapsedMs: 60_000 + index * 37_000 })),
];
const noFetch = async () => ({ records: [] });

function Section({ title, children }) { return <section className="g-section"><h2>{title}</h2>{children}</section>; }
const noop = () => {};

/* The layout matrix: [cloud settings, local status, what to click first]. */
const CASES = {
  'none-missing': [unset, local.missing],
  'saved-stopped': [savedOnly, local.stoppedBlind],
  'ack-needs': [saved, local.needs],
  'ack-needs-standard': [saved, local.needs, 'input[name="mineru-tier"][value="standard"]'],
  'ack-needs-confirm': [saved, local.needs, 'button.sh-btn--primary'],
  'ack-ready': [saved, local.ready],
  'saved-running': [savedOnly, local.running],
  'ack-unknown': [saved, local.unknown],
};

/* A stand-in for the service the panel talks to: the same answers the real one gives (see lib/contexts/audio/convert.js),
   including "stopped: nothing about the settings is known until it is started". */
function flowCall() {
  const world = { running: false };
  return async action => {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (action === 'mineru.settings.get') return savedOnly;
    if (action === 'mineru.local.status') return world.running ? local.needs : local.stoppedBlind;
    if (action === 'mineru.local.start') { world.running = true; return local.needs; }
    return {};
  };
}

function Scene() {
  if (scene === 'case') {
    const [settings, status] = CASES[params.get('case')] || CASES['none-missing'];
    return <main><div className="page gallery"><MineruSettings call={call} initialSettings={settings} initialLocal={status} /></div></main>;
  }
  if (scene === 'flow') return <main><div className="page gallery"><MineruSettings call={flowCall()} /></div></main>;
  if (scene === 'history') return <main><div className="page gallery">
    <Section title="Many rows, every state (10 shown, the rest behind 显示更多)"><PdfConvertHistory call={noFetch} initialRecords={historyRows()} now={NOW} onOpenSources={noop} onOpenSettings={noop} /></Section>
    <Section title="All shown"><PdfConvertHistory call={noFetch} initialRecords={historyRows()} initialShown={40} now={NOW} onOpenSources={noop} /></Section>
    <Section title="Asking before clearing"><PdfConvertHistory call={noFetch} initialRecords={historyRows().slice(1, 5)} initialConfirmClear now={NOW} onOpenSources={noop} /></Section>
    <Section title="Empty"><PdfConvertHistory call={noFetch} initialRecords={[]} now={NOW} /></Section>
    <Section title="Inside the MinerU panel (opened from 用 MinerU 解析), cloud not set up"><MineruRoute call={call} onFile={noop} initialSettings={unset} initialLocal={local.missing} initialHistory={historyRows().slice(0, 4)} historyNow={NOW} historyOpen onOpenSources={noop} /></Section>
    <Section title="Inside the MinerU panel, a PDF chosen, local ready"><MineruRoute file={file} call={call} initialSettings={unset} initialLocal={local.ready} initialPlan={plan} initialHistory={historyRows().slice(1, 3)} historyNow={NOW} historyOpen onOpenSources={noop} /></Section>
  </div></main>;
  if (scene === 'settings') return <main><div className="page gallery">
    <Section title="No token · no local mineru"><MineruSettings call={call} initialSettings={unset} initialLocal={local.missing} /></Section>
    <Section title="Token saved · local ready"><MineruSettings call={call} initialSettings={saved} initialLocal={local.ready} /></Section>
    <Section title="Token saved (owner) · local service stopped"><MineruSettings call={call} initialSettings={savedOnly} initialLocal={local.stoppedBlind} /></Section>
  </div></main>;
  if (scene === 'local') return <main><div className="page gallery">
    {Object.entries({ 'Not installed': local.missing, 'Needs models': local.needs, 'Download running': local.running, 'Service stopped (settings known)': local.stopped, 'Service stopped (settings unknown, as the real CLI)': local.stoppedBlind, 'Settings unreadable': local.unknown, 'Ready': local.ready }).map(([title, status]) =>
      <Section key={title} title={title}><LocalMineruPanel call={call} status={status} onStatus={noop} /></Section>)}
    <Section title="Confirming the download"><LocalMineruPanel call={call} status={local.needs} onStatus={noop} initialConfirm /></Section>
  </div></main>;
  if (scene === 'route') return <main><div className="page gallery">
    <Section title="Neither route set up (setup gate)"><MineruRoute file={file} call={call} initialSettings={unset} initialLocal={local.missing} initialPlan={plan} onOpenSettings={noop} /></Section>
    <Section title="Token saved, privacy not confirmed yet"><MineruRoute file={file} call={call} initialSettings={{ ...saved, acknowledged: false }} initialLocal={local.missing} initialPlan={plan} /></Section>
    <Section title="Local ready (default)"><MineruRoute file={file} call={call} initialSettings={unset} initialLocal={local.ready} initialPlan={plan} /></Section>
    <Section title="Local needs setup, cloud chosen"><MineruRoute file={file} call={call} initialSettings={saved} initialLocal={local.needs} initialPlan={plan} initialAcknowledged /></Section>
    <Section title="No file yet"><MineruRoute call={call} onFile={noop} initialSettings={saved} initialLocal={local.ready} /></Section>
    <Section title="Inside the large-textbook card"><LargeDocumentCard reason="pdf-pages" detail={{ name: 'Operating Systems.pdf', file }} retrieval={null} call={call} courseNames={[]} /></Section>
  </div></main>;
  return <main><div className="page gallery">
    <Section title="Cloud: running piece 2 of 3"><PdfConvertJobs call={call} jobs={[job()]} /></Section>
    <Section title="Local: window 3 of 9 (no fake percentage inside a window)"><PdfConvertJobs call={call} jobs={[job({ route: 'local', phase: 'local', done: 100, total: 422, chunk: { index: 3, count: 9 }, stage: '第 3/9 段 · 正在本地解析',
      chunks: Array.from({ length: 9 }, (_, i) => ({ index: i + 1, startPage: i * 50 + 1, endPage: Math.min(422, i * 50 + 50), pages: 50, state: i < 2 ? 'done' : 'planned' })) })]} /></Section>
    <Section title="Slow queue (honest note, not a failure)"><PdfConvertJobs call={call} jobs={[job({ note: 'MinerU 云端正在排队，比平时慢（可能是今天的高优先额度用完了）。这不是失败，会自动继续。', phase: 'parse' })]} /></Section>
    <Section title="Failed (network) · resume"><PdfConvertJobs call={call} jobs={[job({ status: 'failed', retryable: true, errorCode: 'network', stage: '连不上 MinerU：请检查网络后重试（已完成的部分会保留）。', finishedAt: new Date().toISOString() })]} /></Section>
    <Section title="Failed: local service stopped"><PdfConvertJobs call={call} jobs={[job({ route: 'local', status: 'failed', retryable: true, errorCode: 'server-stopped', phase: 'local', stage: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。', finishedAt: new Date().toISOString() })]} /></Section>
    <Section title="Failed: token"><PdfConvertJobs call={call} onOpenSettings={noop} jobs={[job({ status: 'failed', retryable: true, errorCode: 'invalid-token', stage: 'MinerU 令牌无效：请到「设置 › MinerU 云端解析」重新粘贴一个有效的令牌。', finishedAt: new Date().toISOString() })]} /></Section>
    <Section title="Cancelled · complete"><PdfConvertJobs call={call} onOpenSources={noop} jobs={[job({ status: 'cancelled', stage: '已取消；已解析好的段落会保留，再导入同一个文件不会重复解析', finishedAt: new Date().toISOString() }),
      job({ status: 'complete', phase: 'done', done: 422, sourceIds: Array.from({ length: 422 }, (_, i) => `s${i}`), finishedAt: new Date().toISOString(), warnings: ['Pages 12, 45 have no text in the converted output (pictures or blank pages) and were skipped.'] })]} /></Section>
  </div></main>;
}

createRoot(document.getElementById('root')).render(<div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'}><Scene /></div>);
