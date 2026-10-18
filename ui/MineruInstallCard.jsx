import React, { useContext, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, ConfirmDialog, Disclosure, Hint, InlineMessage, JobRow, LoadingState, RadioCard, RadioCardGroup, Tooltip, useToast } from './components/index.js';
import { useLiveEffect } from './use-async.js';
import { StudyServicesContext, useStudy } from './study-context.jsx';
import { sizeLabel } from './mineru-flow.js';
import { STATUS_TEXT, VC_REDIST_URL, cardState, errorHint, errorReason, fixFor, installLine, installProgress, locationHint, sourceName, stageName, stageStates } from './mineru-install-flow.js';
import { refreshMineruLocal, useMineruInstall, useMineruState } from './use-mineru.js';
import { usePolling } from './use-polling.js';
import InstallStages from './install/InstallStages.jsx';
import LocationChooser from './install/LocationChooser.jsx';
import css from './mineru-install.css';

/* One-click local MinerU (settings › PDF 转换, and inline wherever a PDF is converted): a status line that always says where it stands, one location row and
   one primary button. Nothing is installed until the learner presses 一键安装: the backend (lib/mineru-install.js) puts the program, Python, the models and
   the config into one folder (by default on the non-system drive with the most room), shows each step, and can be paused and continued. Every failure
   is one short line that says what is wrong (the status line), at most one hint that adds something, and exactly one fix button. The optional choices
   (tier, download source, Python, stop, move, uninstall, the log) live in one 更多 fold, Settings only; `compact` (the import route) links there instead.
   Every slot keeps its height while it loads, so nothing moves when an answer arrives. */

const REASON = {
  faster: source => (source === 'global' ? ui('海外源比国内镜像快') : ui('国内镜像比海外源快')),
  'overseas-unreachable': () => ui('海外源 3 秒内没有响应'),
  'mainland-unreachable': () => ui('国内镜像 3 秒内没有响应'),
};
const REACH = { mainland: () => ({ text: ui('国内直连'), tone: 'success' }), global: () => ({ text: ui('需海外网络'), tone: 'warning' }) };
const DEFAULT_TIER = 'basic';
const STOPPED = ['failed', 'cancelled', 'interrupted'];

/** A Badge that explains itself on hover and keyboard focus (never a title attribute). */
const TipBadge = ({ tip, tone, children }) => (tip
  ? <Tooltip layer content={tip}><span tabIndex={0} className="mineru-install__tipped"><Badge size="sm" tone={tone}>{children}</Badge></span></Tooltip>
  : <Badge size="sm" tone={tone}>{children}</Badge>);

function sourceTip(source) {
  const why = source?.chosenBy === 'learner' ? ui('你在「更多」里选的') : REASON[source?.reason]?.(source?.id) || ui('国内镜像比海外源快');
  return `${uiFormat('自动选择：{0}。', [why])}\n${ui('国内镜像：清华 PyPI 镜像（程序）、npmmirror（Python）、魔搭 ModelScope（模型）。')}\n${ui('海外官方源：pypi.org、GitHub、Hugging Face。')}`;
}

/** The plan problems a different folder fixes: their message carries its own 换位置. */
const LOCATION_PROBLEMS = ['no-space', 'not-writable', 'folder-in-use', 'bad-location', 'path-too-long'];

export default function MineruInstallCard({ call: given, compact = false, onOpenSettings, initialLocal = null, initialPlan = null, initialMore = false, pickDirectory, className }) {
  useInjectCss(css, 'study-mineru-install');
  // `call` is the page's when it hands one (Settings, previews); inside the app the card asks the host itself (ui/study-context.jsx).
  const services = useContext(StudyServicesContext), call = given || services?.call;
  const toast = useToast(), study = useStudy(), pick = pickDirectory || study.host?.pickDirectory;
  const usable = typeof call === 'function';
  const { local, setLocal } = useMineruState({ call, initialLocal, enabled: usable });
  const [working, setWorking] = useState(''), [error, setError] = useState('');
  const [location, setLocation] = useState(''), [choosing, setChoosing] = useState(false), [moving, setMoving] = useState(false), [asking, setAsking] = useState(false);
  const [tier, setTier] = useState(''), [source, setSource] = useState(''), [python, setPython] = useState('');
  const [plan, setPlan] = useState(initialPlan), [planning, setPlanning] = useState(false), [moreOpen, setMoreOpen] = useState(initialMore), [nonce, setNonce] = useState(0);
  const flight = useRef(false), alive = useRef(true), skipPlan = useRef(!!initialPlan);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = (fresh = true) => (usable ? refreshMineruLocal(call, { fresh }).catch(failure => { if (alive.current) setError(errorMessage(failure)); return null; }) : Promise.resolve(null));
  const { install, setInstall } = useMineruInstall(call, { fromStatus: local?.install || null,
    onEnded: async ended => { await refresh(); if (alive.current && ended.status === 'complete') toast.success(ui('本机 MinerU 可以用了。')); } });
  const view = local && install ? { ...local, install, ...(install.status === 'running' ? { state: 'installing' } : {}) } : local;
  const shown = cardState(view);
  // The status is asked again now and then while there is a service to watch (it stops on a reboot); the poll pauses while the page is hidden.
  usePolling(() => refresh(false).then(() => ({ unchanged: true })), { intervalMs: 30_000, enabled: usable && ['stopped', 'ready'].includes(shown.state), backoff: true });

  const installedFolder = install?.installedFolder || '';
  const installed = !!install?.installed;
  /* The tier is never left to the backend's default (a remount forgets what was chosen here): the tier that works now (installedTier) is kept apart from the
     one the install in hand asks for (install.tier), so a fix continues that install, a move keeps the installed tier and a first install takes the choice. */
  const installedTier = install?.installedTier || (installed && view?.origin === 'installed' ? view?.tier || '' : '');
  const fixTier = install?.tier || installedTier || tier || plan?.tier || DEFAULT_TIER;
  const moveTier = installedTier || install?.tier || tier || plan?.tier || DEFAULT_TIER;
  const offerTier = tier || install?.tier || installedTier || plan?.tier || DEFAULT_TIER;
  const planTier = tier || install?.tier || installedTier;
  const wantsPlan = usable && (shown.state === 'not-installed' || shown.state === 'error' || choosing || moreOpen || moving);
  useLiveEffect(live => {
    if (!wantsPlan) return;
    if (skipPlan.current) { skipPlan.current = false; return; }
    setPlanning(true);
    Promise.resolve(call('mineru.install.plan', { ...(location ? { location } : {}), ...(planTier ? { tier: planTier } : {}), ...(source ? { source } : {}), ...(python ? { python } : {}) }))
      .then(value => { if (live()) setPlan(value); }, failure => { if (live()) setError(errorMessage(failure)); })
      .finally(() => { if (live()) setPlanning(false); });
  }, [wantsPlan, location, planTier, source, python, nonce]);

  const act = async (name, work) => {
    if (flight.current || !usable) return;
    flight.current = true; setWorking(name); setError('');
    try { await work(); } catch (failure) { if (alive.current) setError(errorMessage(failure)); } finally { flight.current = false; if (alive.current) setWorking(''); }
  };
  const target = () => location || (moving ? plan?.folder : '') || plan?.folder || install?.folder || installedFolder;
  // Where a fix continues: the folder the stopped install used (a plan read after a remount names the default folder instead).
  const fixFolder = () => install?.folder || installedFolder || target();
  const start = (extra = {}) => act('start', async () => {
    const next = await call('mineru.install.start', { confirm: true, location: target(), tier: moving ? moveTier : fixTier, ...(source ? { source } : {}), ...(python ? { python } : {}),
      ...(moving ? { removePrevious: true } : {}), ...extra });
    setInstall(next);
    if (local) setLocal({ ...local, state: 'installing', install: next });
    setChoosing(false); setMoving(false);
    toast.info(ui('已开始安装：进度在这里和「任务」里。'));
  });
  const cancel = () => act('cancel', async () => { setInstall(await call('mineru.install.cancel', {})); await refresh(); toast.info(ui('已暂停安装。')); });
  const startService = (args = {}) => act('service', async () => {
    try { await call('mineru.local.start', args); }
    catch (failure) {
      // A start that failed is the status line's to say (its reason, by its code) with its one fix: not a second message under the card.
      if ((await refresh())?.lastError) return;
      throw failure;
    }
    await refresh();
    toast.success(ui('本机 MinerU 服务已启动'));
  });
  const stopService = () => act('stop', async () => { await call('mineru.local.stop', {}); await refresh(); toast.info(ui('本机 MinerU 服务已停止。')); });
  const recheck = () => act('recheck', async () => { await refresh(); setNonce(value => value + 1); });
  const uninstall = async () => {
    const result = await call('mineru.install.uninstall', { confirm: true });
    setInstall(result);
    await refresh();
    toast.success(uiFormat('已卸载，删除了 {0} 里 StudyHub 创建的内容。', [(result.removedFolders || [installedFolder]).filter(Boolean).join('、')]));
  };
  const fix = fixAction => {
    switch (fixAction.id) {
      case 'relocate': setChoosing(true); return undefined;
      case 'restart-service': return startService({ restart: true });
      // Inside an install that has not finished there is no installed program to restart: the install starts again, stopping the other MinerU first.
      case 'stop-external': return shown.origin === 'install' ? start({ location: fixFolder(), stopExternal: true }) : startService({ stopExternal: true });
      case 'recheck': return recheck();
      case 'vc-runtime': globalThis.open?.(VC_REDIST_URL, '_blank', 'noopener'); return undefined;
      case 'switch-source': setSource(fixAction.source); return start({ source: fixAction.source, location: fixFolder() });
      default: return start({ location: fixFolder() });
    }
  };
  const failure = shown.state === 'error' ? { context: { attempts: install?.attempts || 1, source: install?.source?.id || plan?.source?.id, external: !!view?.external, origin: shown.origin } } : null;
  if (failure) failure.action = fixFor(shown.code, failure.context);

  /* ---------- the status line (one line kept for it; in an error it is the title: what is wrong) ---------- */
  const text = STATUS_TEXT[shown.state];
  const tip = text.tip?.(view) || '';
  // 重新检测 is offered once: not beside an error whose one fix is that same button.
  const recheckShown = !['checking', 'installing'].includes(shown.state) && failure?.action.id !== 'recheck';
  const status = <div className="mineru-install__status">
    <div className="mineru-install__line" role="status" aria-live="polite">
      <TipBadge tip={tip} tone={text.tone}>{text.badge()}</TipBadge>
      <p className="mineru-install__sentence">{text.sentence(view, shown.code, shown.origin)}</p>
    </div>
    {/* While it checks the button keeps its place (hidden), so the line does not wrap differently when the answer arrives. */}
    {shown.state === 'checking' && <Button size="sm" variant="quiet" className="mineru-install__recheck" data-reserved="" aria-hidden="true" tabIndex={-1} disabled>{ui('重新检测')}</Button>}
    {recheckShown && <Button size="sm" variant="quiet" className="mineru-install__recheck" busy={working === 'recheck'} disabled={!usable || (!!working && working !== 'recheck')} onClick={recheck}>{ui('重新检测')}</Button>}
  </div>;

  /* ---------- the install offer: location, facts, the one button ---------- */
  const blocking = plan?.problems?.[0] || null;
  const nonAscii = plan?.warnings?.find(item => item.code === 'non-ascii');
  const folder = target() || plan?.defaultFolder || '';
  const canStart = !!plan && !blocking && !planning && !working;
  const reach = REACH[plan?.source?.id]?.();
  const stepsTip = uiFormat('会依次：准备安装工具 → 准备 Python → 安装 MinerU → 下载模型（{0} 档）→ 启用本机服务 → 检查能不能用。全部装在上面的文件夹里，不改系统设置，不需要管理员权限。随时可以暂停，下次接着装。', [moving ? moveTier : offerTier]);
  const facts = plan && !planning
    ? <>{uiFormat('下载约 {0} · 占用约 {1} · 约 {2}–{3} 分钟 · 下载源：{4}', [sizeLabel(plan.estimate?.downloadMb), sizeLabel(plan.disk?.neededMb), plan.estimate?.minutes?.[0], plan.estimate?.minutes?.[1], sourceName(plan.source?.id)])}
      {reach && <> <TipBadge tip={sourceTip(plan.source)} tone={reach.tone}>{reach.text}</TipBadge></>}</>
    : <LoadingState inline label={ui('正在计算剩余空间…')} />;
  // A blocking problem a different folder fixes carries its own one-click fix (换位置); the hint slot gives way to it when it has nothing to say.
  const relocate = blocking && LOCATION_PROBLEMS.includes(blocking.code) && !choosing ? { label: ui('换位置'), onClick: () => setChoosing(true) } : undefined;
  const hint = locationHint(plan);
  const chooser = <LocationChooser plan={plan} location={location} pickDirectory={pick} disabled={!!working} onChoose={value => setLocation(value)} onClose={() => setChoosing(false)} />;
  // `skeleton` (while the status is read): the same rows with placeholders, so the most common answer (not installed) arrives without moving anything.
  const offer = ({ label, skeleton = false } = {}) => <div className="mineru-install__offer" aria-busy={skeleton || undefined}>
    <div className="mineru-install__where">
      <span className="mineru-install__label">{ui('安装位置')}</span>
      <code translate="no">{skeleton ? '…' : folder || '…'}</code>
      {!choosing && <Button size="sm" variant="secondary" icon="location" className="mineru-install__choose" disabled={skeleton || !!working} onClick={() => setChoosing(true)}>{ui('选择位置')}</Button>}
    </div>
    {(skeleton || hint || !blocking) && <Hint className="mineru-install__hint">{(!skeleton && hint) || ' '}</Hint>}
    {!skeleton && nonAscii && <TipBadge tip={uiMessage(nonAscii.message)} tone="warning">{ui('路径里有中文或特殊字符')}</TipBadge>}
    {!skeleton && choosing && chooser}
    <p className="mineru-install__facts" aria-busy={skeleton || planning || !plan || undefined}>{skeleton ? ui('正在检测…') : facts}</p>
    {!skeleton && blocking && <InlineMessage tone="error" action={relocate}>{uiMessage(blocking.message)}</InlineMessage>}
    <div className="mineru-install__row">
      {skeleton
        ? <Button variant="secondary" icon="download" disabled>{ui('一键安装')}</Button>
        : <Tooltip layer content={blocking ? uiMessage(blocking.message) : stepsTip}>
          <Button variant="primary" icon="download" busy={working === 'start'} aria-disabled={!canStart || undefined}
            onClick={() => { if (canStart) void start(moving ? {} : { tier: offerTier }); }}>{label || ui('一键安装')}</Button>
        </Tooltip>}
      {moving && <Button variant="quiet" size="sm" onClick={() => { setMoving(false); setLocation(''); setChoosing(false); }}>{ui('先不换')}</Button>}
    </div>
  </div>;
  const stages = <InstallStages stages={stageStates(install)} label={ui('安装步骤')} className="mineru-install__stages" markClassName="mineru-install__mark" />;

  /* A change of tier that did not finish while the installed tier still works: the ready state of that tier, plus one quiet line to try the change again
     (why it stopped is in the line's Tooltip). */
  const unfinishedTier = installed && STOPPED.includes(install?.status) && install?.tier && installedTier && install.tier !== installedTier ? install.tier : '';
  const tierLine = unfinishedTier && <p className="mineru-install__aside">
    <Tooltip layer content={install.status === 'failed' ? errorReason(view, install.error?.code, 'install') : ui('已暂停；已下载的部分会保留。')}>
      <span tabIndex={0} className="mineru-install__tipped-text">{uiFormat('换成 {0} 档没有完成', [unfinishedTier])}</span>
    </Tooltip>
    <span aria-hidden="true"> · </span>
    <Button variant="quiet" size="sm" busy={working === 'start'} disabled={!!working} onClick={() => void start({ tier: unfinishedTier, location: installedFolder || fixFolder() })}>{ui('重试')}</Button>
  </p>;

  /* ---------- the body of each state ---------- */
  let body = null;
  if (shown.state === 'checking') body = offer({ skeleton: true });
  else if (moving) body = offer({ label: ui('安装到这个位置') });
  else if (shown.state === 'not-installed') body = offer();
  else if (shown.state === 'installing') {
    // The status line and the step list say which step it is; the row adds only where it goes and how much is downloaded (never the raw output).
    const progress = installProgress(install);
    body = <JobRow status="running" stage={stageName(install?.stage)} title={ui('正在安装本机 MinerU')} meta={install?.folder || undefined}
      progress={{ value: progress.value, max: progress.max, label: ui('安装进度'),
        summary: <span className="mineru-install__last">{installLine(install) || ' '}</span> }}
      actions={[{ label: ui('暂停'), onClick: cancel, busy: working === 'cancel', disabled: !!working && working !== 'cancel' }]}>
      {stages}
      <Hint>{ui('可以离开这个页面；进度也在「任务」里。请不要关闭 StudyHub。')}</Hint>
    </JobRow>;
  } else if (shown.state === 'paused') body = <div className="mineru-install__problem">
    {stages}
    {shown.code === 'interrupted' && <Hint>{errorHint('interrupted')}</Hint>}
    <div className="mineru-install__row">
      <Button variant="primary" icon="play" busy={working === 'start'} disabled={!!working} onClick={() => void start({ location: fixFolder() })}>{ui('继续安装')}</Button>
    </div>
  </div>;
  else if (shown.state === 'stopped') body = <div className="mineru-install__row">
    <Button variant="primary" icon="play" busy={working === 'service'} disabled={!!working} onClick={() => startService()}>{ui('启动服务')}</Button>
    <Hint as="span">{ui('开始解析时也会自动启动。')}</Hint>
  </div>;
  else if (shown.state === 'ready') body = (compact || tierLine) ? <>{compact && <Hint>{ui('可以开始解析了。')}</Hint>}{tierLine}</> : null;
  else if (failure) {
    const { action, context } = failure, said = errorHint(shown.code, context);
    const button = <Button variant="primary" icon={action.icon} busy={['start', 'service', 'recheck'].includes(working)} disabled={!!working} onClick={() => void fix(action)}>{action.label}</Button>;
    // While the location chooser is open its confirm is the one primary: the error's own fix (换位置) gives way to it.
    body = <div className="mineru-install__problem">
      {shown.origin === 'install' && stages}
      {said && <Hint>{said}</Hint>}
      {!choosing && <div className="mineru-install__row">
        {action.tip ? <Tooltip layer content={action.tip}>{button}</Tooltip> : button}
        {action.id === 'vc-runtime' && <Button variant="quiet" size="sm" disabled={!!working}
          onClick={() => void (shown.origin === 'service' ? startService({ restart: true }) : start({ location: fixFolder() }))}>{ui('重试')}</Button>}
      </div>}
      {choosing && chooser}
      {choosing && plan && <div className="mineru-install__row">
        <Tooltip layer content={blocking ? uiMessage(blocking.message) : stepsTip}>
          <Button variant="primary" icon="download" aria-disabled={!canStart || undefined} busy={working === 'start'}
            onClick={() => { if (canStart) void start({ location: target() }); }}>{ui('安装到这个位置')}</Button>
        </Tooltip>
      </div>}
    </div>;
  }

  /* ---------- 更多 (Settings only) ---------- */
  const ram = plan?.ramMb ? Math.round(plan.ramMb / 1024) : null;
  const running = view?.running === true || shown.state === 'ready';
  const chosenTier = tier || installedTier || install?.tier || plan?.tier || DEFAULT_TIER;
  const detail = view?.lastError?.detail || '';
  const more = !compact && <Disclosure summary={ui('更多')} className="mineru-install__more" open={moreOpen} onToggle={setMoreOpen}>
    {moreOpen && <div className="mineru-install__more-body">
      <RadioCardGroup legend={ui('模型档位')} className="mineru-install__choices">
        <RadioCard name="mineru-install-tier" value="basic" checked={chosenTier === 'basic'} onSelect={setTier} disabled={!!working} title="basic"
          hint={ui('模型约 0.8 GB · 每页约 1.6 秒（估算）')} />
        <RadioCard name="mineru-install-tier" value="standard" checked={chosenTier === 'standard'} onSelect={setTier} disabled={!!working} title="standard"
          badges={ram !== null && ram < 16 ? <Badge size="sm" tone="warning">{ui('内存可能不够')}</Badge> : null}
          hint={uiFormat('模型约 2 GB · 每页约 2.5 秒（估算）· 建议 16 GB 内存（这台电脑 {0} GB）', [ram ?? '?'])} />
      </RadioCardGroup>
      {installed && installedTier && chosenTier !== installedTier && <div className="mineru-install__row">
        <Button variant="secondary" busy={working === 'start'} disabled={!!working} onClick={() => void start({ tier: chosenTier, location: installedFolder })}>{uiFormat('换成 {0} 档', [chosenTier])}</Button>
      </div>}
      <RadioCardGroup legend={ui('下载源')} className="mineru-install__choices">
        <RadioCard name="mineru-install-source" value="auto" checked={!source || source === 'auto'} onSelect={() => setSource('')} disabled={!!working} title={ui('自动（推荐）')}
          hint={plan?.source ? uiFormat('现在用：{0}（{1}）', [sourceName(plan.source.id), plan.source.chosenBy === 'learner' ? ui('你在「更多」里选的') : REASON[plan.source.reason]?.(plan.source.id) || '']) : ' '} />
        <RadioCard name="mineru-install-source" value="mainland" checked={source === 'mainland'} onSelect={setSource} disabled={!!working} title={ui('国内镜像')}
          badges={<Badge size="sm" tone="success">{ui('国内直连')}</Badge>} />
        <RadioCard name="mineru-install-source" value="global" checked={source === 'global'} onSelect={setSource} disabled={!!working} title={ui('海外官方源')}
          badges={<Badge size="sm" tone="warning">{ui('需海外网络')}</Badge>} />
      </RadioCardGroup>
      <RadioCardGroup legend="Python" className="mineru-install__choices">
        <RadioCard name="mineru-install-python" value="" checked={!python} onSelect={() => setPython('')} disabled={!!working} title={ui('StudyHub 自带 Python 3.12（推荐）')} />
        {(plan?.pythons || []).map(item => <RadioCard key={item.path} name="mineru-install-python" value={item.path} checked={python === item.path} onSelect={setPython} disabled={!!working}
          title={uiFormat('这台电脑上的 Python {0}（{1}）', [item.version, item.path])}
          badges={<TipBadge tip={ui('用它就不再下载 Python；以后升级或卸载这个 Python 会让 MinerU 失效。')} tone="neutral">{ui('不推荐')}</TipBadge>} />)}
      </RadioCardGroup>
      <div className="mineru-install__row">
        {running && <Tooltip layer content={ui('服务在后台会占用内存；需要解析时会自动再启动。')}>
          <Button variant="secondary" size="sm" busy={working === 'stop'} disabled={!!working} onClick={stopService}>{ui('停止服务')}</Button>
        </Tooltip>}
        {installed && <Button variant="secondary" size="sm" disabled={!!working} onClick={() => { setMoving(true); setChoosing(true); }}>{ui('安装到其他位置…')}</Button>}
        {(installed || install?.folder) && <Button variant="quiet" size="sm" disabled={!!working} onClick={() => setAsking(true)}>{ui('卸载')}</Button>}
      </div>
      {moving && <Hint>{ui('新位置装好并通过检查后，才会删除旧的那一份；失败时旧的保持可用。')}</Hint>}
      {view?.external && <p className="mineru-install__external">{uiFormat('另一份 MinerU：{0}（{1}）', [view.external.exe, view.external.state === 'found' ? ui('已找到') : view.external.state])}</p>}
      {/* What the program printed when the service did not start: here only, never in the status line. */}
      {detail && <Disclosure summary={ui('详细信息')}>
        <pre className="mineru-install__pre"><code translate="no">{detail}</code></pre>
      </Disclosure>}
      <Disclosure summary={ui('安装日志')} meta={install?.log?.length || undefined}>
        <pre className="mineru-install__pre"><code translate="no">{(install?.log || []).slice(-200).join('\n') || ui('还没有安装记录。')}</code></pre>
      </Disclosure>
      <Disclosure summary={ui('将要运行的命令')}>
        <pre className="mineru-install__pre"><code translate="no">{(plan?.commands || []).map(item => item.command).join('\n')}</code></pre>
        <Hint>{ui('只在上面的安装位置里创建程序、Python 和模型，不修改系统设置，也不需要管理员权限。')}</Hint>
      </Disclosure>
    </div>}
  </Disclosure>;

  return <section className={`mineru-install${compact ? ' mineru-install--compact' : ''}${className ? ` ${className}` : ''}`} data-state={shown.state} aria-label={ui('本机 MinerU')}>
    {status}
    <div className="mineru-install__body">{body}</div>
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {more}
    {compact && shown.state !== 'ready' && onOpenSettings && <Button variant="quiet" size="sm" className="mineru-install__settings" onClick={() => onOpenSettings('settings-mineru')}>{ui('更多选项')}</Button>}
    {asking && <ConfirmDialog title={ui('卸载本机 MinerU？')} confirmLabel={ui('卸载')} onConfirm={uninstall} onClose={() => setAsking(false)}>
      <p>{uiFormat('会先停止本机服务，再删除 StudyHub 在 {0} 里创建的程序、Python 和模型。这个文件夹里不是 StudyHub 创建的文件不会被动。已经转换好的资料不受影响。', [installedFolder || install?.folder || ''])}</p>
    </ConfirmDialog>}
  </section>;
}
