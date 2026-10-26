import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Disclosure, Hint, Icon, InlineMessage, ProgressBar, RadioCard, RadioCardGroup, SegmentedControl } from './components/index.js';
import { localEstimate, minutesOf, pageRange, uploadPdf } from './mineru-flow.js';
import { formatBytes } from './components/FileDrop.jsx';
import { PdfConvertHistory } from './PdfConvertJob.jsx';
import css from './mineru.css';
import { useMineruState } from './use-mineru.js';
import { STATUS_TEXT, cardState, mineruUsable } from './mineru-install-flow.js';
import MineruInstallCard from './MineruInstallCard.jsx';
import { useLiveEffect } from './use-async.js';

/* Both entry points share one staged PDF. Choosing a converter never reuploads it;
   only an explicit start hands the file to a background conversion job. The converter is chosen once, here (MinerU or Marker), and both run on this
   computer. When MinerU is not ready the one-click card (ui/MineruInstallCard.jsx) is right here, in place of a trip to Settings; a stopped service is
   started by the conversion itself. */

const ACCEPT = '.pdf,application/pdf';

function RouteCard({ group = 'mineru-converter', id, value, current, title, chips, children, onSelect, disabled }) {
  return <RadioCard id={id} name={group} value={value} checked={current === value} title={title} badges={chips} disabled={disabled} onSelect={onSelect} data-route={value}>{children}</RadioCard>;
}

const chip = (text, tone = 'neutral') => <Badge size="sm" tone={tone}>{text}</Badge>;

function planHeading(adaptive, pieces) {
  if (adaptive) return ui('分段会按这台电脑的速度调整');
  if (pieces > 1) return uiFormat('这本书会分 {0} 段处理', [pieces]);
  return ui('不用分段，一次处理整本书');
}

/**
 * Props: file (a File, or null to offer a picker), call(action, args), courses (the course names to file the book under),
 * onStarted({ jobId, filename, pages, route }), onOpenSettings(section, { file }) (the file is the PDF in hand, so the caller can bring the learner back to it),
 * onFile(file) (the picker chose one; the parent keeps it), compact, and initialLocal / initialPlan (previews and tests).
 * The 解析历史 (every conversion, cloud and local, with its result) is part of the panel unless it is compact: `jobs` (the snapshot's job list, so
 * the history refreshes when a conversion ends), `onOpenSources(sourceIds)` to jump to an imported document, `onOpenJob(row)` to show a running one,
 * `historyOpen` to start with the history expanded, and initialHistory / historyNow (previews and tests).
 */
export default function PdfConversion({ available = true, initialConverter = 'mineru', initialMarker = null, file = null, call, courses = [], onStarted, onOpenSettings, onFile, compact = false,
  initialLocal = null, initialPlan = null, className,
  jobs, act, onOpenSources, onOpenJob, onChanged, historyOpen = false, initialHistory = null, historyNow, ...rest }) {
  useInjectCss(css, 'study-mineru');
  const [converter, setConverter] = useState(initialConverter), [marker, setMarker] = useState(initialMarker);
  useEffect(() => { setConverter(initialConverter); }, [initialConverter]);
  const isMarker = converter === 'marker';
  const { local } = useMineruState({ call, initialLocal, enabled: available });
  const [plan, setPlan] = useState(initialPlan), [reading, setReading] = useState(null), [problem, setProblem] = useState('');
  const [starting, setStarting] = useState(false);
  const uploadId = useRef(''), picker = useRef(null), alive = useRef(true), taken = useRef(false);
  const radioId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // What is set up: read once, and again whenever a panel changes something.
  useLiveEffect(live => {
    if (!available || typeof call !== 'function') return;
    if (!initialMarker) Promise.resolve(call('marker.local.status', {})).then(value => { if (live()) setMarker(value); }, () => { if (live()) setMarker({ state: 'unavailable' }); });
  }, []);

  // A chosen PDF is handed to the backend in pieces and planned; nothing leaves the computer here.
  useEffect(() => {
    if (!available || !file || typeof call !== 'function' || initialPlan) return undefined;
    const controller = new AbortController();
    let pending = '', handedOff = false;
    setPlan(null); setProblem(''); setReading(0); taken.current = false;
    (async () => {
      try {
        const id = await uploadPdf(call, file, { signal: controller.signal, onProgress: fraction => { if (alive.current && !controller.signal.aborted) setReading(fraction); } });
        pending = id;
        if (controller.signal.aborted) { await call('mineru.upload.cancel', { uploadId: id }); return; }
        uploadId.current = id;
        const next = await call('mineru.plan', { uploadId: id });
        if (alive.current && !controller.signal.aborted) { setPlan(next); setReading(null); }
      } catch (error) {
        if (controller.signal.aborted || !alive.current) return;
        setReading(null); setProblem(errorMessage(error));
      }
    })();
    return () => {
      controller.abort();
      handedOff = taken.current;
      if (uploadId.current === pending) uploadId.current = '';
      // A PDF that was read but never started does not stay in the DSH home.
      if (pending && !handedOff) Promise.resolve(call('mineru.upload.cancel', { uploadId: pending })).catch(() => {});
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  const route = 'local';
  // MinerU is usable when it is ready, or installed with its service stopped (the conversion starts it); Marker when it is ready.
  const localReady = isMarker ? marker?.state === 'ready' : mineruUsable(local);
  const stopped = !isMarker && localReady && local?.state === 'server-stopped';
  const usable = available && localReady;
  const pieces = plan ? plan.windows : null;
  /* The local route cuts the book into windows one at a time, from the speed it measures (plan.adaptive): before it starts there is no list of windows and no count to show,
     only what it will do. A fixed plan (the seam of a test or a preview) still lists its windows. */
  const adaptiveLocal = !!plan?.adaptive && plan.pages > plan.adaptive.firstPages;
  const pieceCount = adaptiveLocal ? 0 : pieces?.length || 0;
  const tier = local?.tier || local?.install?.tier;
  const estimate = !isMarker && plan && tier ? localEstimate(plan.pages, tier, local.estimates) : null;


  const start = async () => {
    if (!available || !file || !plan || starting) return;
    const selectedUpload = uploadId.current;
    setStarting(true); setProblem('');
    try {
      taken.current = true;
      const job = await call(isMarker ? 'marker.import' : 'mineru.import', { uploadId: selectedUpload, ...(isMarker ? {} : { route }), ...(courses.length ? { courses } : {}) });
      uploadId.current = '';
      if (alive.current) onStarted?.({ ...job, filename: file.name, pages: plan.pages, route, converter });
    } catch (error) {
      taken.current = false;
      if (!alive.current && selectedUpload) Promise.resolve(call('mineru.upload.cancel', { uploadId: selectedUpload })).catch(() => {});
      if (alive.current) setProblem(errorMessage(error));
    } finally { if (alive.current) setStarting(false); }
  };

  // What the chosen tool still needs: MinerU installs right here (one click); Marker is set up in Settings.
  const gate = !usable && (available && !isMarker
    ? <MineruInstallCard compact initialLocal={local} onOpenSettings={onOpenSettings ? section => onOpenSettings(section, { file }) : undefined} />
    : <InlineMessage tone="info" boxed>
      {!available ? ui('PDF 解析是音频组件的一部分，而音频组件没有启用。在 DSH 插件管理器里启用它，这里就能用。') : ui('先在设置里安装或配置 Marker。')}
      {onOpenSettings && available && <Button variant="link" onClick={() => onOpenSettings('settings-marker', { file })}>{ui('前往设置')}</Button>}
    </InlineMessage>);

  // The tool is chosen here and nowhere else. Inside another card (compact) it is one line, MinerU unless the learner changes it; the gate below says what the chosen one needs.
  // MinerU's chip says what the install card says (one wording); while that card is shown right below, the chip is left out rather than said twice.
  const mineruCard = cardState(local), mineruText = STATUS_TEXT[mineruCard.state];
  const mineruChip = mineruUsable(local) ? chip(ui('可用'), 'success') : local == null || (gate && converter === 'mineru') ? null : chip(mineruText.badge(), mineruText.tone);
  const tools = <RadioCardGroup legend={ui('解析工具')} disabled={starting}>
    <RouteCard group={`${radioId}-converter`} id={`${radioId}-mineru`} value="mineru" current={converter} title="MinerU" onSelect={setConverter} chips={mineruChip}><Hint as="span">{ui('在本机解析，不上传')}</Hint></RouteCard>
    <RouteCard group={`${radioId}-converter`} id={`${radioId}-marker`} value="marker" current={converter} title="Marker" onSelect={setConverter} chips={marker?.state === 'ready' ? chip(ui('可用'), 'success') : chip(ui('需要设置'))}><Hint as="span">{ui('调用本机 Marker，自动导入')}</Hint></RouteCard>
  </RadioCardGroup>;
  return (
    <section className={`mineru-route-panel${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`} aria-label={ui('PDF 解析方案')} data-route={route} {...rest}>
      {!compact && <header className="mineru-route-panel__head">
        <Icon name="file" size={20} />
        <div>
          <h3>{ui('解析 PDF')}</h3>
          <p>{ui('选择 PDF 和解析工具，完成后自动存为资料。')}</p>
        </div>
      </header>}

      {!available && gate}

      {compact ? <SegmentedControl className="mineru-tools" label={ui('解析工具')} value={converter} disabled={starting} onChange={setConverter}
        options={[{ value: 'mineru', label: 'MinerU' }, { value: 'marker', label: 'Marker' }]} /> : tools}
      {!file && <div className="mineru-pick">
        <input ref={picker} type="file" accept={ACCEPT} className="sh-visually-hidden" tabIndex={-1} aria-hidden="true"
          onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) onFile?.(chosen); }} />
        <Button variant="primary" icon="upload" disabled={!available} onClick={() => picker.current?.click()}>{ui('选择 PDF…')}</Button>
        <small>{ui('只在这台电脑上读取，确认之后才会开始解析。')}</small>
      </div>}

      {file && <>
        <p className="mineru-file"><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></p>
        {reading !== null && <div className="mineru-reading">
          <ProgressBar value={Math.round(reading * 100)} max={100} label={ui('正在读取这份 PDF')} size="sm" />
          <small>{uiFormat('正在读取这份 PDF（只在这台电脑上），{0}%', [Math.round(reading * 100)])}</small>
        </div>}
        {plan && !isMarker && <div className="mineru-plan" role="status">
          <p className="mineru-plan__line">
            <strong>{planHeading(adaptiveLocal, pieceCount)}</strong>
            <span>{uiFormat('共 {0} 页 · {1}', [plan.pages, formatBytes(plan.bytes)])}</span>
          </p>
          {localReady && estimate && <p className="mineru-plan__estimate">{uiFormat('约 {0} 分钟（估算：每页约 {1} 秒，实际取决于这台电脑）', [minutesOf(estimate), local.estimates?.[tier]])}</p>}
          <Disclosure summary={ui('分段与页码详情')}>
          {adaptiveLocal && <p className="mineru-plan__why">{uiFormat('先做 {0} 页看一看这台电脑有多快，再按它的速度调整每段的页数（每段约 {1} 秒，{2}–{3} 页）。', [plan.adaptive.firstPages, plan.adaptive.targetSeconds, plan.adaptive.minPages, plan.adaptive.maxPages])}</p>}
          {pieceCount > 1 && <p className="mineru-plan__why">
            {uiFormat('本地按每 {0} 页一段推进，这样能看到进度、随时停下，出错也只重做那一段。', [local?.windowPages || 50])}
          </p>}
          {pieceCount > 1 && <Disclosure summary={ui('各段的页码')} meta={uiFormat('{0} 段', [pieceCount])} className="mineru-plan__list">
            <ol>{pieces.map(piece => <li key={piece.index}>{uiFormat('第 {0} 段 · 第 {1} 页', [piece.index, pageRange(piece.startPage, piece.endPage)])}</li>)}</ol>
          </Disclosure>}
          </Disclosure>
        </div>}

        {isMarker && plan && <p className="mineru-plan" role="status">{uiFormat('共 {0} 页 · {1}', [plan.pages, formatBytes(plan.bytes)])}</p>}

        {available && gate}

        {usable && <p className="mineru-acked"><Icon name="success" size={16} />{isMarker ? ui('在 StudyHub 所在电脑运行，结果自动导入。') : ui('本地解析：不会上传任何内容。')}</p>}
        {usable && stopped && <Hint>{ui('本机服务没在运行，开始解析时会先自动启动（约 1 分钟）。')}</Hint>}

        {problem && <InlineMessage tone="error" boxed>{problem}</InlineMessage>}
        <div className="mineru-start">
          <Button variant="primary" icon="sparkle" busy={starting} disabled={!plan || !usable} onClick={start}>
            {isMarker ? ui('用 Marker 开始解析') : ui('开始本地解析')}
          </Button>
          {onFile && <Button variant="quiet" disabled={starting} onClick={() => onFile(null)}>{ui('换一份 PDF')}</Button>}
        </div>
      </>}

      {!compact && available && <PdfConvertHistory call={call} act={act} jobs={jobs} collapsible defaultOpen={historyOpen} initialRecords={initialHistory} now={historyNow}
        onOpenSources={onOpenSources} onOpenJob={onOpenJob} onOpenSettings={onOpenSettings} onChanged={onChanged} className="mineru-history" />}

    </section>
  );
}
