import React, { useEffect, useRef, useState } from 'react';
import { getUiLanguage, ui, uiFormat, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, ConfirmDialog, Disclosure, Field, Hint, Icon, InlineMessage, JobRow, LoadingState, RadioCard, RadioCardGroup, TextInput } from './components/index.js';
import { usePolling } from './use-polling.js';
import { useStudy } from './study-context.jsx';
import { sizeLabel } from './mineru-flow.js';
import { STAGES, canInstall, defaultMirror, failureHint, installMode, stageName, stageStates } from './marker-install-flow.js';
import css from './marker-install.css';

/* One-click Marker (settings › PDF 转换 › Marker). Nothing is installed until the learner presses the one primary button: a private
   Python environment with marker-pdf, in the StudyHub data folder or a folder they choose, then the program path is filled in for them.
   The server (lib/marker-install.js) does the work and keeps the state; this panel plans, starts, polls, cancels, retries, moves and
   uninstalls, with the stages, the reason for a failure and the raw log. */

const MIRROR_TEXT = {
  tsinghua: () => ({ title: ui('清华镜像'), hint: ui('大陆网络推荐，下载快。'), reach: ui('国内直连'), tone: 'success' }),
  official: () => ({ title: ui('PyPI 官方源'), hint: ui('海外网络直连；大陆网络可能很慢或失败。'), reach: ui('需海外网络'), tone: 'warning' }),
};
const CHANNEL_TEXT = {
  npmmirror: () => ui('npmmirror 镜像（Python 安装包）'),
  huawei: () => ui('华为云镜像（Python 安装包）'),
  official: () => ui('python.org 官方安装包'),
};
const PLATFORM_NOTE = {
  win32: () => ui('下载 Windows 安装包，安装时勾选「Add python.exe to PATH」，装好后点「重新检测」。'),
  darwin: () => ui('下载 macOS 安装包并安装，装好后点「重新检测」。'),
  linux: () => ui('建议用系统包管理器安装：sudo apt install python3 python3-venv python3-pip（其他发行版用对应命令），装好后点「重新检测」。'),
};

const Link = ({ href, children }) => <a className="marker-link" href={href} target="_blank" rel="noreferrer">{children}<span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a>;

function Facts({ plan }) {
  const python = plan.python
    ? uiFormat('Python {0}（可用）', [plan.python.version])
    : plan.problems?.some(item => item.code === 'python-too-old')
      ? uiFormat('找到的 Python 版本太旧，需要 {0} 或更新版本', [plan.minPython])
      : uiFormat('没有找到 Python，需要 {0} 或更新版本', [plan.minPython]);
  const free = plan.disk?.freeMb;
  const disk = free == null ? uiFormat('至少需要 {0}', [sizeLabel(plan.disk?.neededMb)]) : uiFormat('剩余 {0} · 至少需要 {1}', [sizeLabel(free), sizeLabel(plan.disk?.neededMb)]);
  const low = free != null && free < plan.disk.neededMb;
  return <dl className="marker-install__facts">
    <div><dt>{ui('Python')}</dt><dd data-ok={plan.python ? 'true' : 'false'}><Icon name={plan.python ? 'success' : 'warning'} size={16} />{python}</dd></div>
    <div><dt>{ui('磁盘空间')}</dt><dd data-ok={low ? 'false' : 'true'}><Icon name={low ? 'warning' : 'success'} size={16} />{disk}</dd></div>
    <div><dt>{ui('下载与时间')}</dt><dd>{uiFormat('约 {0}，通常 {1}–{2} 分钟（估算，取决于网速）', [sizeLabel(plan.estimate?.downloadMb), plan.estimate?.minutes?.[0], plan.estimate?.minutes?.[1]])}</dd></div>
  </dl>;
}

/** Python is missing or too old: not a failure, but where to get it, the reachable mirror first. */
function PythonChannels({ plan }) {
  return <div className="marker-install__channels">
    <p className="marker-install__lead">{uiFormat('先安装 Python（推荐 {0}），再回来点「一键安装 Marker」。从下面任选一个下载：', [plan.recommendedPython])}</p>
    <ul>
      {plan.channels.map(channel => <li key={channel.id}>
        <Link href={channel.url}>{CHANNEL_TEXT[channel.id]?.() || channel.id}</Link>
        <Badge size="sm" tone={channel.reach === 'mainland' ? 'success' : 'warning'}>{channel.reach === 'mainland' ? ui('国内直连') : ui('需海外网络')}</Badge>
      </li>)}
    </ul>
    <Hint>{PLATFORM_NOTE[plan.platform]?.() || PLATFORM_NOTE.linux()}</Hint>
  </div>;
}

function Stages({ install }) {
  return <ol className="marker-install__stages" aria-label={ui('安装步骤')}>
    {stageStates(install).map(item => <li key={item.id} data-state={item.state} aria-current={item.state === 'active' ? 'step' : undefined}>
      <span className="marker-install__mark" aria-hidden="true">{item.state === 'done' ? <Icon name="success" size={14} /> : item.state === 'failed' ? <Icon name="error" size={14} /> : null}</span>
      {stageName(item.id)}
    </li>)}
  </ol>;
}

export default function MarkerInstall({ call, disabled = false, markerReady = false, onChanged, initialInstall = null, initialPlan = null, initialMirror, pickDirectory }) {
  useInjectCss(css, 'study-marker-install');
  const study = useStudy(), pick = pickDirectory || study.host?.pickDirectory;
  const [install, setInstall] = useState(initialInstall), [plan, setPlan] = useState(initialPlan);
  const [mirror, setMirror] = useState(initialMirror || defaultMirror(getUiLanguage())), [location, setLocation] = useState('');
  const [draft, setDraft] = useState(null), [moving, setMoving] = useState(false), [asking, setAsking] = useState(false), [opened, setOpened] = useState(false);
  const [working, setWorking] = useState(''), [error, setError] = useState(''), [nonce, setNonce] = useState(0);
  const alive = useRef(true), skipFirstPlan = useRef(!!initialPlan), flight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const mode = installMode({ install, markerReady, moving });
  const planned = !!install && (mode === 'offer' || mode === 'problem' || (mode === 'manual' && opened));
  useEffect(() => {
    if (initialInstall || typeof call !== 'function') return undefined;
    let live = true;
    Promise.resolve(call('marker.install.status', {})).then(value => { if (live && alive.current) setInstall(value); }, failure => { if (live && alive.current) { setInstall({ status: 'idle', log: [], error: null }); setError(uiMessage(String(failure?.message || failure))); } });
    return () => { live = false; };
  }, [call]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!planned || typeof call !== 'function') return undefined;
    if (skipFirstPlan.current) { skipFirstPlan.current = false; return undefined; }
    let live = true;
    Promise.resolve(call('marker.install.plan', { mirror, ...(location ? { location } : {}) })).then(value => { if (live && alive.current) setPlan(value); },
      failure => { if (live && alive.current) setError(uiMessage(String(failure?.message || failure))); });
    return () => { live = false; };
  }, [call, planned, mirror, location, nonce]);
  // The install runs in the background on the server: ask until it ends, then tell the settings page to read the path and the state again.
  usePolling(async () => {
    const next = await call('marker.install.status', {});
    if (!alive.current) return undefined;
    setInstall(next);
    if (next.status !== 'running') onChanged?.(next);
    return { running: next.status === 'running' };
  }, { intervalMs: 1500, enabled: install?.status === 'running' && typeof call === 'function' });

  const act = async (name, work) => {
    if (flight.current) return;
    flight.current = true; setWorking(name); setError('');
    try { await work(); } catch (failure) { if (alive.current) setError(uiMessage(String(failure?.message || failure))); } finally { flight.current = false; if (alive.current) setWorking(''); }
  };
  const start = () => act('start', async () => {
    const next = await call('marker.install.start', { confirm: true, mirror, ...(location ? { location } : {}), ...(moving ? { removePrevious: true } : {}) });
    setInstall(next); setMoving(false);
  });
  const cancel = () => act('cancel', async () => { setInstall(await call('marker.install.cancel', {})); onChanged?.(); });
  const recheck = () => act('recheck', async () => { setNonce(value => value + 1); });
  const choose = () => act('choose', async () => {
    if (!pick) { setDraft(location || ''); return; }
    try { const picked = await pick(); if (picked) setLocation(picked); }
    catch { setDraft(location || ''); setError(ui('无法打开文件夹选择器，请直接输入路径。')); }
  });
  const uninstall = async () => { const next = await call('marker.install.uninstall', { confirm: true }); setInstall(next); setMoving(false); setLocation(''); onChanged?.(next); };
  const locked = disabled || !call || !!working;

  const folderLine = (folder, custom) => <p className="marker-install__where">
    <span>{ui('安装位置')}</span><code title={folder}>{folder}</code>
    <Button size="sm" variant="quiet" disabled={locked} onClick={choose}>{ui('更改位置')}</Button>
    {custom && <Button size="sm" variant="quiet" disabled={locked} onClick={() => setLocation('')}>{ui('用默认位置')}</Button>}
  </p>;

  const offer = primary => {
    const folder = plan?.folder || install?.defaultFolder || '';
    const problems = (plan?.problems || []).filter(item => !['python-missing', 'python-too-old'].includes(item.code));
    return <div className="marker-install__offer">
      {plan?.channels ? <InlineMessage tone="warning">{uiMessage(plan.problems?.[0]?.message || '')}</InlineMessage> : null}
      {plan?.channels && <PythonChannels plan={plan} />}
      {folderLine(folder, !!location)}
      {draft !== null && <form className="marker-install__draft" onSubmit={event => { event.preventDefault(); setLocation(draft.trim()); setDraft(null); }}>
        <Field label={ui('安装位置的完整路径')} hint={ui('例如 D:\\Tools\\marker 或 /home/me/marker；文件夹不存在会新建。')}>
          <TextInput autoFocus value={draft} placeholder="D:\Tools\marker" aria-label={ui('安装位置的完整路径')} onChange={event => setDraft(event.target.value)} />
        </Field>
        <div className="marker-install__row">
          <Button type="submit" size="sm" disabled={!draft.trim()} onClick={() => { setLocation(draft.trim()); setDraft(null); }}>{ui('使用此位置')}</Button>
          <Button size="sm" variant="quiet" onClick={() => setDraft(null)}>{ui('取消')}</Button>
        </div>
      </form>}
      {plan?.adjusted && <Hint>{ui('这个文件夹里已经有别的文件，会装进里面新建的「StudyHub-Marker」文件夹，不会动原有文件。')}</Hint>}
      <RadioCardGroup legend={ui('下载源')}>
        {['tsinghua', 'official'].map(id => { const text = MIRROR_TEXT[id](); return <RadioCard key={id} name="marker-mirror" value={id} checked={mirror === id} onSelect={setMirror} disabled={locked}
          title={text.title} badges={<Badge size="sm" tone={text.tone}>{text.reach}</Badge>} hint={text.hint} />; })}
      </RadioCardGroup>
      {plan ? <Facts plan={plan} /> : <LoadingState label={ui('正在检查这台电脑…')} />}
      {problems.map(item => <InlineMessage key={item.code} tone="error">{uiMessage(item.message)}</InlineMessage>)}
      {plan?.commands?.length > 0 && <Disclosure summary={ui('将要运行的命令')}>
        <pre className="marker-install__commands"><code>{plan.commands.map(item => item.command).join('\n')}</code></pre>
        <Hint>{ui('只在上面的安装位置里创建环境，不修改系统的 Python，也不需要管理员权限。')}</Hint>
      </Disclosure>}
      <div className="marker-install__row">
        <Button variant={primary ? 'primary' : 'secondary'} icon="download" busy={working === 'start'} disabled={locked || !canInstall(plan)} onClick={start}>
          {moving ? ui('安装到这个位置并删除旧环境') : ui('一键安装 Marker')}
        </Button>
        <Button variant="quiet" size="sm" disabled={locked} onClick={recheck}>{ui('重新检测')}</Button>
        {moving && <Button variant="quiet" size="sm" disabled={locked} onClick={() => { setMoving(false); setLocation(''); }}>{ui('先不换')}</Button>}
      </div>
      {moving && <Hint>{ui('新环境装好并通过检测后，才会删除旧的那个；失败时旧的保持可用。')}</Hint>}
      <Hint>{ui('只在你点击后才会安装；marker-pdf 用 pip 下载，需要联网。')}</Hint>
    </div>;
  };

  const progress = () => {
    const states = stageStates(install), done = states.filter(item => item.state === 'done').length;
    const step = Math.min(STAGES.length, done + 1);
    return <JobRow status="running" stage={stageName(install.stage)} title={ui('正在安装 Marker')}
      meta={uiFormat('第 {0}/{1} 步 · {2} · {3}', [step, STAGES.length, stageName(install.stage), install.folder])}
      progress={{ value: done, max: STAGES.length, ahead: 1, label: ui('Marker 安装进度'),
        summary: install.lastLine ? <code className="marker-install__line" translate="no">{install.lastLine}</code> : null }}
      actions={[{ label: ui('取消'), onClick: cancel, busy: working === 'cancel', disabled: !!working && working !== 'cancel' }]}>
      <Stages install={install} />
      <Hint>{ui('下载没有精确的百分比；只要上面这一行在变化，就是在进行。请不要关闭 StudyHub。')}</Hint>
    </JobRow>;
  };

  const problem = () => {
    const code = install.error?.code || '';
    const cancelled = install.status === 'cancelled';
    return <div className="marker-install__problem">
      <JobRow status={cancelled ? 'cancelled' : install.status === 'interrupted' ? 'interrupted' : 'failed'} title={cancelled ? ui('安装已取消') : install.status === 'interrupted' ? ui('安装被中断') : ui('Marker 没有装好')}
        meta={install.stage ? uiFormat('停在：{0}', [stageName(install.stage)]) : undefined}
        failure={cancelled ? { hint: failureHint(code) } : { title: uiMessage(install.error?.message || ''), hint: failureHint(code), detail: install.log?.length ? install.log.join('\n') : undefined }}
        actions={[{ label: ui('重试'), variant: 'primary', icon: 'refresh', onClick: start, busy: working === 'start', disabled: locked || (!!plan && !canInstall(plan)) }]}>
        <Stages install={install} />
      </JobRow>
      {cancelled && install.log?.length > 0 && <Disclosure summary={ui('原始日志')}><pre className="marker-install__commands"><code>{install.log.join('\n')}</code></pre></Disclosure>}
      {install.installed && <Hint>{ui('之前装好的 Marker 仍然可用。')}</Hint>}
      {offer(false)}
    </div>;
  };

  const installed = () => <div className="marker-install__done">
    <InlineMessage tone={markerReady ? 'success' : 'warning'} title={markerReady ? ui('Marker 已就绪') : ui('Marker 已安装，但检测没有通过')}>
      {markerReady ? uiFormat('已安装到 {0}，程序路径已自动填好。', [install.installedFolder]) : uiFormat('已安装到 {0}，但检测没有通过。点下面的「保存并检测」再试，或重新安装。', [install.installedFolder])}
    </InlineMessage>
    {markerReady && <Hint>{ui('第一次解析时会下载 Marker 的模型，需要联网和几分钟，之后就不用了。')}</Hint>}
    <div className="marker-install__row">
      <Button variant="secondary" disabled={locked} onClick={() => setMoving(true)}>{ui('安装到其他位置…')}</Button>
      <Button variant="quiet" disabled={locked} onClick={() => setAsking(true)}>{ui('卸载')}</Button>
    </div>
    {asking && <ConfirmDialog title={ui('卸载 Marker？')} confirmLabel={ui('卸载')} onConfirm={uninstall} onClose={() => setAsking(false)}>
      <p>{uiFormat('将删除 StudyHub 为 Marker 创建的环境（{0}）。这个文件夹里不是它创建的文件不会被动。已转换过的资料不受影响。', [install.installedFolder])}</p>
    </ConfirmDialog>}
  </div>;

  let body = null;
  if (mode === 'loading') body = <LoadingState label={ui('正在读取 Marker 安装状态…')} />;
  else if (mode === 'running') body = progress();
  else if (mode === 'problem') body = problem();
  else if (mode === 'installed') body = installed();
  else if (mode === 'manual') body = <Disclosure summary={ui('让 StudyHub 另外安装一份 Marker')} onToggle={setOpened}>{offer(false)}</Disclosure>;
  else body = offer(true);
  return <section className="marker-install" data-mode={mode} aria-label={ui('一键安装 Marker')}>
    {body}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
  </section>;
}
