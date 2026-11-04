import React, { useContext, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, ConfirmDialog, Hint, InlineMessage, JobRow, LoadingState, Tooltip, useToast } from './components/index.js';
import { useLiveEffect } from './use-async.js';
import { usePolling } from './use-polling.js';
import { StudyServicesContext, useStudy } from './study-context.jsx';
import { LOOPBACK_STATUS, installArgs, loopbackCardState, loopbackFix, loopbackProgress, loopbackStageName, loopbackStageStates, loopbackTip } from './live-loopback-flow.js';
import InstallStages from './install/InstallStages.jsx';
import LocationChooser from './install/LocationChooser.jsx';
import mineruCss from './mineru-install.css';
import css from './live-local.css';

/* 电脑声音直采组件（热插拔）: on-demand WASAPI loopback helper card (lib/live-loopback-install.js).
   Shown inline in 课堂实录 when computer audio is selected on Windows before the helper is installed, and in Settings › 音频转写 (`settings`: with one-click uninstall).
   Reuses the single-owner classes of ui/live-local.css and ui/mineru-install.css. */

const LOCATION_PROBLEMS = ['no-space', 'not-writable', 'folder-in-use', 'bad-location'];

const TipBadge = ({ tip, tone, children }) => (tip
  ? <Tooltip layer content={tip}><span tabIndex={0} className="live-local-card__tipped"><Badge size="sm" tone={tone}>{children}</Badge></span></Tooltip>
  : <Badge size="sm" tone={tone}>{children}</Badge>);

export default function LiveLoopbackCard({ call: given, settings = false, hideUnsupported = false, initialStatus = null, initialPlan = null, pickDirectory, onReady, onRemoved, className }) {
  useInjectCss(mineruCss, 'study-mineru-install');
  useInjectCss(css, 'study-live-local');
  const services = useContext(StudyServicesContext), call = given || services?.call;
  const toast = useToast(), study = useStudy(), pick = pickDirectory || study.host?.pickDirectory;
  const usable = typeof call === 'function';
  const [status, setStatus] = useState(initialStatus), [plan, setPlan] = useState(initialPlan), [planning, setPlanning] = useState(false);
  const [location, setLocation] = useState(''), [choosing, setChoosing] = useState(false), [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(''), [error, setError] = useState('');
  const alive = useRef(true), flight = useRef(false), skipPlan = useRef(!!initialPlan), readyOnce = useRef(onReady), removedOnce = useRef(onRemoved);
  useEffect(() => { readyOnce.current = onReady; removedOnce.current = onRemoved; });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const read = () => (usable ? Promise.resolve(call('live.loopback.status', {})).then(next => { if (alive.current) setStatus(next); return next; },
    failure => { if (alive.current) setError(errorMessage(failure)); return null; }) : Promise.resolve(null));
  useLiveEffect(live => { if (!initialStatus && usable) void read().then(next => { if (!live()) return; if (next?.ready) readyOnce.current?.(next); }); }, [usable]);
  const shown = loopbackCardState(status);
  usePolling(async () => {
    const next = await read();
    if (next && next.status !== 'running') {
      if (next.ready) { toast.success(ui('电脑声音直采组件可以用了。')); readyOnce.current?.(next); }
      return { running: false };
    }
    return { running: true };
  }, { intervalMs: 800, enabled: usable && shown.state === 'installing' });

  const wantsPlan = usable && (['not-installed', 'error', 'paused'].includes(shown.state) || choosing);
  useLiveEffect(live => {
    if (!wantsPlan) return;
    if (skipPlan.current) { skipPlan.current = false; return; }
    setPlanning(true);
    Promise.resolve(call('live.loopback.plan', location ? { location } : {}))
      .then(value => { if (live()) setPlan(value); }, failure => { if (live()) setError(errorMessage(failure)); })
      .finally(() => { if (live()) setPlanning(false); });
  }, [wantsPlan, location]);

  if (hideUnsupported && (shown.state === 'unsupported' || shown.state === 'checking')) return null;

  const act = async (name, work) => {
    if (flight.current || !usable) return;
    flight.current = true; setWorking(name); setError('');
    try { await work(); } catch (failure) { if (alive.current) setError(errorMessage(failure)); } finally { flight.current = false; if (alive.current) setWorking(''); }
  };
  const folder = () => location || status?.folder || plan?.folder || '';
  const install = (where = folder()) => act('start', async () => {
    const next = await call('live.loopback.install', installArgs({ location: where, current: status?.folder || '' }));
    setStatus(next);
    setChoosing(false);
    if (next?.ready) { toast.success(ui('电脑声音直采组件可以用了。')); readyOnce.current?.(next); }
    else toast.info(ui('正在生成电脑声音组件…'));
  });
  const cancel = () => act('cancel', async () => { setStatus(await call('live.loopback.cancel', {})); toast.info(ui('已取消安装。')); });
  const remove = async () => {
    const result = await call('live.loopback.uninstall', { confirm: true });
    setStatus(result);
    removedOnce.current?.(result);
    toast.success(uiFormat('已卸载，移除了 {0} 里 StudyHub 创建的内容。', [(result.removedFolders || []).join('、')]));
  };
  const fix = action => {
    if (action.id === 'relocate') { setChoosing(true); return undefined; }
    return install(status?.folder || folder());
  };

  const text = LOOPBACK_STATUS[shown.state];
  const head = <div className="live-local-card__head">
    <strong className="live-local-card__name">{ui('电脑声音直采组件（热插拔）')}</strong>
    <TipBadge tip={shown.state === 'ready' ? loopbackTip() : ''} tone={text.tone}>{text.badge()}</TipBadge>
    <Tooltip layer content={loopbackTip()}><span tabIndex={0} className="live-local-card__about">{ui('它怎么工作')}</span></Tooltip>
  </div>;
  const line = <p className="live-local-card__line" role="status" aria-live="polite">{text.sentence(status)}</p>;

  const blocking = plan?.problems?.[0] || null;
  const canStart = !!plan && !blocking && !planning && !working;
  const stepsTip = ui('会依次：在本地生成只读采音组件（小于 1 MB，无需联网下载）→ 自检 Windows 共享环回接口。不安装任何虚拟声卡驱动，不需要管理员权限，不用时可一键卸载。');
  const chooser = <LocationChooser plan={plan} location={location} pickDirectory={pick} disabled={!!working} onChoose={setLocation} onClose={() => setChoosing(false)} />;
  const offer = <div className="mineru-install__offer">
    <div className="mineru-install__where">
      <span className="mineru-install__label">{ui('安装位置')}</span>
      <code translate="no">{folder() || '…'}</code>
      {!choosing && <Button size="sm" variant="secondary" icon="location" lock={!!working} onClick={() => setChoosing(true)}>{ui('选择位置')}</Button>}
    </div>
    {choosing && chooser}
    <p className="mineru-install__facts" aria-busy={planning || !plan || undefined}>{plan && !planning
      ? ui('无需联网下载 · 占用小于 1 MB · 平时零后台驻留')
      : <LoadingState inline label={ui('正在计算剩余空间…')} />}</p>
    {blocking && <InlineMessage tone="error" action={LOCATION_PROBLEMS.includes(blocking.code) && !choosing ? { label: ui('换位置'), onClick: () => setChoosing(true) } : undefined}>
      {uiMessage(blocking.message)}</InlineMessage>}
    <div className="mineru-install__row">
      <Tooltip layer content={blocking ? uiMessage(blocking.message) : stepsTip}>
        <Button variant="primary" icon="download" busy={working === 'start'} aria-disabled={!canStart || undefined}
          onClick={() => { if (canStart) void install(); }}>{shown.state === 'not-installed' && !choosing ? ui('安装电脑声音组件') : ui('安装到这个位置')}</Button>
      </Tooltip>
    </div>
  </div>;
  const stages = <InstallStages stages={loopbackStageStates(status)} label={ui('安装步骤')} className="mineru-install__stages" markClassName="mineru-install__mark" />;

  let body = null;
  if (shown.state === 'checking') body = <LoadingState inline label={ui('正在检测…')} />;
  else if (shown.state === 'not-installed' || (choosing && shown.state !== 'installing')) body = offer;
  else if (shown.state === 'installing') {
    const progress = loopbackProgress(status);
    body = <JobRow status="running" stage={loopbackStageName(status?.stage)} title={ui('正在安装电脑声音组件')} meta={status?.folder || undefined}
      progress={{ value: progress.value, max: progress.max, label: ui('安装进度') }}
      actions={[{ label: ui('取消'), onClick: cancel, busy: working === 'cancel', disabled: !!working && working !== 'cancel' }]}>
      {stages}
      <Hint>{ui('通常只需 1–3 秒。')}</Hint>
    </JobRow>;
  } else if (['paused', 'error', 'repair'].includes(shown.state)) {
    const action = loopbackFix(shown.code);
    const button = <Button variant="primary" icon={action.icon} busy={working === 'start'} disabled={!!working} onClick={() => void fix(action)}>{action.label}</Button>;
    body = <div className="mineru-install__problem">{shown.state !== 'repair' && stages}
      <div className="mineru-install__row">{action.tip ? <Tooltip layer content={action.tip}>{button}</Tooltip> : button}
        {shown.state === 'repair' && settings && <Button variant="quiet" size="sm" lock={!!working} onClick={() => setAsking(true)}>{ui('卸载电脑声音组件')}</Button>}</div></div>;
  } else if (shown.state === 'unsupported') body = <Hint>{ui('macOS 与 Linux 请在独立浏览器窗口里选「标签页共享」，或改用「麦克风」。')}</Hint>;
  else if (shown.state === 'ready' && settings) body = <div className="mineru-install__row">
    <Button variant="quiet" size="sm" lock={!!working} onClick={() => setAsking(true)}>{ui('卸载电脑声音组件')}</Button></div>;

  return <section className={['live-local-card', className].filter(Boolean).join(' ')} data-loopback-state={shown.state} data-state={shown.state} aria-label={ui('电脑声音直采组件（热插拔）')}>
    {head}
    {line}
    {body}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {asking && <ConfirmDialog title={ui('卸载电脑声音组件？')} confirmLabel={ui('卸载')} onConfirm={remove} onClose={() => setAsking(false)}>
      <p>{uiFormat('会删除 StudyHub 在 {0} 里生成的采音组件（小于 1 MB）。已经保存的课堂实录不受影响；以后要用再点安装即可。', [status?.installedFolder || status?.folder || ''])}</p>
    </ConfirmDialog>}
  </section>;
}
