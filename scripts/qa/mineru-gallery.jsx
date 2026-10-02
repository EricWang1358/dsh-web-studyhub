/* MinerU conversion gallery (QA only): every state of the settings section, the import route panel, the local setup panel and
   the job card, with fixed props (no backend), built and screenshotted by scripts/qa/mineru-shots.mjs.
   Query: ?lang=zh|en&theme=dark|light&scene=settings|route|local|jobs */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/style.css';
import { setUiLanguage } from '../../ui/i18n.js';
import MineruSettings, { LocalMineruPanel } from '../../ui/MineruSettings.jsx';
import MineruRoute from '../../ui/MineruRoute.jsx';
import { PdfConvertJobs } from '../../ui/PdfConvertJob.jsx';
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
const est = { basic: 1.6, standard: 2.5 };
const local = {
  missing: { state: 'not-installed', next: 'install' },
  needs: { state: 'needs-models', next: 'download-models', tier: 'flash', modelsMbByTier: { basic: 800, standard: 1200 }, estimates: est },
  stopped: { state: 'server-stopped', next: 'start-server', tier: 'basic', version: '4.0.10', estimates: est },
  ready: { state: 'ready', next: null, tier: 'basic', version: '4.0.10', estimates: est, windowPages: 50 },
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

function Section({ title, children }) { return <section className="g-section"><h2>{title}</h2>{children}</section>; }
const noop = () => {};

function Scene() {
  if (scene === 'settings') return <main><div className="page gallery">
    <Section title="No token · no local mineru"><MineruSettings call={call} initialSettings={unset} initialLocal={local.missing} /></Section>
    <Section title="Token saved · local ready"><MineruSettings call={call} initialSettings={saved} initialLocal={local.ready} /></Section>
  </div></main>;
  if (scene === 'local') return <main><div className="page gallery">
    {Object.entries({ 'Not installed': local.missing, 'Needs models': local.needs, 'Download running': local.running, 'Service stopped': local.stopped, 'Ready': local.ready }).map(([title, status]) =>
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
