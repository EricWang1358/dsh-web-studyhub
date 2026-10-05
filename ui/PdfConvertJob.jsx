import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Disclosure, Icon, InlineConfirm, InlineMessage, JobRow, Hint, LoadingState, useNow } from './components/index.js';
import { formatBytes, formatDuration, formatAgo, formatDay } from './format.js';
import { usePolling } from './use-polling.js';
import { isActiveJob } from './job-visibility.js';
import { megabytes } from '../lib/office/limits.js';
import { HISTORY_PAGE, groupHistoryByDay, historyRefreshKey, pageRange, isConvertJob } from './mineru-flow.js';
import CompactJobCard from './tasks/CompactJobCard.jsx';
import css from './mineru.css';

/* The compact card of a PDF conversion (cloud or local), the shared ui/tasks/CompactJobCard: the percent (pages converted over pages in the book, never a
   guess), one status line, a stop, and ONE button for what comes next (continue without redoing finished pieces; restart the stopped local service first;
   change the token; open the pages). What used to fill the card (the 运行环境, the window in hand and the service's own state, the pace, the windows) is
   `PdfDetail`, the kind's section of the 任务 console. */

function PdfConvertJob({ job, send, onOpenSources, onOpenSettings, onChanged }) {
  const [working, setWorking] = useState('');
  const run = async (name, work) => {
    if (working) return;
    setWorking(name);
    try { await work(); onChanged?.(); } catch { /* the console shows what went wrong; the card stays as it was */ } finally { setWorking(''); }
  };
  const retry = () => run('retry', async () => {
    // A stopped local service is started again first, which is the usual reason a local window failed.
    if (job.converter !== 'marker' && job.errorCode === 'server-stopped') await send('mineru.local.start', { restart: true });
    await send('mineru.retry', { jobId: job.id });
  });
  const tokenProblem = job.status === 'failed' && ['invalid-token', 'expired'].includes(job.errorCode);
  const primary = tokenProblem && onOpenSettings ? { label: ui('去设置里换一个令牌'), run: onOpenSettings }
    : job.status === 'failed' && job.retryable && !tokenProblem ? { label: job.errorCode === 'server-stopped' ? ui('重新启动本地服务并接着做') : ui('接着做'), run: retry, disabled: !!working }
      : job.status === 'complete' && job.sourceIds?.length > 0 && onOpenSources ? { label: ui('打开资料'), run: () => onOpenSources(job.sourceIds) } : undefined;
  return <CompactJobCard job={job} primary={primary} id={`pdf-job-${job.id}`} data-route={job.route || 'cloud'}
    onStop={() => run('cancel', () => send('job.control', { jobId: job.id, action: 'cancel' }))}
    onDismiss={() => void run('dismiss', () => send('job.dismiss', { jobId: job.id }))} />;
}

/**
 * What the 任务 console shows of a PDF conversion beyond the timeline: the 运行环境 (what does the work), the window in hand with the service's own state,
 * the pace and what is left, and the windows done and to come. The card on the page says none of this; it is the same text the card used to carry.
 */
export function PdfDetail({ job, expandChunks }) {
  useInjectCss(css, 'study-mineru');
  const running = isActiveJob(job), now = useNow(1000, { enabled: running });
  const count = job.chunk?.count || 1, index = job.chunk?.index || 0, adaptive = job.route === 'local' && !!job.local?.adaptive;
  return (
    <div className="pdf-detail">
      <ConversionEnvironment env={job.env} converter={job.converter} service={job.service} now={now} />
      {running && job.phase !== 'queued' && <>
        {job.route === 'local' && (count > 1 || adaptive) && <Hint as="small">{ui('本地解析按页段推进，一段做完才会前进；一段里没有更细的进度，不是卡住了。')}</Hint>}
        {job.route === 'local' && job.local?.eta && <small className="pdf-eta">{etaText(job.local.eta)}</small>}
        {job.route === 'local' && job.local?.pace && <Hint as="small">{uiFormat('这台电脑每页约 {0} 秒', [job.local.pace.secondsPerPage])}</Hint>}
      </>}
      {running && job.route === 'local' && job.phase === 'local' && job.local?.window && <LocalWindow job={job} now={now} />}
      {job.note && running && <Hint as="small">{uiMessage(job.note)}</Hint>}
      {running && job.local?.halved > 0 && <Hint as="small">{uiFormat('有窗口没有成功，已自动拆成更小的段重试（{0} 次）', [job.local.halved])}</Hint>}
      {(adaptive ? job.chunks?.length > 0 : count > 1 && job.chunks?.length > 1) && job.status !== 'complete' && <ChunkList chunks={job.chunks} index={index} count={count} running={running} expanded={expandChunks} adaptive={adaptive} next={adaptive && running ? job.local?.next : 0} />}
    </div>
  );
}

/**
 * The conversion jobs of the library: `data.jobs` (the snapshot) filtered to PDF conversions, or only `ids` of them.
 * `act(action, args)` (single-flight, from the app) or `call` sends the stop / retry / dismiss; `onChanged` refreshes the data afterwards.
 */
export function PdfConvertJobs({ data, jobs, ids, call, act, onOpenSources, onOpenSettings, onChanged, expandChunks }) {
  useInjectCss(css, 'study-mineru');
  const list = (jobs || data?.jobs || []).filter(isConvertJob).filter(job => !ids || ids.includes(job.id));
  const send = (action, args) => (act ? act(action, args) : call(action, args));
  return list.length ? <div className="cjc-list pdf-convert-jobs">{list.map(job => <PdfConvertJob key={job.id} job={job} send={send} onOpenSources={onOpenSources} onOpenSettings={onOpenSettings} onChanged={onChanged} expandChunks={expandChunks} />)}</div> : null;
}

/* ---------- the window in hand: what the service says about it ---------- */

/** A duration of a few minutes or hours as a person says it ("25 min", "1 h 20 min"): whole minutes, never "0". */
const roughDuration = seconds => formatDuration(Math.max(1, Math.round(seconds / 60)) * 60_000);
/** What is left: "less than a minute", one figure when the speed is steady, "A to B" when it is not (it is said to be unsteady). Always "about". */
function etaText(eta) {
  if ((eta.highSeconds ?? eta.seconds) < 30) return ui('预计还需不到 1 分钟');
  const low = roughDuration(eta.lowSeconds ?? eta.seconds), high = roughDuration(eta.highSeconds ?? eta.seconds);
  return eta.stable || low === high ? uiFormat('预计还需约 {0}', [roughDuration(eta.seconds)]) : uiFormat('预计还需约 {0} 到 {1}（速度还不稳定，估算会变）', [low, high]);
}

const LIVE_LABEL = { queued: () => ui('排队中'), parsing: () => ui('转换中'), starting: () => ui('服务正在启动'), quiet: () => ui('转换中（服务还没有报告这一段）'),
  stopped: () => ui('服务已停止'), unknown: () => ui('未知（读不到服务的状态）') };
const LIVE_ADVICE = {
  queued: () => ui('服务收到了这一段，正在排队，前面还有别的任务。'),
  silent: () => ui('服务没有报告它在处理这一段。再等一会儿看看；如果一直没有变化，点「停止」，然后再选同一个 PDF：已经完成的段落会直接复用，只重做这一段。'),
  stopped: () => ui('本地服务已经停止，这一段多半会失败。失败之后点「重新启动本地服务并接着做」，已经完成的段落会保留。'),
  unknown: () => ui('暂时读不到服务的状态。这不表示出了问题：解析还在进行，读到状态后这里会更新。'),
};

/**
 * The window that is running: which pages, how long it has been going and how long it should take, and (when the service could be asked, read-only) one honest state of it with
 * what to do about it. The state comes from the service, not from the command, which prints nothing until a window ends: so "no response" is only said when the service reports
 * nothing parsing or queued for a while, and a scan that simply takes minutes is explained, not alarmed.
 */
function LocalWindow({ job, now }) {
  const win = job.local.window, live = job.liveness, state = live?.state;
  const elapsed = win.startedAt ? Math.max(0, now - Date.parse(win.startedAt)) : null;
  const silentFor = live?.lastSignalAt ? Math.max(0, now - Date.parse(live.lastSignalAt)) : (live?.silentForMs ?? 0);
  const label = state === 'silent' ? uiFormat('无响应（已 {0}没有新状态）', [formatDuration(Math.max(1, Math.round(silentFor / 60_000)) * 60_000)]) : LIVE_LABEL[state]?.();
  const timing = [elapsed !== null && uiFormat('已经用了 {0}', [formatDuration(elapsed)]), win.expectedSeconds > 0 && uiFormat('预计约 {0}', [formatDuration(win.expectedSeconds * 1000)])].filter(Boolean).join(' · ');
  return (
    <div className="pdf-live" role="group" aria-label={ui('当前这一段')} data-state={state || 'none'}>
      <p className="pdf-live__window"><strong>{uiFormat('这一段：第 {0} 页（{1} 页）', [pageRange(win.startPage, win.endPage), win.pages])}</strong>{timing && <span>{timing}</span>}</p>
      {label && <p className={`pdf-live__state${state === 'silent' || state === 'stopped' ? ' pdf-live__state--warn' : ''}`} data-state={state}><span className="pdf-live__dot" aria-hidden="true" /><strong>{label}</strong></p>}
      {live?.lastSignalAt && <small className="muted">{uiFormat('最后一次收到服务的状态：{0}', [formatAgo(live.lastSignalAt, now)])}</small>}
      {LIVE_ADVICE[state] && <p className={`pdf-live__advice${state === 'silent' || state === 'stopped' ? ' pdf-live__advice--warn' : ''}`}>{LIVE_ADVICE[state]()}</p>}
      <details className="pdf-live__why"><summary>{ui('为什么一段会这么久？')}</summary>
        <p>{ui('扫描版 PDF 的第一段最慢：模型要先加载，每一页还要做文字识别。这台电脑慢，每段就按比例更久。')}</p>
        <p>{ui('服务显示「转换中」时，几分钟没有新进度是正常的：一段做完，进度条才会前进。')}</p>
      </details>
    </div>
  );
}

/* ---------- what does the work (运行环境) ---------- */

const TIER_MEANING = { basic: () => ui('速度较快'), standard: () => ui('版面理解更好，稍慢') };

function environmentHeading(env, converter) {
  if (converter === 'marker') return ui('本地 Marker');
  if (env.kind !== 'local') return env.modelVersion ? uiFormat('云端 MinerU · {0} 模型', [env.modelVersion]) : ui('云端 MinerU');
  if (env.mineruVersion && env.tier) {
    const meaning = TIER_MEANING[env.tier]?.();
    return meaning ? uiFormat('本地 mineru {0} · {1} 档（{2}）', [env.mineruVersion, env.tier, meaning]) : uiFormat('本地 mineru {0} · {1} 档', [env.mineruVersion, env.tier]);
  }
  if (env.tier) return uiFormat('本地 mineru · {0} 档', [env.tier]);
  return env.mineruVersion ? uiFormat('本地 mineru {0}', [env.mineruVersion]) : ui('本地 mineru');
}

/**
 * The 运行环境 of a conversion: WHAT is doing the work, so a slow or failed run is never a mystery. Local: the mineru version, the tier and what it means,
 * the model folder in use (and where the models live, in a disclosure: the folder may be a link to another drive), a device only when the CLI said one,
 * whether the service is up, and how pages are worked on. Cloud: MinerU, the model version and language, that the saved token is used (never shown), the
 * piece limits and the size of the book. One component for the live card (`service`: the state kept honest while it runs) and the history rows
 * (`bare`, no service, `stoppedAtFailure` from the record).
 */
export function ConversionEnvironment({ env, converter, service, stoppedAtFailure = false, bare = false, now = Date.now(), timings }) {
  if (!env) return null;
  const local = env.kind === 'local';
  const managesService = local && converter !== 'marker';
  const timed = (timings?.windows || []).filter(window => window.seconds > 0);
  const pages = timed.reduce((sum, window) => sum + (window.pages || 0), 0);
  const pace = timings?.secondsPerPage > 0 ? timings.secondsPerPage : pages > 0 ? Math.round(timed.reduce((sum, window) => sum + window.seconds, 0) / pages * 100) / 100 : 0;
  const head = environmentHeading(env, converter);
  const state = service?.state, confirmed = service?.at ? formatAgo(service.at, now) : '';
  const serviceText = state === 'running' ? ui('本地服务运行中') : state === 'stopped' ? ui('本地服务已停止') : ui('无法确认本地服务是否在运行');
  return (
    <div className="pdf-env" role="group" aria-label={ui('运行环境')} data-route={local ? 'local' : 'cloud'}>
      {!bare && <strong className="pdf-env__title">{ui('运行环境')}</strong>}
      <ul className="pdf-env__list">
        <li>{head}</li>
        {local && env.model && <li>{uiFormat('模型：{0}', [env.model])}</li>}
        {local && env.modelsPath && <li><details className="pdf-env__where"><summary>{ui('模型位置')}</summary>
          <p><code>{env.modelsPath}</code></p>
          {env.modelsRealPath && <p>{uiFormat('它是一个链接，实际在：{0}', [env.modelsRealPath])}</p>}
        </details></li>}
        {local && env.device && <li>{uiFormat('设备：{0}', [env.device])}</li>}
        {!local && env.language && <li>{uiFormat('识别语言：{0}', [env.language])}</li>}
        {!local && <li>{ui('使用你保存的令牌（令牌不会显示）')}</li>}
        {!local && env.maxPages > 0 && env.maxBytes > 0 && <li>{Number.isFinite(env.bookBytes)
          ? uiFormat('每段不超过 {0} 页 / {1} MB · 本书 {2}', [env.maxPages, megabytes(env.maxBytes), formatBytes(env.bookBytes)])
          : uiFormat('每段不超过 {0} 页 / {1} MB', [env.maxPages, megabytes(env.maxBytes)])}</li>}
        {local && env.windows?.kind === 'fixed' && env.windows.pages > 0 && <li>{uiFormat('每次 {0} 页，一段做完才前进', [env.windows.pages])}</li>}
        {local && env.windows?.kind === 'adaptive' && env.windows.firstPages > 0 && <li>{uiFormat('分段随这台电脑的速度调整：先做 {0} 页，之后每段约 {1} 秒（{2}–{3} 页）', [env.windows.firstPages, env.windows.targetSeconds, env.windows.minPages, env.windows.maxPages])}</li>}
        {local && timed.length > 0 && pace > 0 && <li>{uiFormat('这台电脑每页约 {0} 秒', [pace])}</li>}
        {local && timed.length > 0 && <li><details className="pdf-env__windows"><summary>{ui('各段用时')}</summary>
          <ol>{(timings.windows).map((window, position) => <li key={`${window.start}-${window.end}`}>{uiFormat('第 {0} 段 · 第 {1} 页', [position + 1, pageRange(window.start, window.end)])}
            {window.seconds > 0 ? ` · ${formatDuration(window.seconds * 1000)}` : window.state === 'failed' ? ` · ${ui('没有完成')}` : ''}</li>)}</ol>
        </details></li>}
        {managesService && service && <li className={`pdf-env__service${state === 'stopped' ? ' pdf-env__warning' : ''}`} data-state={['running', 'stopped'].includes(state) ? state : 'unknown'}>
          <span className="pdf-env__dot" aria-hidden="true" />{serviceText}{state === 'running' && confirmed ? ` ${uiFormat('（{0}确认）', [confirmed])}` : ''}</li>}
        {managesService && state === 'stopped' && <li className="pdf-env__hint">{ui('点「重新启动本地服务并接着做」，已完成的段落会保留。')}</li>}
        {managesService && !service && stoppedAtFailure && <li className="pdf-env__note">{ui('失败时本地服务已停止')}</li>}
      </ul>
    </div>
  );
}

/** The windows (or pieces) of a conversion: they wrap inside the card, each with its pages and its state; more than eight collapse to "第 i/N 段" and a toggle. */
function ChunkList({ chunks, index, count, running = false, expanded = false, adaptive = false, next = 0 }) {
  const [open, setOpen] = useState(expanded), done = chunks.filter(chunk => chunk.state === 'done').length, many = chunks.length > 8;
  const list = <ol className="sh-job__steps pdf-chunks" aria-label={ui('各段状态')}>
    {chunks.map(chunk => {
      const label = uiFormat('第 {0} 段 · 第 {1} 页', [chunk.index, pageRange(chunk.startPage, chunk.endPage)]);
      if (chunk.state === 'done') return <li key={chunk.index} className="is-done"><Icon name="check" size={14} /><span className="sh-visually-hidden">{ui('已完成')} </span>{label}{chunk.seconds > 0 ? ` · ${formatDuration(chunk.seconds * 1000)}` : ''}</li>;
      return <li key={chunk.index} className={chunk.index === index && running ? 'is-current' : ''} aria-current={chunk.index === index && running ? 'step' : undefined}>{label}</li>;
    })}
  </ol>;
  // The windows still to be decided are not listed (nobody knows them yet): the size of the next one is said instead.
  const upcoming = next > 0 ? <Hint as="small" className="pdf-chunks__next">{uiFormat('下一段约 {0} 页（按这台电脑现在的速度）', [next])}</Hint> : null;
  if (!many) return <>{list}{upcoming}</>;
  return <>
    <p className="pdf-chunks__summary"><span>{adaptive ? uiFormat('第 {0} 段 · 已完成 {1} 段', [index || done, done]) : uiFormat('第 {0}/{1} 段 · 已完成 {2} 段', [index || done, count || chunks.length, done])}</span>
      <Button variant="link" size="sm" aria-expanded={open} onClick={() => setOpen(current => !current)}>{open ? ui('收起各段') : ui('展开各段')}</Button></p>
    {open && list}
    {upcoming}
  </>;
}

/* ---------- the conversion history (解析历史) ---------- */

/* The history says durations and ages the way the live card does (ui/format.js); these names stay for the panel and its tests. */
export { formatDuration as historyDuration, formatAgo as historyAgo };

const capital = text => text.charAt(0).toUpperCase() + text.slice(1);
/** A sentence that is embedded in another one ("Started just now") starts in lower case in English; Chinese is untouched. */
const lowerFirst = text => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);
const dayHeading = group => {
  if (group.when === 'today') return ui('今天');
  if (group.when === 'yesterday') return ui('昨天');
  if (group.when === 'unknown') return ui('日期未知');
  return formatDay(group.day);
};
const STATUS_TEXT = { running: () => ui('进行中'), complete: () => ui('已完成'), failed: () => ui('没有完成'), cancelled: () => ui('已取消'), interrupted: () => ui('被中断') };
const STATUS_TONE = { running: 'info', complete: 'success', failed: 'error', cancelled: 'neutral', interrupted: 'warning' };
const STAGE_TEXT = { start: () => ui('启动'), queued: () => ui('排队'), split: () => ui('切分 PDF'), upload: () => ui('上传'), parse: () => ui('云端解析'), local: () => ui('本地解析'),
  download: () => ui('下载结果'), merge: () => ui('合并各段'), save: () => ui('保存为资料') };

function HistoryRow({ row, now, working, onOpen, onShowJob, onRetry, onRemove, onOpenSettings }) {
  const status = row.status, finished = !!row.finishedAt && status !== 'running' && status !== 'interrupted';
  const route = row.converter === 'marker' ? 'Marker · ' + ui('本地') : row.route === 'local' ? uiFormat('本地 · {0}', [row.tier || 'mineru']) : capital(ui('云端'));
  const size = Number.isFinite(row.bytes) ? formatBytes(row.bytes) : '', pages = Number.isFinite(row.pages) ? (row.pages === 1 ? ui('1 页') : uiFormat('{0} 页', [row.pages])) : '';
  const facts = [size, pages].filter(Boolean).join(' · ');
  const took = finished && Number.isFinite(row.elapsedMs) ? formatDuration(row.elapsedMs) : '';
  const when = finished ? formatAgo(row.finishedAt, now) : uiFormat('开始于 {0}', [lowerFirst(formatAgo(row.startedAt, now))]);
  const timeLine = [when, took && uiFormat('用时 {0}', [took]), row.attempts > 1 && uiFormat('已尝试 {0} 次', [row.attempts])].filter(Boolean).join(' · ');
  const document = row.document, imported = row.importedPages ?? document?.pages ?? 0;
  const title = document?.title || row.title || row.filename;
  const progress = ['failed', 'interrupted', 'cancelled', 'running'].includes(status) && row.pagesDone > 0 && row.pages > 0 ? uiFormat('已解析 {0}/{1} 页', [row.pagesDone, row.pages]) : '';
  const stage = row.failure ? (row.failure.piece
    ? uiFormat('在「{0}」阶段（第 {1} 段）没能完成', [(STAGE_TEXT[row.failure.stage] || STAGE_TEXT.start)(), row.failure.piece])
    : uiFormat('在「{0}」阶段没能完成', [(STAGE_TEXT[row.failure.stage] || STAGE_TEXT.start)()])) : '';
  const tokenProblem = status === 'failed' && ['invalid-token', 'expired'].includes(row.failure?.code);
  const stuck = (status === 'failed' || status === 'interrupted') && !row.canRetry;
  const busy = working === row.id;
  const known = Object.hasOwn(STATUS_TEXT, status) ? status : 'failed';
  return (
    <li className="pdf-history__item">
      <JobRow className="pdf-history__row" status={known} title={row.filename} data-route={row.route || 'cloud'} data-status={status}
        failure={stage || row.failure?.reason ? { title: stage || undefined, hint: row.failure?.reason ? uiMessage(row.failure.reason) : undefined } : undefined}>
        <span className="pdf-history__chips">
          <Badge tone={row.route === 'local' ? 'neutral' : 'info'}>{route}</Badge>
          <Badge tone={STATUS_TONE[known]} icon>{STATUS_TEXT[known]()}</Badge>
        </span>
        {facts && <small>{facts}</small>}
        {timeLine && <small>{timeLine}</small>}
        {status === 'complete' && (document?.exists
          ? <small className="pdf-history__result">{imported === 1 ? uiFormat('已导入为「{0}」· 共 1 页', [title]) : uiFormat('已导入为「{0}」· 共 {1} 页', [title, imported])}</small>
          : <Hint as="small">{ui('已导入的资料已被删除')}</Hint>)}
        {status === 'complete' && row.skippedPages > 0 && <Hint as="small">{uiFormat('没有可读文字而跳过的页：{0}', [row.skippedPages])}</Hint>}
        {status === 'interrupted' && <small>{ui('上次没有做完（应用被关闭，或意外中断）。')}</small>}
        {status === 'cancelled' && <small>{ui('已解析好的段落会保留，再选同一个文件不会重复解析。')}</small>}
        {progress && <small>{progress}</small>}
        {stuck && <Hint as="small">{ui('临时文件已清理，没法接着做。重新选择这份 PDF 再解析一次，已解析好的段落会被复用。')}</Hint>}
        {row.env && <details className="pdf-env-details"><summary>{ui('运行环境')}</summary><ConversionEnvironment converter={row.converter} env={row.env} bare stoppedAtFailure={row.failure?.code === 'server-stopped'}
          timings={row.route === 'local' ? { windows: row.windows, secondsPerPage: row.plan?.secondsPerPage } : undefined} /></details>}
        <div className="pdf-history__actions">
          {status === 'complete' && document?.exists && <Button variant="link" size="sm" aria-label={uiFormat('打开「{0}」', [title])} onClick={() => onOpen(row)}>{ui('打开资料')}</Button>}
          {status === 'running' && row.live && <Button variant="link" size="sm" aria-label={uiFormat('查看「{0}」的进度', [row.filename])} onClick={() => onShowJob(row)}>{ui('查看进度')}</Button>}
          {row.canRetry && !tokenProblem && <Button variant="primary" size="sm" busy={busy} disabled={!!working} aria-label={uiFormat('接着解析「{0}」', [row.filename])}
            title={ui('已完成的段落会直接复用，不会重复上传或重复解析')} onClick={() => onRetry(row)}>
            {status === 'failed' ? (row.failure?.code === 'server-stopped' ? ui('重新启动本地服务并接着做') : ui('接着做（不重复已完成的段落）')) : ui('接着做')}</Button>}
          {tokenProblem && onOpenSettings && <Button variant="primary" size="sm" onClick={onOpenSettings}>{ui('去设置里换一个令牌')}</Button>}
          {status !== 'running' && <Button variant="link" size="sm" disabled={!!working} aria-label={uiFormat('删除「{0}」的记录', [row.filename])} onClick={() => onRemove(row)}>{ui('删除记录')}</Button>}
        </div>
      </JobRow>
    </li>
  );
}

/**
 * The 解析历史: one row per MinerU conversion (cloud and local), newest first, grouped by day: what was converted, which way, when and for how long,
 * where the result went, and the one next step (open it, resume it, look at it running, delete the record). Reads `mineru.history.list` through
 * `call`, again whenever a conversion job changes state (`jobs` / `data.jobs`, the snapshot the page already polls). Deleting a record or clearing
 * the history never deletes an imported document.
 * Props: call, act (single-flight, for resuming), data / jobs, onOpenSources(sourceIds), onOpenJob(row) (when the live card is not on this page),
 * onOpenSettings, onChanged, collapsible + defaultOpen, hideWhenEmpty (the Sources page shows it only once there is something), and initialRecords /
 * initialShown / initialConfirmClear / now (previews and tests).
 */
export function PdfConvertHistory({ call, act, data, jobs, onOpenSources, onOpenJob, onOpenSettings, onChanged, collapsible = false, defaultOpen = false, hideWhenEmpty = false,
  initialRecords = null, initialShown, initialConfirmClear = false, now: fixedNow, className, ...rest }) {
  useInjectCss(css, 'study-mineru');
  const [records, setRecords] = useState(initialRecords), [readError, setReadError] = useState(''), [problem, setProblem] = useState('');
  const [shown, setShown] = useState(initialShown ?? HISTORY_PAGE), [confirming, setConfirming] = useState(initialConfirmClear), [working, setWorking] = useState('');
  const alive = useRef(true), heading = useRef(null), clearButton = useRef(null);
  const key = historyRefreshKey(jobs ?? data?.jobs);
  const send = (action, args) => (act ? act(action, args) : call(action, args));
  const load = useCallback(async () => {
    try {
      const view = await call('mineru.history.list', {});
      if (alive.current) { setRecords(Array.isArray(view?.records) ? view.records : []); setReadError(''); }
    } catch (error) { if (alive.current) setReadError(errorMessage(error)); }
  }, [call]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!initialRecords && typeof call === 'function') void load(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = !!records?.some(row => row.status === 'running');
  // Running rows are read again every few seconds; the times ("3 分钟前") are refreshed every half minute.
  const live = !initialRecords && fixedNow === undefined && typeof call === 'function';
  const tick = useNow(30_000, { enabled: live && !!records?.length });
  const clock = fixedNow ?? tick;
  usePolling(load, { intervalMs: 5000, enabled: live && running });

  const work = async (name, task) => {
    if (working) return;
    setWorking(name); setProblem('');
    try { await task(); } catch (error) { setProblem(errorMessage(error)); } finally { if (alive.current) setWorking(''); }
  };
  const toHeading = () => setTimeout(() => heading.current?.focus?.(), 0);
  const remove = row => work(row.id, async () => { await call('mineru.history.remove', { id: row.id }); await load(); toHeading(); });
  const clear = () => work('clear', async () => { await call('mineru.history.clear', { confirm: true }); setConfirming(false); await load(); toHeading(); });
  const retry = row => work(row.id, async () => {
    // A stopped local service is started again first, which is the usual reason a local window failed.
    if (row.converter !== 'marker' && row.failure?.code === 'server-stopped') await send('mineru.local.start', { restart: true });
    await send('mineru.retry', { jobId: row.id });
    await load(); onChanged?.();
  });
  const showJob = row => {
    const card = typeof document !== 'undefined' ? document.getElementById(`pdf-job-${row.id}`) : null;
    if (card) { card.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); card.focus?.({ preventScroll: true }); } else onOpenJob?.(row);
  };

  if (hideWhenEmpty && (!records || !records.length)) return null;
  const list = records || [], deletable = list.filter(row => row.status !== 'running');
  const groups = groupHistoryByDay(list.slice().sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)).slice(0, shown), clock);
  const more = list.length - shown;
  const body = <>
    {records === null && !readError && <LoadingState className="pdf-history__note" label={ui('正在读取解析历史…')} />}
    {readError && <InlineMessage tone="error">{uiFormat('没能读取解析历史：{0}', [readError])}</InlineMessage>}
    {records !== null && !list.length && <div className="pdf-history__empty">
      <strong>{ui('还没有解析记录')}</strong>
      <p>{ui('每次解析 PDF 都会记录文件名、解析工具、耗时和结果，不保存文档内容。')}</p>
    </div>}
    {list.length > 0 && <div className="pdf-history__bar">
      <small>{uiFormat('{0} 条记录 · 保留最近 50 条，以及 90 天内的所有记录。删除记录不会删除已导入的资料。', [list.length])}</small>
      {deletable.length > 0 && !confirming && <Button ref={clearButton} variant="quiet" size="sm" disabled={!!working} onClick={() => setConfirming(true)}>{ui('清空历史')}</Button>}
    </div>}
    {confirming && deletable.length > 0 && <InlineConfirm title={uiFormat('清空这 {0} 条解析记录？', [deletable.length])} confirmLabel={ui('确认清空')}
      busy={working === 'clear'} returnFocusRef={clearButton} onConfirm={clear} onCancel={() => setConfirming(false)}>
      {ui('已导入的资料不会被删除。')}
    </InlineConfirm>}
    {problem && <InlineMessage tone="error">{uiFormat('没能完成：{0}', [problem])}</InlineMessage>}
    {groups.map(group => <div className="pdf-history__group" key={group.key}>
      <h5 className="pdf-history__day">{dayHeading(group)}</h5>
      <ul className="pdf-history__list">
        {group.rows.map(row => <HistoryRow key={row.id} row={row} now={clock} working={working} onOpen={target => onOpenSources?.(target.document?.sourceIds || [])}
          onShowJob={showJob} onRetry={retry} onRemove={remove} onOpenSettings={onOpenSettings} />)}
      </ul>
    </div>)}
    {more > 0 && <Button variant="quiet" size="sm" onClick={() => setShown(current => current + HISTORY_PAGE)}>{uiFormat('显示更多（还有 {0} 条）', [more])}</Button>}
  </>;
  return (
    <section className={`pdf-history${className ? ` ${className}` : ''}`} aria-label={ui('解析历史')} {...rest}>
      {collapsible
        ? <Disclosure summary={ui('解析历史')} meta={list.length || undefined} defaultOpen={defaultOpen} className="pdf-history__disclosure">{body}</Disclosure>
        : <><h4 className="pdf-history__title" ref={heading} tabIndex={-1}>{ui('解析历史')}</h4>{body}</>}
    </section>
  );
}

export default PdfConvertJob;
