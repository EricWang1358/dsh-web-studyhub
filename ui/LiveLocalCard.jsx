import React, { useContext, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, ConfirmDialog, Hint, InlineMessage, JobRow, LoadingState, Tooltip, useToast } from './components/index.js';
import { useLiveEffect } from './use-async.js';
import { usePolling } from './use-polling.js';
import { StudyServicesContext, useStudy } from './study-context.jsx';
import { sizeLabel } from './mineru-flow.js';
import { VC_REDIST_URL } from './mineru-install-flow.js';
import { LOCAL_STATUS, localCardState, localFix, localProgress, localStageName, localStageStates, localTip } from './live-local-flow.js';
import InstallStages from './install/InstallStages.jsx';
import LocationChooser from './install/LocationChooser.jsx';
import mineruCss from './mineru-install.css';
import css from './live-local.css';

/* 本地（不联网）: the local engine of 课堂实录 (lib/live-local.js) as one card with its setup gate: not installed -> one button -> progress -> ready. Shown in
   课堂实录 where a learner without a key would otherwise be stuck, and in Settings › 音频转写 next to the live provider choice (`settings`: where it can be
   removed). Nothing is installed before the click; the backend (lib/live-local-install.js) verifies every file against its pinned checksum, can be
   paused and continued, and shows in the task console. The location row and its chooser are the one-click MinerU install's (ui/install/). */

const LOCATION_PROBLEMS = ['no-space', 'not-writable', 'folder-in-use', 'bad-location'];

/** A Badge that explains itself on hover and keyboard focus (never a title attribute). */
const TipBadge = ({ tip, tone, children }) => (tip
  ? <Tooltip layer content={tip}><span tabIndex={0} className="live-local-card__tipped"><Badge size="sm" tone={tone}>{children}</Badge></span></Tooltip>
  : <Badge size="sm" tone={tone}>{children}</Badge>);

export default function LiveLocalCard({ call: given, settings = false, initialStatus = null, initialPlan = null, pickDirectory, onReady, className }) {
  useInjectCss(mineruCss, 'study-mineru-install');
  useInjectCss(css, 'study-live-local');
  const services = useContext(StudyServicesContext), call = given || services?.call;
  const toast = useToast(), study = useStudy(), pick = pickDirectory || study.host?.pickDirectory;
  const usable = typeof call === 'function';
  const [status, setStatus] = useState(initialStatus), [plan, setPlan] = useState(initialPlan), [planning, setPlanning] = useState(false);
  const [location, setLocation] = useState(''), [choosing, setChoosing] = useState(false), [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(''), [error, setError] = useState('');
  const alive = useRef(true), flight = useRef(false), skipPlan = useRef(!!initialPlan), readyOnce = useRef(onReady);
  useEffect(() => { readyOnce.current = onReady; });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const read = () => (usable ? Promise.resolve(call('live.local.status', {})).then(next => { if (alive.current) setStatus(next); return next; },
    failure => { if (alive.current) setError(errorMessage(failure)); return null; }) : Promise.resolve(null));
  useLiveEffect(live => { if (!initialStatus && usable) void read().then(next => { if (!live()) return; if (next?.ready) readyOnce.current?.(next); }); }, [usable]);
  const shown = localCardState(status);
  usePolling(async () => {
    const next = await read();
    if (next && next.status !== 'running') {
      if (next.ready) { toast.success(ui('本地引擎可以用了：不联网也能实录。')); readyOnce.current?.(next); }
      return { running: false };
    }
    return { running: true };
  }, { intervalMs: 1500, enabled: usable && shown.state === 'installing' });

  const wantsPlan = usable && (['not-installed', 'error', 'paused'].includes(shown.state) || choosing);
  useLiveEffect(live => {
    if (!wantsPlan) return;
    if (skipPlan.current) { skipPlan.current = false; return; }
    setPlanning(true);
    Promise.resolve(call('live.local.plan', location ? { location } : {}))
      .then(value => { if (live()) setPlan(value); }, failure => { if (live()) setError(errorMessage(failure)); })
      .finally(() => { if (live()) setPlanning(false); });
  }, [wantsPlan, location]);

  const act = async (name, work) => {
    if (flight.current || !usable) return;
    flight.current = true; setWorking(name); setError('');
    try { await work(); } catch (failure) { if (alive.current) setError(errorMessage(failure)); } finally { flight.current = false; if (alive.current) setWorking(''); }
  };
  const folder = () => location || status?.folder || plan?.folder || '';
  const install = (where = folder()) => act('start', async () => {
    setStatus(await call('live.local.install', { confirm: true, ...(where ? { location: where } : {}) }));
    setChoosing(false);
    toast.info(ui('已开始安装：进度在这里和「任务」里。'));
  });
  const cancel = () => act('cancel', async () => { setStatus(await call('live.local.cancel', {})); toast.info(ui('已暂停安装。')); });
  const remove = async () => {
    const result = await call('live.local.uninstall', { confirm: true });
    setStatus(result);
    toast.success(uiFormat('已删除，移除了 {0} 里 StudyHub 创建的内容。', [(result.removedFolders || []).join('、')]));
  };
  const fix = action => {
    if (action.id === 'relocate') { setChoosing(true); return undefined; }
    if (action.id === 'vc-runtime') { globalThis.open?.(VC_REDIST_URL, '_blank', 'noopener'); return undefined; }
    return install(status?.folder || folder());
  };

  const text = LOCAL_STATUS[shown.state];
  const head = <div className="live-local-card__head">
    <strong className="live-local-card__name">{ui('本地（不联网）')}</strong>
    <TipBadge tip={shown.state === 'ready' ? localTip(status) : ''} tone={text.tone}>{text.badge()}</TipBadge>
    <Tooltip layer content={localTip(status)}><span tabIndex={0} className="live-local-card__about">{ui('它怎么工作')}</span></Tooltip>
  </div>;
  const line = <p className="live-local-card__line" role="status" aria-live="polite">{text.sentence(status)}</p>;

  const blocking = plan?.problems?.[0] || null;
  const canStart = !!plan && !blocking && !planning && !working;
  const stepsTip = uiFormat('会依次：安装识别引擎（约 {0}）→ 下载识别模型（约 {1}，来自魔搭 ModelScope）→ 检查能不能用。每个文件都按固定的校验值核对，不对就删掉重下。全部装在上面的文件夹里，不需要管理员权限，随时可以暂停。',
    [sizeLabel(Math.max(1, (status?.downloadMb || 240) - (status?.modelMb || 228) - 2)), sizeLabel((status?.modelMb || 228) + 2)]);
  const chooser = <LocationChooser plan={plan} location={location} pickDirectory={pick} disabled={!!working} onChoose={setLocation} onClose={() => setChoosing(false)} />;
  const offer = <div className="mineru-install__offer">
    <div className="mineru-install__where">
      <span className="mineru-install__label">{ui('安装位置')}</span>
      <code translate="no">{folder() || '…'}</code>
      {!choosing && <Button size="sm" variant="secondary" icon="location" disabled={!!working} onClick={() => setChoosing(true)}>{ui('选择位置')}</Button>}
    </div>
    {choosing && chooser}
    <p className="mineru-install__facts" aria-busy={planning || !plan || undefined}>{plan && !planning
      ? uiFormat('首次安装下载约 {0} · 装好后占用约 {1}', [sizeLabel(plan.estimate?.downloadMb), sizeLabel(plan.estimate?.diskMb)])
      : <LoadingState inline label={ui('正在计算剩余空间…')} />}</p>
    {plan && !plan.tested && plan.supported && <Hint>{ui('这台电脑的系统用的是同一版识别引擎，但还没有在它上面测试过；装不上时课堂实录请用 Gemini。')}</Hint>}
    {blocking && <InlineMessage tone="error" action={LOCATION_PROBLEMS.includes(blocking.code) && !choosing ? { label: ui('换位置'), onClick: () => setChoosing(true) } : undefined}>
      {uiMessage(blocking.message)}</InlineMessage>}
    <div className="mineru-install__row">
      <Tooltip layer content={blocking ? uiMessage(blocking.message) : stepsTip}>
        <Button variant="primary" icon="download" busy={working === 'start'} aria-disabled={!canStart || undefined}
          onClick={() => { if (canStart) void install(); }}>{shown.state === 'not-installed' && !choosing ? ui('安装本地引擎') : ui('安装到这个位置')}</Button>
      </Tooltip>
    </div>
  </div>;
  const stages = <InstallStages stages={localStageStates(status)} label={ui('安装步骤')} className="mineru-install__stages" markClassName="mineru-install__mark" />;

  let body = null;
  if (shown.state === 'checking') body = <LoadingState inline label={ui('正在检测…')} />;
  else if (shown.state === 'not-installed' || (choosing && shown.state !== 'installing')) body = offer;
  else if (shown.state === 'installing') {
    const progress = localProgress(status);
    body = <JobRow status="running" stage={localStageName(status?.stage)} title={ui('正在安装本地实录引擎')} meta={status?.folder || undefined}
      progress={{ value: progress.value, max: progress.max, label: ui('安装进度') }}
      actions={[{ label: ui('暂停'), onClick: cancel, busy: working === 'cancel', disabled: !!working && working !== 'cancel' }]}>
      {stages}
      <Hint>{ui('可以离开这个页面；进度也在「任务」里。请不要关闭 StudyHub。')}</Hint>
    </JobRow>;
  } else if (shown.state === 'paused' || shown.state === 'error') {
    const action = localFix(shown.code);
    const button = <Button variant="primary" icon={action.icon} busy={working === 'start'} disabled={!!working} onClick={() => void fix(action)}>{action.label}</Button>;
    body = <div className="mineru-install__problem">{stages}
      <div className="mineru-install__row">{action.tip ? <Tooltip layer content={action.tip}>{button}</Tooltip> : button}</div></div>;
  } else if (shown.state === 'unsupported') body = <Hint>{ui('课堂实录请用 Gemini，或课后在「音频转写」里导入录音。')}</Hint>;
  else if (shown.state === 'ready' && settings) body = <div className="mineru-install__row">
    <Button variant="quiet" size="sm" disabled={!!working} onClick={() => setAsking(true)}>{ui('删除本地引擎')}</Button></div>;

  return <section className={['live-local-card', className].filter(Boolean).join(' ')} data-state={shown.state} aria-label={ui('本地（不联网）')}>
    {head}
    {line}
    {body}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {asking && <ConfirmDialog title={ui('删除本地实录引擎？')} confirmLabel={ui('删除')} onConfirm={remove} onClose={() => setAsking(false)}>
      <p>{uiFormat('会删除 StudyHub 在 {0} 里装的识别引擎和模型（约 {1}）。已经保存的课堂实录不受影响；以后要用再装一次。', [status?.installedFolder || status?.folder || '', sizeLabel(status?.diskMb || 260)])}</p>
    </ConfirmDialog>}
  </section>;
}
