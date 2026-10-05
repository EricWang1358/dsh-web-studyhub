import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Disclosure, Hint, Icon, InlineMessage, ProgressBar, RadioCard, RadioCardGroup } from './components/index.js';
import { PrivacyConfirm, privacyNote } from './MineruSettings.jsx';
import { chooseRoute, localEstimate, minutesOf, pageRange, uploadPdf } from './mineru-flow.js';
import { formatBytes } from './components/FileDrop.jsx';
import { PdfConvertHistory } from './PdfConvertJob.jsx';
import css from './mineru.css';
import { useMineruState } from './use-mineru.js';
import { useLiveEffect } from './use-async.js';

/* Both entry points share one staged PDF. Choosing a converter never reuploads it;
   only an explicit start hands the file to a background conversion job. */

const ACCEPT = '.pdf,application/pdf';

function RouteCard({ group = 'mineru-route', id, value, current, title, chips, children, onSelect, disabled }) {
  return <RadioCard id={id} name={group} value={value} checked={current === value} title={title} badges={chips} disabled={disabled} onSelect={onSelect} data-route={value}>{children}</RadioCard>;
}

const chip = (text, tone = 'neutral') => <Badge size="sm" tone={tone}>{text}</Badge>;

function planHeading(adaptive, pieces, route) {
  if (adaptive) return ui('分段会按这台电脑的速度调整');
  if (pieces > 1) return uiFormat('这本书会分 {0} 段处理', [pieces]);
  return route === 'local' ? ui('不用分段，一次处理整本书') : ui('不用分段，整份一次解析');
}

/**
 * Props: file (a File, or null to offer a picker), call(action, args), courses (the course names to file the book under),
 * onStarted({ jobId, filename, pages, route }), onOpenSettings, onFile(file) (the picker chose one; the parent keeps it),
 * compact, and initialSettings / initialLocal / initialPlan / initialRoute / initialAcknowledged (previews and tests).
 * The 解析历史 (every conversion, cloud and local, with its result) is part of the panel unless it is compact: `jobs` (the snapshot's job list, so
 * the history refreshes when a conversion ends), `onOpenSources(sourceIds)` to jump to an imported document, `onOpenJob(row)` to show a running one,
 * `historyOpen` to start with the history expanded, and initialHistory / historyNow (previews and tests).
 */
export default function PdfConversion({ available = true, initialConverter = 'mineru', initialMarker = null, file = null, call, courses = [], onStarted, onOpenSettings, onFile, compact = false,
  initialSettings = null, initialLocal = null, initialPlan = null, initialRoute = null, initialAcknowledged = false, className,
  jobs, act, onOpenSources, onOpenJob, onChanged, historyOpen = false, initialHistory = null, historyNow, ...rest }) {
  useInjectCss(css, 'study-mineru');
  const [converter, setConverter] = useState(initialConverter), [marker, setMarker] = useState(initialMarker);
  useEffect(() => { setConverter(initialConverter); }, [initialConverter]);
  const isMarker = converter === 'marker';
  const { settings, local, setSettings } = useMineruState({ call, initialSettings, initialLocal, enabled: available });
  const [plan, setPlan] = useState(initialPlan), [reading, setReading] = useState(null), [problem, setProblem] = useState('');
  const [choice, setChoice] = useState(initialRoute), [agreed, setAgreed] = useState(initialAcknowledged), [starting, setStarting] = useState(false);
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

  const auto = chooseRoute({ local, settings });
  const route = isMarker ? 'local' : choice || auto;
  const localReady = (isMarker ? marker : local)?.state === 'ready', cloudSet = !!settings?.token?.set;
  const usable = available && (route === 'local' ? localReady : cloudSet);
  const acknowledged = !!settings?.acknowledged || agreed;
  const pieces = plan ? (route === 'local' ? plan.windows : plan.pieces) : null;
  /* The local route cuts the book into windows one at a time, from the speed it measures (plan.adaptive): before it starts there is no list of windows and no count to show,
     only what it will do. A fixed plan (the seam of a test or a preview) still lists its windows. */
  const adaptiveLocal = route === 'local' && !!plan?.adaptive && plan.pages > plan.adaptive.firstPages;
  const pieceCount = adaptiveLocal ? 0 : pieces?.length || 0;
  const estimate = !isMarker && plan && local?.tier ? localEstimate(plan.pages, local.tier, local.estimates) : null;


  const start = async () => {
    if (!available || !file || !plan || starting) return;
    const selectedUpload = uploadId.current;
    setStarting(true); setProblem('');
    try {
      if (route === 'cloud' && !settings?.acknowledged) { const next = await call('mineru.settings.set', { acknowledge: true }); if (alive.current) setSettings(next); }
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

  const gate = !usable && <InlineMessage tone="info" boxed>
    {!available ? ui('此安装未启用 PDF 解析组件。请在设置查看启用方式或手动转换说明。') : isMarker ? ui('先在设置里安装或配置 Marker。') : route === 'cloud' ? ui('先在设置里配置 MinerU 云端令牌。') : ui('先在设置里准备本机 MinerU。')}
    {onOpenSettings && <Button variant="link" onClick={() => onOpenSettings(isMarker ? 'settings-marker' : 'settings-mineru')}>{ui('打开设置')}</Button>}
  </InlineMessage>;

  return (
    <section className={`mineru-route-panel${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`} aria-label={ui('PDF 解析方案')} data-route={route} {...rest}>
      <header className="mineru-route-panel__head">
        <Icon name="file" size={20} />
        <div>
          <h3>{ui('解析 PDF')}</h3>
          <p>{ui('选择 PDF 和解析工具，完成后自动存为资料。')}</p>
        </div>
      </header>

      {!available && gate}
      {!isMarker && settings?.unavailable && <InlineMessage tone="warning" boxed>{ui('这个安装里没有启用 MinerU 解析（需要启用音频组件）。可以用下面「高级」里的手动方式。')}</InlineMessage>}

      <RadioCardGroup legend={ui('解析工具')} disabled={starting}>
        <RouteCard group={`${radioId}-converter`} id={`${radioId}-mineru`} value="mineru" current={converter} title="MinerU" onSelect={setConverter} chips={local?.state === 'ready' ? chip(ui('可用'), 'success') : chip(ui('需要设置'))}><Hint as="span">{ui('本机或云端解析')}</Hint></RouteCard>
        <RouteCard group={`${radioId}-converter`} id={`${radioId}-marker`} value="marker" current={converter} title="Marker" onSelect={setConverter} chips={marker?.state === 'ready' ? chip(ui('可用'), 'success') : chip(ui('需要设置'))}><Hint as="span">{ui('调用本机 Marker，自动导入')}</Hint></RouteCard>
      </RadioCardGroup>
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
            <strong>{planHeading(adaptiveLocal, pieceCount, route)}</strong>
            <span>{uiFormat('共 {0} 页 · {1}', [plan.pages, formatBytes(plan.bytes)])}</span>
          </p>
          <Disclosure summary={ui('分段与页码详情')}>
          {adaptiveLocal && <p className="mineru-plan__why">{uiFormat('先做 {0} 页看一看这台电脑有多快，再按它的速度调整每段的页数（每段约 {1} 秒，{2}–{3} 页）。', [plan.adaptive.firstPages, plan.adaptive.targetSeconds, plan.adaptive.minPages, plan.adaptive.maxPages])}</p>}
          {pieceCount > 1 && <p className="mineru-plan__why">
            {route === 'local' ? uiFormat('本地按每 {0} 页一段推进，这样能看到进度、随时停下，出错也只重做那一段。', [local?.windowPages || 50])
              : plan.byChapters ? ui('云端一次最多 200 页，所以按章节书签分段；超过上限的章节在 200 页处切开。')
                : ui('云端一次最多 200 页，所以每 200 页切一段；某一段文件太大时会自动再切细。')}
          </p>}
          {pieceCount > 1 && <Disclosure summary={ui('各段的页码')} meta={uiFormat('{0} 段', [pieceCount])} className="mineru-plan__list">
            <ol>{pieces.map(piece => <li key={piece.index}>{uiFormat('第 {0} 段 · 第 {1} 页', [piece.index, pageRange(piece.startPage, piece.endPage)])}</li>)}</ol>
            {route === 'cloud' && plan.maySplitFurther && <Hint size="xs">{ui('文件很大，实际开始后可能会分得更细。')}</Hint>}
          </Disclosure>}
          </Disclosure>
        </div>}

        {!isMarker && <RadioCardGroup legend={ui('用哪种方式解析')} disabled={starting}>
          <RouteCard id={`${radioId}-local`} value="local" current={route} onSelect={setChoice} title={ui('本地 mineru')}
            chips={<>{chip(ui('推荐'))}{chip(ui('免费 · 不上传'), 'success')}{localReady ? chip(ui('可用'), 'success') : chip(local ? ui('需要设置') : ui('检测中…'))}</>}>
            <Hint as="span">{localReady
              ? (estimate ? uiFormat('约 {0} 分钟（估算：{1} 档每页约 {2} 秒，实际取决于这台电脑）', [minutesOf(estimate), local.tier, local.estimates?.[local.tier]]) : ui('文档不会离开这台电脑。'))
              : ui('文档不会离开这台电脑；需要本机装好 mineru 并下载模型。')}</Hint>
          </RouteCard>
          <RouteCard id={`${radioId}-cloud`} value="cloud" current={route} onSelect={setChoice} title={ui('用 MinerU 云端解析')}
            chips={<>{chip(ui('暂不可用'))}{cloudSet ? chip(ui('令牌已设置'), 'info') : chip(ui('需要令牌'))}</>}>
            <Hint as="span">{ui('云端暂不可用，优先使用本地模型。恢复后可手动选择云端；已保存令牌不代表服务可用。')}</Hint>
            <Hint as="span">{privacyNote()}</Hint>
          </RouteCard>
        </RadioCardGroup>}
        {isMarker && plan && <p className="mineru-plan" role="status">{uiFormat('共 {0} 页 · {1}', [plan.pages, formatBytes(plan.bytes)])}</p>}

        {available && gate}

        {usable && route === 'cloud' && !settings?.acknowledged && <PrivacyConfirm checked={agreed} onChange={setAgreed} disabled={starting} />}
        {usable && route === 'cloud' && settings?.acknowledged && <p className="mineru-acked"><Icon name="success" size={16} />{ui('已确认：文档会上传到 MinerU 的云端。')}</p>}
        {usable && route === 'local' && <p className="mineru-acked"><Icon name="success" size={16} />{isMarker ? ui('在 StudyHub 所在电脑运行，结果自动导入。') : ui('本地解析：不会上传任何内容，也不需要令牌。')}</p>}

        {problem && <InlineMessage tone="error" boxed>{problem}</InlineMessage>}
        <div className="mineru-start">
          <Button variant="primary" icon="sparkle" busy={starting} disabled={!plan || !usable || (route === 'cloud' && !acknowledged)} onClick={start}>
            {isMarker ? ui('用 Marker 开始解析') : route === 'local' ? ui('开始本地解析') : ui('开始云端解析')}
          </Button>
          {onFile && <Button variant="quiet" disabled={starting} onClick={() => onFile(null)}>{ui('换一份 PDF')}</Button>}
        </div>
      </>}

      {!compact && available && <PdfConvertHistory call={call} act={act} jobs={jobs} collapsible defaultOpen={historyOpen} initialRecords={initialHistory} now={historyNow}
        onOpenSources={onOpenSources} onOpenJob={onOpenJob} onOpenSettings={onOpenSettings} onChanged={onChanged} className="mineru-history" />}

    </section>
  );
}
