import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, Icon, InlineMessage, SetupRequired } from './components/index.js';
import { LocalMineruPanel, MineruTokenForm, PrivacyConfirm, privacyNote, DOCS_URL } from './MineruSettings.jsx';
import { chooseRoute, localEstimate, minutesOf, pageRange, uploadPdf } from './mineru-flow.js';
import { formatBytes } from './components/FileDrop.jsx';
import { PdfConvertHistory } from './PdfConvertJob.jsx';
import css from './mineru.css';

/* The one entry for turning a PDF into pages of text with MinerU, wherever the learner meets it: the import hub and the
   "大教材建议" card both show this component. It reads the file locally (nothing is sent), says how the book will be
   processed ("这本书会分 N 段处理"), leads with local mineru or local setup (free, nothing uploaded). Cloud is an explicit choice
   with a temporary availability warning. It needs a one-time confirmation that the document
   goes to MinerU; the server refuses to upload without it. The desktop client and the command line stay under 高级. */

const ACCEPT = '.pdf,application/pdf';

function RouteCard({ id, value, current, title, chips, children, onSelect, disabled }) {
  return (
    <label className={`mineru-route${current === value ? ' is-selected' : ''}`} data-route={value} htmlFor={id}>
      <input id={id} type="radio" name="mineru-route" value={value} checked={current === value} disabled={disabled} onChange={() => onSelect(value)} />
      <span className="mineru-route__body">
        <span className="mineru-route__title"><strong>{title}</strong>{chips}</span>
        {children}
      </span>
    </label>
  );
}

const chip = (text, tone) => <span className={`audio-chip${tone ? ` audio-chip--${tone}` : ''}`}>{text}</span>;

/**
 * Props: file (a File, or null to offer a picker), call(action, args), courses (the course names to file the book under),
 * onStarted({ jobId, filename, pages, route }), onOpenSettings, onFile(file) (the picker chose one; the parent keeps it),
 * compact, and initialSettings / initialLocal / initialPlan / initialRoute / initialAcknowledged (previews and tests).
 * The 解析历史 (every conversion, cloud and local, with its result) is part of the panel unless it is compact: `jobs` (the snapshot's job list, so
 * the history refreshes when a conversion ends), `onOpenSources(sourceIds)` to jump to an imported document, `onOpenJob(row)` to show a running one,
 * `historyOpen` to start with the history expanded, and initialHistory / historyNow (previews and tests).
 */
export default function MineruRoute({ file = null, call, courses = [], onStarted, onOpenSettings, onFile, compact = false,
  initialSettings = null, initialLocal = null, initialPlan = null, initialRoute = null, initialAcknowledged = false, className,
  jobs, act, onOpenSources, onOpenJob, onChanged, historyOpen = false, initialHistory = null, historyNow, ...rest }) {
  useInjectCss(css, 'study-mineru');
  const [settings, setSettings] = useState(initialSettings), [local, setLocal] = useState(initialLocal);
  const [plan, setPlan] = useState(initialPlan), [reading, setReading] = useState(null), [problem, setProblem] = useState('');
  const [choice, setChoice] = useState(initialRoute), [agreed, setAgreed] = useState(initialAcknowledged), [starting, setStarting] = useState(false);
  const uploadId = useRef(''), picker = useRef(null), alive = useRef(true), taken = useRef(false);
  const radioId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // What is set up: read once, and again whenever a panel changes something.
  useEffect(() => {
    if (typeof call !== 'function') return undefined;
    let live = true;
    if (!initialSettings) Promise.resolve(call('mineru.settings.get', {})).then(value => { if (live) setSettings(value); }, () => { if (live) setSettings({ token: { set: false }, acknowledged: false, unavailable: true }); });
    if (!initialLocal) Promise.resolve(call('mineru.local.status', {})).then(value => { if (live) setLocal(value); }, () => { if (live) setLocal({ state: 'unavailable' }); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A chosen PDF is handed to the backend in pieces and planned; nothing leaves the computer here.
  useEffect(() => {
    if (!file || typeof call !== 'function' || initialPlan) return undefined;
    const controller = new AbortController();
    setPlan(null); setProblem(''); setReading(0); taken.current = false;
    (async () => {
      try {
        const id = await uploadPdf(call, file, { signal: controller.signal, onProgress: fraction => { if (alive.current) setReading(fraction); } });
        uploadId.current = id;
        const next = await call('mineru.plan', { uploadId: id });
        if (alive.current && !controller.signal.aborted) { setPlan(next); setReading(null); }
      } catch (error) {
        if (controller.signal.aborted || !alive.current) return;
        setReading(null); setProblem(uiMessage(String(error?.message || error)));
      }
    })();
    return () => {
      controller.abort();
      const pending = uploadId.current;
      uploadId.current = '';
      // A PDF that was read but never started does not stay in the DSH home.
      if (pending && !taken.current) Promise.resolve(call('mineru.upload.cancel', { uploadId: pending })).catch(() => {});
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  const auto = chooseRoute({ local, settings });
  const route = choice || auto;
  const localReady = local?.state === 'ready', cloudSet = !!settings?.token?.set;
  const usable = route === 'local' ? localReady : cloudSet;
  const acknowledged = !!settings?.acknowledged || agreed;
  const pieces = plan ? (route === 'local' ? plan.windows : plan.pieces) : null;
  /* The local route cuts the book into windows one at a time, from the speed it measures (plan.adaptive): before it starts there is no list of windows and no count to show,
     only what it will do. A fixed plan (the seam of a test or a preview) still lists its windows. */
  const adaptiveLocal = route === 'local' && !!plan?.adaptive && plan.pages > plan.adaptive.firstPages;
  const pieceCount = adaptiveLocal ? 0 : pieces?.length || 0;
  const estimate = plan && local?.tier ? localEstimate(plan.pages, local.tier, local.estimates) : null;
  const refreshLocal = useCallback(next => setLocal(next), []);

  const start = async () => {
    if (!file || !plan || starting) return;
    setStarting(true); setProblem('');
    try {
      if (route === 'cloud' && !settings?.acknowledged) setSettings(await call('mineru.settings.set', { acknowledge: true }));
      taken.current = true;
      const job = await call('mineru.import', { uploadId: uploadId.current, route, ...(courses.length ? { courses } : {}) });
      uploadId.current = '';
      onStarted?.({ ...job, filename: file.name, pages: plan.pages, route });
    } catch (error) {
      taken.current = false;
      setProblem(uiMessage(String(error?.message || error)));
    } finally { if (alive.current) setStarting(false); }
  };

  const gate = !usable && (route === 'cloud'
    ? <SetupRequired className="mineru-gate" icon="key" title={ui('云端解析还没配置 · 约 2 分钟')} badge={ui('需要先配置')}
      why={ui('云端解析用你自己的 MinerU 令牌：在 mineru.net 免费创建，粘贴一次，之后导入 PDF 全自动。设置好之前不会上传任何东西。')}
      steps={[{ text: ui('打开 MinerU 的 API 管理页，创建一个令牌'), href: settings?.docsUrl || DOCS_URL }, { text: ui('把令牌粘贴到下面，点「保存并验证」') }]}
      secondary={onOpenSettings ? { label: ui('打开设置'), icon: 'key', onClick: onOpenSettings } : undefined}>
      <MineruTokenForm call={call} settings={settings} onSaved={setSettings} />
    </SetupRequired>
    : <div className="mineru-gate mineru-gate--local"><LocalMineruPanel call={call} status={local} onStatus={refreshLocal} /></div>);

  return (
    <section className={`mineru-route-panel${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`} aria-label={ui('用 MinerU 解析 PDF')} data-route={route} {...rest}>
      <header className="mineru-route-panel__head">
        <Icon name="file" size={20} />
        <div>
          <h3>{ui('用 MinerU 解析 PDF')}</h3>
          <p>{ui('适合扫描件、公式和表格多的书，以及超过 200 页的教材：自动分段、显示真实进度，出错只重做出错的那一段。')}</p>
        </div>
      </header>

      {settings?.unavailable && <InlineMessage tone="warning" boxed>{ui('这个安装里没有启用 MinerU 解析（需要启用音频组件）。可以用下面「高级」里的手动方式。')}</InlineMessage>}

      {!file && <div className="mineru-pick">
        <input ref={picker} type="file" accept={ACCEPT} className="sh-visually-hidden" tabIndex={-1} aria-hidden="true"
          onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) onFile?.(chosen); }} />
        <Button variant="primary" icon="upload" onClick={() => picker.current?.click()}>{ui('选择 PDF…')}</Button>
        <small>{ui('只在这台电脑上读取，确认之后才会开始解析。')}</small>
      </div>}

      {file && <>
        <p className="mineru-file"><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></p>
        {reading !== null && <div className="mineru-reading" role="status" aria-live="polite">
          <div className="audio-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(reading * 100)} aria-label={ui('正在读取这份 PDF')}><span style={{ width: `${Math.round(reading * 100)}%` }} /></div>
          <small>{uiFormat('正在读取这份 PDF（只在这台电脑上），{0}%', [Math.round(reading * 100)])}</small>
        </div>}
        {plan && <div className="mineru-plan" role="status">
          <p className="mineru-plan__line">
            {adaptiveLocal ? <strong>{ui('分段会按这台电脑的速度调整')}</strong>
              : pieceCount > 1
                ? <strong>{uiFormat('这本书会分 {0} 段处理', [pieceCount])}</strong>
                : <strong>{route === 'local' ? ui('不用分段，一次处理整本书') : ui('不用分段，整份一次解析')}</strong>}
            <span>{uiFormat('共 {0} 页 · {1}', [plan.pages, formatBytes(plan.bytes)])}</span>
          </p>
          {adaptiveLocal && <p className="mineru-plan__why">{uiFormat('先做 {0} 页看一看这台电脑有多快，再按它的速度调整每段的页数（每段约 {1} 秒，{2}–{3} 页）。', [plan.adaptive.firstPages, plan.adaptive.targetSeconds, plan.adaptive.minPages, plan.adaptive.maxPages])}</p>}
          {pieceCount > 1 && <p className="mineru-plan__why">
            {route === 'local' ? uiFormat('本地按每 {0} 页一段推进，这样能看到进度、随时停下，出错也只重做那一段。', [local?.windowPages || 50])
              : plan.byChapters ? ui('云端一次最多 200 页，所以按章节书签分段；超过上限的章节在 200 页处切开。')
                : ui('云端一次最多 200 页，所以每 200 页切一段；某一段文件太大时会自动再切细。')}
          </p>}
          {pieceCount > 1 && <Disclosure summary={ui('各段的页码')} meta={uiFormat('{0} 段', [pieceCount])} className="mineru-plan__list">
            <ol>{pieces.map(piece => <li key={piece.index}>{uiFormat('第 {0} 段 · 第 {1} 页', [piece.index, pageRange(piece.startPage, piece.endPage)])}</li>)}</ol>
            {route === 'cloud' && plan.maySplitFurther && <p className="audio-provider-note">{ui('文件很大，实际开始后可能会分得更细。')}</p>}
          </Disclosure>}
        </div>}

        <fieldset className="mineru-routes" disabled={starting}>
          <legend>{ui('用哪种方式解析')}</legend>
          <RouteCard id={`${radioId}-local`} value="local" current={route} onSelect={setChoice} title={ui('本地 mineru')}
            chips={<>{chip(ui('推荐'))}{chip(ui('免费 · 不上传'), 'good')}{localReady ? chip(ui('可用'), 'accent') : chip(local ? ui('需要设置') : ui('检测中…'))}</>}>
            <small>{localReady
              ? (estimate ? uiFormat('约 {0} 分钟（估算：{1} 档每页约 {2} 秒，实际取决于这台电脑）', [minutesOf(estimate), local.tier, local.estimates?.[local.tier]]) : ui('文档不会离开这台电脑。'))
              : ui('文档不会离开这台电脑；需要本机装好 mineru 并下载模型。')}</small>
          </RouteCard>
          <RouteCard id={`${radioId}-cloud`} value="cloud" current={route} onSelect={setChoice} title={ui('用 MinerU 云端解析')}
            chips={<>{chip(ui('暂不可用'))}{cloudSet ? chip(ui('令牌已设置'), 'accent') : chip(ui('需要令牌'))}</>}>
            <small>{ui('云端暂不可用，优先使用本地模型。恢复后可手动选择云端；已保存令牌不代表服务可用。')}</small>
            <small>{privacyNote()}</small>
          </RouteCard>
        </fieldset>

        {gate}

        {usable && route === 'cloud' && !settings?.acknowledged && <PrivacyConfirm checked={agreed} onChange={setAgreed} disabled={starting} />}
        {usable && route === 'cloud' && settings?.acknowledged && <p className="mineru-acked"><Icon name="success" size={16} />{ui('已确认：文档会上传到 MinerU 的云端。')}</p>}
        {usable && route === 'local' && <p className="mineru-acked"><Icon name="success" size={16} />{ui('本地解析：不会上传任何内容，也不需要令牌。')}</p>}

        {problem && <InlineMessage tone="error" boxed>{problem}</InlineMessage>}
        <div className="mineru-start">
          <Button variant="primary" icon="sparkle" busy={starting} disabled={!plan || !usable || (route === 'cloud' && !acknowledged)} onClick={start}>
            {route === 'local' ? ui('开始本地解析') : ui('开始云端解析')}
          </Button>
          {onFile && <Button variant="quiet" disabled={starting} onClick={() => onFile(null)}>{ui('换一份 PDF')}</Button>}
        </div>
      </>}

      {!compact && <PdfConvertHistory call={call} act={act} jobs={jobs} collapsible defaultOpen={historyOpen} initialRecords={initialHistory} now={historyNow}
        onOpenSources={onOpenSources} onOpenJob={onOpenJob} onOpenSettings={onOpenSettings} onChanged={onChanged} className="mineru-history" />}

      <Disclosure summary={ui('高级：桌面客户端和命令行')} meta={ui('手动')} className="mineru-advanced">
        <p>{ui('桌面客户端目前也反馈不可用，优先使用上面的本地模型；客户端恢复后可再尝试。')}</p>
        <p>{ui('也可以自己转换，再把结果拖进「添加资料」：用 MinerU 桌面客户端导出带页码的 JSON（content_list.json）；或在终端用 mineru parse 文件.pdf --pages 1-200 -o 结果.md（一定要写 --pages，默认只解析前 10 页），Markdown 里要有 <!-- page: N --> 分页标记。')}</p>
        <p><a href="https://mineru.net/client" target="_blank" rel="noreferrer">{ui('MinerU 桌面客户端')}<Icon name="external" size={13} /></a></p>
      </Disclosure>
    </section>
  );
}
