import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Checkbox, ConfirmDialog, Disclosure, Hint, Icon, InlineMessage, ProgressBar, RadioCard, RadioCardGroup, SegmentedControl, Tooltip } from './components/index.js';
import { isConvertJob, localEstimate, minutesOf, pageRange } from './mineru-flow.js';
import { canPickNative, isNativeSource, pickNativePdf, prepareSource, sourceArgs } from './pdf-source.js';
import { formatBytes } from './components/FileDrop.jsx';
import { PdfConvertHistory } from './PdfConvertJob.jsx';
import PdfExternalConvertGuide from './PdfExternalConvertGuide.jsx';
import css from './mineru.css';
import { useMineruState } from './use-mineru.js';
import { STATUS_TEXT, cardState, mineruUsable } from './mineru-install-flow.js';
import MineruInstallCard from './MineruInstallCard.jsx';
import { useLiveEffect } from './use-async.js';
import { StudyServicesContext, useStudy } from './study-context.jsx';
import { isActiveJob } from './job-visibility.js';

/* Both entry points share one staged PDF. Choosing a converter or route never reuploads it;
   only an explicit start hands the file to a background conversion job.
   Default is always local (zero upload). Cloud / third-party API is optional and gated by a first-use
   upload confirmation dialog showing the destination endpoint before any PDF leaves the computer. */

const ACCEPT = '.pdf,application/pdf';
const DEFAULT_BASE_URL = 'https://mineru.net/api/v4';

const hostOf = url => {
  try { return new URL(url || DEFAULT_BASE_URL).host; }
  catch { return 'mineru.net'; }
};

function RouteCard({ group = 'mineru-converter', id, value, current, title, chips, children, onSelect, disabled }) {
  return <RadioCard id={id} name={group} value={value} checked={current === value} title={title} badges={chips} disabled={disabled} onSelect={onSelect} data-route={value}>{children}</RadioCard>;
}

const chip = (text, tone = 'neutral') => <Badge size="sm" tone={tone}>{text}</Badge>;

function planHeading(adaptive, pieces) {
  if (adaptive) return ui('分段会按这台电脑的速度调整');
  if (pieces > 1) return uiFormat('这本书会分 {0} 段处理', [pieces]);
  return ui('不用分段，一次处理整本书');
}

export default function PdfConversion({ available = true, initialConverter = 'mineru', initialMarker = null, file = null, courses = [], onStarted, onOpenSettings, onFile, compact = false,
  initialLocal = null, initialSettings = null, initialPlan = null, initialConfirmUpload = false, className,
  jobs, onOpenSources, onOpenJob, onChanged, historyOpen = false, initialHistory = null, historyNow, ...rest }) {
  useInjectCss(css, 'study-mineru');
  const { call } = useStudy();
  const [converter, setConverter] = useState(initialConverter), [marker, setMarker] = useState(initialMarker);
  useEffect(() => { setConverter(initialConverter); }, [initialConverter]);
  const isMarker = converter === 'marker';
  const { local, settings, setSettings } = useMineruState({ call, initialLocal, initialSettings, enabled: available });
  const [mineruRoute, setMineruRoute] = useState(() => (initialSettings?.mode === 'cloud' ? 'cloud' : 'local'));
  const routeTouched = useRef(false);
  useEffect(() => {
    if (!routeTouched.current && (settings?.mode === 'cloud' || settings?.mode === 'local')) setMineruRoute(settings.mode);
  }, [settings?.mode]);

  const [plan, setPlan] = useState(initialPlan), [reading, setReading] = useState(null), [problem, setProblem] = useState('');
  const [starting, setStarting] = useState(false), [review, setReview] = useState(false);
  const [confirmUpload, setConfirmUpload] = useState(initialConfirmUpload);
  const uploadId = useRef(''), picker = useRef(null), alive = useRef(true), taken = useRef(false);
  const radioId = useId();
  const host = useContext(StudyServicesContext)?.host, nativeOn = canPickNative(host), [own, setOwn] = useState(null), picked = own || file;
  const chooseNative = async () => {
    try { const source = await pickNativePdf(host); if (source) { setOwn(source); onFile?.(source); } }
    catch { setProblem(ui('无法打开文件选择器，请直接把文件拖到这里。')); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useLiveEffect(live => {
    if (!available || typeof call !== 'function') return;
    if (!initialMarker) Promise.resolve(call('marker.local.status', {})).then(value => { if (live()) setMarker(value); }, () => { if (live()) setMarker({ state: 'unavailable' }); });
  }, []);

  useEffect(() => {
    if (!available || !picked || typeof call !== 'function' || initialPlan) return undefined;
    const controller = new AbortController();
    let pending = '', handedOff = false;
    setPlan(null); setProblem(''); setReading(isNativeSource(picked) ? null : 0); taken.current = false;
    (async () => {
      try {
        const prepared = await prepareSource(call, picked, { signal: controller.signal, onUploaded: id => { pending = id; },
          onProgress: fraction => { if (alive.current && !controller.signal.aborted) setReading(fraction); } });
        if (!prepared) return;
        uploadId.current = prepared.uploadId;
        if (alive.current && !controller.signal.aborted) { setPlan(prepared.plan); setReading(null); }
      } catch (error) {
        if (controller.signal.aborted || !alive.current) return;
        setReading(null); setProblem(errorMessage(error));
      }
    })();
    return () => {
      controller.abort();
      handedOff = taken.current;
      if (uploadId.current === pending) uploadId.current = '';
      if (pending && !handedOff) Promise.resolve(call('mineru.upload.cancel', { uploadId: pending })).catch(() => {});
    };
  }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const route = isMarker ? 'local' : mineruRoute;
  const isCloud = !isMarker && route === 'cloud';
  const localReady = isMarker ? marker?.state === 'ready' : mineruUsable(local);
  const cloudReady = !!settings?.token?.set;
  const stopped = !isMarker && !isCloud && localReady && local?.state === 'server-stopped';
  const usable = available && (isCloud ? cloudReady : localReady);
  const pieces = plan ? (isCloud ? (plan.pieces || [{ index: 1, startPage: 1, endPage: plan.pages, pages: plan.pages }]) : plan.windows) : null;
  const adaptiveLocal = !isCloud && !!plan?.adaptive && plan.pages > plan.adaptive.firstPages;
  const pieceCount = adaptiveLocal ? 0 : pieces?.length || 0;
  const tier = local?.tier || local?.install?.tier;
  const estimate = !isMarker && !isCloud && plan && tier ? localEstimate(plan.pages, tier, local.estimates) : null;
  const effectiveUrl = settings?.effectiveBaseUrl || plan?.effectiveBaseUrl || DEFAULT_BASE_URL;
  const endpoint = hostOf(effectiveUrl);

  const runImport = async chosenRoute => {
    if (!available || !picked || !plan || starting) return;
    const selectedUpload = uploadId.current;
    setStarting(true); setProblem('');
    try {
      taken.current = true;
      const job = await call(isMarker ? 'marker.import' : 'mineru.import', {
        ...sourceArgs(picked, selectedUpload),
        ...(isMarker ? {} : { route: chosenRoute }),
        ...(courses.length ? { courses } : {}),
        ...(review ? { reviewBeforeImport: true } : {}),
      });
      uploadId.current = '';
      if (alive.current) onStarted?.({ ...job, filename: picked.name, pages: plan.pages, route: chosenRoute, converter });
    } catch (error) {
      taken.current = false;
      if (!alive.current && selectedUpload) Promise.resolve(call('mineru.upload.cancel', { uploadId: selectedUpload })).catch(() => {});
      if (alive.current) setProblem(errorMessage(error));
    } finally { if (alive.current) setStarting(false); }
  };

  const start = async () => {
    if (!available || !picked || !plan || starting || !usable) return;
    if (isCloud && !settings?.acknowledged) {
      setConfirmUpload(true);
      return;
    }
    await runImport(route);
  };

  const confirmAndStartCloud = async () => {
    const next = await call('mineru.settings.set', { acknowledge: true });
    setSettings(next);
    setConfirmUpload(false);
    await runImport('cloud');
  };

  const gate = !usable && (available && !isMarker && !isCloud
    ? <MineruInstallCard compact initialLocal={local} onOpenSettings={onOpenSettings ? section => onOpenSettings(section, { file }) : undefined} />
    : <InlineMessage tone="info" boxed>
      {!available
        ? ui('PDF 解析是音频组件的一部分，而音频组件没有启用。在 DSH 插件管理器里启用它，这里就能用。')
        : isCloud
          ? ui('还没有填写云端密钥（Key）：请先在设置里配置接口地址与密钥，或切回「本机（默认）」。')
          : ui('先在设置里安装或配置 Marker。')}
      {onOpenSettings && available && <Button iconEnd="arrow-right" variant="link" className="mineru-route-panel__btn" onClick={() => onOpenSettings(isMarker ? 'settings-marker' : 'settings-mineru', { file })}>{ui('前往设置')}</Button>}
    </InlineMessage>);

  const mineruCard = cardState(local), mineruText = STATUS_TEXT[mineruCard.state];
  const mineruChip = (isCloud ? cloudReady : mineruUsable(local)) ? chip(ui('可用'), 'success')
    : (!isCloud && (local == null || (gate && converter === 'mineru'))) ? null
      : isCloud ? chip(ui('需要设置')) : chip(mineruText.badge(), mineruText.tone);
  const tools = <RadioCardGroup legend={ui('解析工具')} disabled={starting}>
    <RouteCard group={`${radioId}-converter`} id={`${radioId}-mineru`} value="mineru" current={converter} title="MinerU" onSelect={setConverter} chips={mineruChip}><Hint as="span">{isCloud ? ui('使用云端或第三方接口（会上传文件）') : ui('在本机解析，不上传')}</Hint></RouteCard>
    <RouteCard group={`${radioId}-converter`} id={`${radioId}-marker`} value="marker" current={converter} title="Marker" onSelect={setConverter} chips={marker?.state === 'ready' ? chip(ui('可用'), 'success') : chip(ui('需要设置'))}><Hint as="span">{review ? ui('调用本机 Marker，转换好后先等你改') : ui('调用本机 Marker，自动导入')}</Hint></RouteCard>
  </RadioCardGroup>;
  const showSwitcherInline = isMarker || marker?.state === 'ready';
  const compactSwitcher = <SegmentedControl className="mineru-tools" label={ui('解析工具')} value={converter} disabled={starting} onChange={setConverter}
    options={[{ value: 'mineru', label: 'MinerU' }, { value: 'marker', label: 'Marker' }]} />;
  const routeSwitcher = !isMarker && (
    <SegmentedControl className="mineru-routes" label={ui('解析方式')} value={mineruRoute} disabled={starting}
      onChange={next => { routeTouched.current = true; setMineruRoute(next); setProblem(''); }}
      options={[{ value: 'local', label: ui('本机（默认）') }, { value: 'cloud', label: ui('云端（会把文件上传）') }]} />
  );
  return (
    <section className={`mineru-route-panel${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`} aria-label={ui('PDF 解析方案')} data-route={route} {...rest}>
      {!compact && <header className="mineru-route-panel__head">
        <Icon name="file" size={20} className="mineru-route-panel__icon" />
        <div>
          <h3>{ui('解析 PDF')}</h3>
          <p>{review ? ui('选择 PDF，默认用本机 MinerU 解析，转换好后先等你改再存为资料。') : ui('选择 PDF，默认用本机 MinerU 解析，完成后自动存为资料。')}</p>
        </div>
      </header>}

      {!available && gate}

      {showSwitcherInline && (compact ? compactSwitcher : tools)}
      {available && routeSwitcher}

      {!picked && <div className="mineru-pick">
        {nativeOn ? <Button variant="primary" icon="upload" className="mineru-route-panel__btn" data-pick="native" disabled={!available} onClick={chooseNative}>{ui('选择 PDF…')}</Button> : <>
          <input ref={picker} type="file" accept={ACCEPT} className="sh-visually-hidden" tabIndex={-1} aria-hidden="true"
            onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) onFile?.(chosen); }} />
          <Button variant="primary" icon="upload" className="mineru-route-panel__btn" data-pick="browser" disabled={!available} onClick={() => picker.current?.click()}>{ui('选择 PDF…')}</Button></>}
        <small>{ui('只在这台电脑上读取，确认之后才会开始解析。')}</small>
      </div>}

      {picked && <>
        <p className="mineru-file"><strong>{picked.name}</strong><span>{formatBytes(picked.size ?? plan?.bytes)}</span>
          {nativeOn && !isNativeSource(picked) && <Button variant="quiet" size="sm" lock={starting} onClick={chooseNative}>{ui('不复制这个文件：选择本机文件…')}</Button>}</p>
        {reading !== null && <div className="mineru-reading">
          <ProgressBar value={Math.round(reading * 100)} max={100} label={ui('正在读取这份 PDF')} size="sm" />
          <small>{uiFormat('正在读取这份 PDF（只在这台电脑上），{0}%', [Math.round(reading * 100)])}</small>
        </div>}
        {plan && !isMarker && <div className="mineru-plan" role="status">
          <p className="mineru-plan__line">
            <strong>{planHeading(adaptiveLocal, pieceCount)}</strong>
            <span>{uiFormat('共 {0} 页 · {1}', [plan.pages, formatBytes(plan.bytes)])}</span>
          </p>
          {isCloud && <p className="mineru-plan__estimate">{uiFormat('目标接口：{0}', [endpoint])}</p>}
          {!isCloud && localReady && estimate && <p className="mineru-plan__estimate">{uiFormat('约 {0} 分钟（估算：每页约 {1} 秒，实际取决于这台电脑）', [minutesOf(estimate), local.estimates?.[tier]])}</p>}
          <Disclosure summary={ui('分段与页码详情')}>
            {adaptiveLocal && <p className="mineru-plan__why">{uiFormat('先做 {0} 页看一看这台电脑有多快，再按它的速度调整每段的页数（每段约 {1} 秒，{2}–{3} 页）。', [plan.adaptive.firstPages, plan.adaptive.targetSeconds, plan.adaptive.minPages, plan.adaptive.maxPages])}</p>}
            {isCloud && pieceCount > 1 && <p className="mineru-plan__why">
              {ui('云端单次最多处理 200 页或 200 MB，超长书籍会自动分段上传并合并结果。')}
            </p>}
            {!isCloud && pieceCount > 1 && <p className="mineru-plan__why">
              {uiFormat('本地按每 {0} 页一段推进，这样能看到进度、随时停下，出错也只重做那一段。', [local?.windowPages || 50])}
            </p>}
            {pieceCount > 1 && <Disclosure summary={ui('各段的页码')} meta={uiFormat('{0} 段', [pieceCount])} className="mineru-plan__list">
              <ol>{pieces.map(piece => <li key={piece.index}>{uiFormat('第 {0} 段 · 第 {1} 页', [piece.index, pageRange(piece.startPage, piece.endPage)])}</li>)}</ol>
            </Disclosure>}
          </Disclosure>
        </div>}

        {isMarker && plan && <p className="mineru-plan" role="status">{uiFormat('共 {0} 页 · {1}', [plan.pages, formatBytes(plan.bytes)])}</p>}

        {available && gate}

        {usable && <p className="mineru-acked"><Icon className="sh-icon--inline" name="success" />{isMarker
          ? (review ? ui('在 StudyHub 所在电脑运行，转换好后先等你改。') : ui('在 StudyHub 所在电脑运行，结果自动导入。'))
          : isCloud
            ? uiFormat('云端解析：文档将上传至 {0}。', [endpoint])
            : ui('本地解析：不会上传任何内容。')}</p>}
        {usable && stopped && <Hint>{ui('本机服务没在运行，开始解析时会先自动启动（约 1 分钟）。')}</Hint>}
        {usable && (() => {
          const active = Array.isArray(jobs) ? jobs.find(j => isConvertJob(j) && isActiveJob(j)) : null;
          return active ? <Hint>{uiFormat('当前本机引擎正在解析「{0}」；点开始后会加入队列，前序完成后自动开始。', [active.filename || ui('另一份 PDF')])}</Hint> : null;
        })()}

        {problem && <InlineMessage tone="error" boxed>{problem}</InlineMessage>}
        {usable && <Disclosure lazy summary={ui('更多设置')} className="mineru-more">
          <Tooltip layer content={ui('转换好后先停下，等你删掉识别错的文字再导入；不打开就是转换完自动导入。已经导入的资料不会变：重新转换同一份 PDF 会存成另一份资料，等你导入的文字也不会被覆盖。')}>
            <Checkbox label={ui('导入前先让我改')} checked={review} disabled={starting} onChange={setReview} data-review-before-import />
          </Tooltip>
        </Disclosure>}
        <div className="mineru-start">
          <Button variant="primary" icon="sparkle" className="mineru-route-panel__btn" busy={starting} disabled={!plan || !usable} onClick={start}>
            {isMarker ? ui('用 Marker 开始解析') : isCloud ? ui('开始云端解析') : ui('开始本地解析')}
          </Button>
          {(onFile || own) && <Button variant="quiet" className="mineru-route-panel__btn" lock={starting} onClick={() => { setOwn(null); onFile?.(null); }}>{ui('换一份 PDF')}</Button>}
        </div>
      </>}

      {!showSwitcherInline && <Disclosure summary={ui('换用其他本机引擎：Marker')} meta={ui('备选')} className="mineru-more">
        {compact ? compactSwitcher : tools}
      </Disclosure>}

      {!compact && <PdfExternalConvertGuide />}

      {!compact && available && <PdfConvertHistory jobs={jobs} collapsible defaultOpen={historyOpen} initialRecords={initialHistory} now={historyNow}
        onOpenSources={onOpenSources} onOpenJob={onOpenJob} onOpenSettings={onOpenSettings} onChanged={onChanged} className="mineru-history" />}

      {confirmUpload && (
        <ConfirmDialog
          title={ui('首次使用前确认上传')}
          tone="primary"
          confirmLabel={ui('确认上传并开始解析')}
          cancelLabel={ui('取消')}
          onClose={() => setConfirmUpload(false)}
          onConfirm={confirmAndStartCloud}
        >
          <div className="mineru-upload-confirm">
            <p>{uiFormat('「{0}」将会上传到以下云端接口进行解析：', [picked?.name || 'PDF'])}</p>
            <p className="mineru-upload-confirm__url"><code translate="no">{effectiveUrl}</code></p>
            <p>{ui('如果不希望上传文件，可以点「取消」并切回「本机（默认）」解析。')}</p>
            <Hint>{ui('确认后会记住对当前接口的授权，以后不再重复提示；随时可以在设置里撤回。')}</Hint>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}
