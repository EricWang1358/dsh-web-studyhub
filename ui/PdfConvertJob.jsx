import React, { useEffect, useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { Button } from './components/index.js';
import { pageRange, isConvertJob } from './mineru-flow.js';

/* The progress card of a PDF conversion (cloud or local). It is the audio import card's markup and classes (.job, .audio-progress,
   .audio-bar, .audio-steps), so it looks and behaves like every other background job: real progress, one stop button, a retry
   that does not redo finished pieces, a way to dismiss it. Progress is pages converted over pages in the book, never a
   guess: the cloud counts the pages MinerU reports as extracted, the local route counts finished page windows. */

const PHASE_TEXT = {
  queued: () => ui('排队中'), split: () => ui('切分'), upload: () => ui('上传'), parse: () => ui('解析'), local: () => ui('本地解析'),
  download: () => ui('下载'), merge: () => ui('合并'), save: () => ui('保存'), interrupted: () => ui('已中断'), done: () => ui('完成'),
};
const active = job => ['queued', 'running', 'cancelling'].includes(job.status);
const spent = ms => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90 ? uiFormat('{0} 秒', [seconds]) : uiFormat('{0} 分钟', [Math.round(seconds / 60)]);
};

function PdfConvertJob({ job, send, onOpenSources, onOpenSettings, onChanged }) {
  const running = active(job), [now, setNow] = useState(Date.now), [working, setWorking] = useState(''), [problem, setProblem] = useState('');
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const took = job.startedAt && job.status !== 'queued' ? (running ? now : Date.parse(job.finishedAt || job.startedAt)) - Date.parse(job.startedAt) : null;
  const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const count = job.chunk?.count || 1, index = job.chunk?.index || 0;
  const piece = count > 1 && index > 0 ? uiFormat('第 {0}/{1} 段', [index, count]) : '';
  const route = job.route === 'local' ? ui('本地') : ui('云端');
  const title = job.status === 'complete' ? uiFormat('已存为 {0} 页资料 · {1}解析', [job.sourceIds?.length ?? 0, route])
    : job.status === 'failed' ? ui('转换未完成')
      : job.status === 'cancelled' ? ui('转换已取消')
        : job.status === 'cancelling' ? ui('正在停止')
          : [PHASE_TEXT[job.phase]?.() || ui('处理中'), piece].filter(Boolean).join(' · ');
  const run = async (name, work) => {
    if (working) return;
    setWorking(name); setProblem('');
    try { await work(); onChanged?.(); } catch (error) { setProblem(uiMessage(String(error?.message || error))); } finally { setWorking(''); }
  };
  const retry = () => run('retry', async () => {
    // A stopped local service is started again first, which is the usual reason a local window failed.
    if (job.errorCode === 'server-stopped') await send('mineru.local.start', { restart: true });
    await send('mineru.retry', { jobId: job.id });
  });
  const tokenProblem = job.status === 'failed' && ['invalid-token', 'expired'].includes(job.errorCode);
  return (
    <div className={`job ${job.status}${job.leaving ? ' job-leaving' : ''}`} role="status" data-route={job.route || 'cloud'} aria-hidden={job.leaving ? 'true' : undefined} inert={job.leaving || undefined}>
      <span>{job.status === 'failed' ? '!' : job.status === 'cancelled' ? '×' : running ? '◌' : '✓'}</span>
      <div>
        <strong>{job.filename}</strong>
        <small>{title}{took !== null && (running || job.finishedAt) ? uiFormat(running ? ' · 已用 {0}' : ' · 用时 {0}', [spent(took)]) : ''}</small>
        {running && job.phase !== 'queued' && <div className="audio-progress">
          <div className="audio-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
            aria-label={uiFormat('已解析 {0}/{1} 页', [job.done, job.total])}><span style={{ width: `${percent}%` }} /></div>
          <div className="audio-progress-line">
            <strong>{percent}%</strong>
            <small>{uiFormat('已解析 {0}/{1} 页', [job.done, job.total])}</small>
          </div>
          {job.route === 'local' && count > 1 && <small className="muted">{ui('本地解析按页段推进，一段做完才会前进；一段里没有更细的进度，不是卡住了。')}</small>}
        </div>}
        {job.note && running && <small className="muted">{uiMessage(job.note)}</small>}
        {count > 1 && job.chunks?.length > 1 && job.status !== 'complete' && <ol className="audio-steps" aria-label={ui('各段状态')}>
          {job.chunks.map(chunk => <li key={chunk.index} className={chunk.state === 'done' ? 'done' : chunk.index === index && running ? 'current' : ''}>
            {chunk.state === 'done' ? '✓ ' : ''}{uiFormat('第 {0} 段 · 第 {1} 页', [chunk.index, pageRange(chunk.startPage, chunk.endPage)])}</li>)}
        </ol>}
        {job.status === 'failed' && <small className="warning">{uiMessage(job.stage)}</small>}
        {(job.warnings || []).map(warning => <small className="warning" key={warning}>{uiMessage(warning)}</small>)}
        {job.status === 'complete' && job.sourceIds?.length > 0 && onOpenSources && <Button variant="link" size="sm" onClick={() => onOpenSources(job.sourceIds)}>{ui('打开资料')}</Button>}
        {job.status === 'cancelled' && <small>{uiMessage(job.stage)}</small>}
        {['running', 'queued'].includes(job.status) && <Button size="sm" disabled={!!working} onClick={() => run('cancel', () => send('job.cancel', { jobId: job.id }))}>{ui('停止（已解析好的段落会保留）')}</Button>}
        {job.status === 'failed' && job.retryable && !tokenProblem && <Button variant="primary" size="sm" busy={working === 'retry'} disabled={!!working}
          title={ui('已完成的段落会直接复用，不会重复上传或重复解析')} onClick={retry}>
          {job.errorCode === 'server-stopped' ? ui('重新启动本地服务并接着做') : ui('接着做（不重复已完成的段落）')}</Button>}
        {tokenProblem && onOpenSettings && <Button variant="primary" size="sm" onClick={onOpenSettings}>{ui('去设置里换一个令牌')}</Button>}
        {tokenProblem && job.retryable && <Button size="sm" busy={working === 'retry'} disabled={!!working} onClick={retry}>{ui('换好令牌后接着做')}</Button>}
        {problem && <p className="job-error" role="alert">{uiFormat('没能完成：{0}', [problem])}</p>}
      </div>
      {!running && <button type="button" className="job-dismiss" disabled={!!working} onClick={() => void run('dismiss', () => send('job.dismiss', { jobId: job.id }))}>{ui('知道了')}</button>}
    </div>
  );
}

/**
 * The conversion jobs of the library: `data.jobs` (the snapshot) filtered to PDF conversions, or only `ids` of them.
 * `act(action, args)` (single-flight, from the app) or `call` sends the stop / retry / dismiss; `onChanged` refreshes the data afterwards.
 */
export function PdfConvertJobs({ data, jobs, ids, call, act, onOpenSources, onOpenSettings, onChanged }) {
  const list = (jobs || data?.jobs || []).filter(isConvertJob).filter(job => !ids || ids.includes(job.id));
  const send = (action, args) => (act ? act(action, args) : call(action, args));
  return list.length ? <div className="jobs audio-jobs pdf-convert-jobs">{list.map(job => <PdfConvertJob key={job.id} job={job} send={send} onOpenSources={onOpenSources} onOpenSettings={onOpenSettings} onChanged={onChanged} />)}</div> : null;
}

export default PdfConvertJob;
