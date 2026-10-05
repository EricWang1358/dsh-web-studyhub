/* WP15 · update check and upgrade. One shared store per page: the first App
   that mounts asks `update.check` (cached on the host for 12 h); the sidebar
   chip, the 关于与更新 settings section and the upgrade dialog read it.
   An automatic check that fails is silent; a manual one says so, with a retry. The dialog upgrades in one click when the host
   reports DSH's plugin manager (`update.install`), otherwise it guides a
   reinstall from the exact package address. */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Banner, Button, Checkbox, Dialog, Hint, Icon, InlineMessage, useToast } from './components/index.js';
import { formatDateTime } from './format.js';
import { useCopyFeedback } from './use-copy-feedback.js';
import { ExtensionUpdateNotice } from './ExtensionPanel.jsx';
import { isNewerVersion } from '../lib/semver.js';
import css from './update.css';
import { setRetrievalStatus, useRetrievalStatus } from './retrieval-status.js';

let snapshot = { update: null, checking: false };
const listeners = new Set();
const setStore = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
const read = () => snapshot;
export const useUpdateStore = () => useSyncExternalStore(subscribe, read, read);

let started = false;
/**
 * Ask the host. A failure leaves the last answer in place. An automatic check stays silent about it (null); a forced one (the
 * learner pressed 检查更新) answers `{ error }` so the page can say so. The host's own answer may also carry `error` (GitHub
 * could not be reached), which is the same thing to the learner.
 */
export async function refreshUpdate(call, { force = false } = {}) {
  setStore({ checking: true });
  try {
    const update = await call('update.check', force ? { force: true } : {});
    if (update && typeof update === 'object') setStore({ update });
    return update;
  } catch (error) {
    started = false;
    return force ? { error: errorMessage(error) } : null;
  } finally { setStore({ checking: false }); }
}
async function savePreferences(call, preferences) {
  const update = await call('update.preferences', preferences);
  if (update && typeof update === 'object') setStore({ update: { ...snapshot.update, ...update } });
  return update;
}

// Accept older hosts' views too, while avoiding reinstalling a pending release.
const canUpgrade = update => !!update && (update.upgradeAvailable ??
  (update.newer && isNewerVersion(update.latest, update.pendingRestart || update.installed || update.current)));

/** null | 'new' | 'restart': what the sidebar chip should say. */
export function chipState(update) {
  if (!update) return null;
  if (canUpgrade(update) && update.autoCheck !== false && !update.snoozed) return 'new';
  if (update.pendingRestart) return 'restart';
  return null;
}

/** Plain-language reasons for the refusals update.install answers with. */
export function failureMessage(code) {
  switch (code) {
    case 'UPDATE_STALE': return ui('版本信息已经变化，请关闭窗口后重新打开。');
    case 'UPDATE_NO_INSTALLER': return ui('这个 DSH 不支持在应用内安装插件。');
    case 'UPDATE_UNAVAILABLE': return ui('这个版本没有可一键安装的安装包。');
    case 'UPDATE_DOWNLOAD': return ui('无法从 GitHub 下载安装包，可能是网络暂时不可用。');
    case 'UPDATE_CHECKSUM': return ui('下载的安装包没有通过 SHA-256 校验，已停止升级，没有做任何改动。');
    case 'UPDATE_INSTALL': return ui('DSH 没能安装新版本，原来的版本保持不变。');
    default: return ui('升级没有完成。');
  }
}

/** One upgrade attempt through the host; answers the dialog phase to show next. */
export async function startUpgrade(call, update, { confirmJobs = false } = {}) {
  try {
    const result = await call('update.install', { version: update.latest, ...(confirmJobs ? { confirmJobs: true } : {}) });
    if (result?.status === 'jobs-running') return { phase: 'jobs', jobs: result.jobs };
    if (result?.status === 'failed') return { phase: 'error', code: result.code, message: failureMessage(result.code) };
    return { phase: 'installed', version: result.version, restartRequired: result.restartRequired !== false, desktop: !!result.desktop };
  } catch (error) { return { phase: 'error', message: errorMessage(error) }; }
}


/** The sidebar chip: quiet, only when there is something to do. */
export function UpdateChip({ update, onOpen, compact = false }) {
  useInjectCss(css, 'study-update');
  const state = chipState(update);
  if (!state) return null;
  const label = state === 'restart' ? ui('重启 DSH 完成升级') : uiFormat('有新版本 {0}', [update.latest]);
  return (
    <button type="button" className={`update-chip update-chip--${state}${compact ? ' is-compact' : ''}`} onClick={onOpen}
      aria-label={compact ? label : undefined} title={label}>
      <Badge tone="info" icon={state === 'restart' ? 'info' : 'sparkle'}>{!compact && <span className="update-chip__label">{label}</span>}</Badge>
    </button>
  );
}

function CopyAddress({ address }) {
  const { copied, copy: write } = useCopyFeedback(address);
  // Without clipboard access the address is selected, ready for the learner's own copy.
  async function copy() { if (!await write()) document.getElementById('study-update-address')?.select?.(); }
  return (
    <div className="update-address">
      <input id="study-update-address" readOnly value={address} aria-label={ui('安装地址')} onFocus={event => event.target.select()} />
      <Button size="sm" variant={copied ? 'secondary' : 'primary'} icon={copied ? 'check' : undefined} onClick={copy}>
        {copied ? ui('已复制') : ui('复制安装地址')}
      </Button>
    </div>
  );
}

function GuidedUpgrade({ update, host }) {
  const address = update.assetUrl || update.url;
  return (
    <section className="update-guided" aria-label={ui('手动升级')}>
      <p className="update-lead">{ui('DSH 插件不会自动更新。按下面 4 步换成新版本，学习库和设置都会保留：')}</p>
      <CopyAddress address={address} />
      <ol className="update-steps">
        <li><strong>{ui('卸载旧版')}</strong><span>{ui('打开 DSH 的「插件」管理，找到 StudyHub，点「卸载」。')}</span></li>
        <li><strong>{ui('添加插件')}</strong><span>{ui('在同一页点「添加插件」。')}</span></li>
        <li><strong>{ui('粘贴地址')}</strong><span>{ui('粘贴上面复制的安装地址，安装后点「启用」。')}</span></li>
        <li><strong>{ui('重启 DSH')}</strong><span>{ui('桌面版完全退出后重新打开；网页版重启 DSH 服务后刷新页面。')}</span></li>
      </ol>
      {host?.openPluginManager && <Button variant="secondary" size="sm" icon="external" onClick={() => host.openPluginManager()}>{ui('打开插件管理')}</Button>}
      <p className="update-note">{ui('桌面版提示：在插件管理里操作无需退出；若改用命令行安装，必须先完全退出桌面版（包括托盘图标）。')}</p>
    </section>
  );
}

function Installed({ phase, host }) {
  return (
    <div className="update-done">
      <InlineMessage tone="success" boxed title={uiFormat('已安装 {0}', [phase.version])}>
        {phase.desktop
          ? ui('请完全退出 DSH 桌面版（包括托盘图标）后重新打开，新版本才会生效。')
          : ui('请重启 DSH 服务（停止后用原来的方式重新启动），再刷新页面，新版本才会生效。')}
      </InlineMessage>
      <p className="update-note">{ui('重启前，当前页面仍在运行旧版本；学习库和设置不受影响。')}</p>
      {host?.openPluginManager && <Button variant="quiet" size="sm" icon="external" onClick={() => host.openPluginManager()}>{ui('在插件管理中查看')}</Button>}
    </div>
  );
}

/** The upgrade dialog: version, release notes, and one-click or guided upgrade. */
export function UpdateDialog({ update, call, host, onClose, initialPhase = null }) {
  useInjectCss(css, 'study-update');
  const toast = useToast();
  const available = canUpgrade(update);
  // A pending install is complete only for that version; a later release stays actionable.
  const [savedPhase, setPhase] = useState(initialPhase || (update.pendingRestart && !available
    ? { phase: 'installed', version: update.pendingRestart, restartRequired: true, desktop: !!update.install?.desktop } : { phase: 'idle' }));
  let phase = savedPhase.phase === 'installed' && available && isNewerVersion(update.latest, savedPhase.version)
    ? { phase: 'idle' } : savedPhase;
  if (update.pendingRestart && !available && phase.phase !== 'working' &&
      (phase.phase !== 'installed' || isNewerVersion(update.pendingRestart, phase.version))) {
    phase = { phase: 'installed', version: update.pendingRestart, restartRequired: true, desktop: !!update.install?.desktop };
  }
  const [guided, setGuided] = useState(false);
  const inApp = update.install?.available === true && !guided && !!update.assetUrl;
  const working = phase.phase === 'working';
  async function upgrade(confirmJobs = false) {
    setPhase({ phase: 'working' });
    const next = await startUpgrade(call, update, { confirmJobs });
    setPhase(next);
    if (next.phase === 'installed') refreshUpdate(call);
  }
  async function later() {
    try { await savePreferences(call, { snooze: update.latest }); toast.info(uiFormat('{0} 先不提醒了，可在「设置 › 关于与更新」里随时升级。', [update.latest])); }
    catch { toast.error(ui('没能保存「稍后提醒」，请再试一次。')); return; }
    onClose('later');
  }
  const published = formatDateTime(update.publishedAt, 'day');
  const description = uiFormat('当前版本 {0}', [update.current]) + (published ? ` · ${uiFormat('发布于 {0}', [published])}` : '');
  let primary = null;
  if (phase.phase === 'installed') primary = <Button variant="primary" onClick={() => onClose('done')}>{ui('知道了')}</Button>;
  else if (inApp && phase.phase === 'confirm') primary = <Button variant="primary" onClick={() => upgrade(false)}>{ui('确认升级')}</Button>;
  else if (inApp && phase.phase === 'jobs') primary = <Button variant="primary" onClick={() => upgrade(true)}>{ui('停止任务并升级')}</Button>;
  else if (inApp) primary = <Button variant="primary" icon="sparkle" busy={working} onClick={() => setPhase({ phase: 'confirm' })}>{uiFormat('一键升级到 {0}', [update.latest])}</Button>;
  const footer = (
    <div className="update-footer">
      <a className="update-release-link" href={update.url} target="_blank" rel="noreferrer">{ui('查看发布页')}<Icon name="external" size={14} /></a>
      <span className="update-footer__actions">
        {phase.phase !== 'installed' && <Button variant="quiet" disabled={working} onClick={later}>{ui('稍后提醒')}</Button>}
        {primary}
      </span>
    </div>
  );
  return (
    <Dialog title={phase.phase === 'installed' ? uiFormat('StudyHub {0} 等待重启', [phase.version]) : uiFormat('StudyHub {0} 可以升级了', [update.latest])} description={description} size="md" onClose={onClose} footer={footer}
      className="update-dialog" bodyLabel={ui('升级说明')}>
      {phase.phase === 'installed' ? <Installed phase={phase} host={host} /> : <>
        {update.pendingRestart && available && <p className="update-lead">{uiFormat('已安装 {0}，尚未重启。可以直接安装 {1}，然后重启一次 DSH。', [update.pendingRestart, update.latest])}</p>}
        {update.notes && <section className="update-notes-wrap" aria-label={ui('更新内容')}>
          <h3>{ui('更新内容')}</h3>
          <div className="update-notes">{update.notes}</div>
        </section>}
        {inApp && phase.phase === 'idle' && <p className="update-lead">{ui('StudyHub 会从 GitHub 发布页下载安装包，核对 SHA256 校验值后交给 DSH 插件管理安装；安装后重启 DSH 即可使用新版本。')}</p>}
        {inApp && phase.phase === 'confirm' && <InlineMessage tone="info" boxed title={ui('确认升级？')}>
          {ui('升级需要几十秒。安装完成后要重启 DSH，重启前可以继续学习。')}
        </InlineMessage>}
        {inApp && phase.phase === 'working' && <p className="update-lead" role="status">{ui('正在下载并校验安装包，然后交给 DSH 安装…')}</p>}
        {inApp && phase.phase === 'jobs' && <InlineMessage tone="warning" boxed title={uiFormat('有 {0} 个后台任务正在运行', [phase.jobs])}>
          {ui('升级会先停止这些任务；已完成的部分会保留。也可以等任务结束后再升级。')}
        </InlineMessage>}
        {phase.phase === 'error' && <InlineMessage tone="error" boxed title={ui('这次没有升级成功')}
          action={{ label: ui('改用手动升级'), onClick: () => { setGuided(true); setPhase({ phase: 'idle' }); } }}>{phase.message || failureMessage(phase.code)}</InlineMessage>}
        {!inApp && <GuidedUpgrade update={update} host={host} />}
      </>}
    </Dialog>
  );
}

/** Settings › 关于与更新. */
export function UpdateSettings({ update, call, onOpen, checking = false, extension, onExtension, onCheck, initialCheckError = '', initialSaveError = '' }) {
  useInjectCss(css, 'study-update');
  const [saving, setSaving] = useState(false), [checkError, setCheckError] = useState(initialCheckError), [saveError, setSaveError] = useState(initialSaveError);
  // The check compares StudyHub only; the search extension is installed once and is not updated with it.
  const staleExtension = extension?.installed && extension.outdated ? extension : null;
  async function checkUpdates() {
    setCheckError('');
    const result = await refreshUpdate(call, { force: true });
    onCheck?.();
    if (result?.error) setCheckError(String(result.error));
  }
  const available = canUpgrade(update);
  // How the check stands: tone and words differ for "up to date", "restart needed", "extension behind", "never checked".
  const status = !update ? null
    : update.pendingRestart ? { tone: 'info', text: uiFormat('已安装 {0}，重启 DSH 后生效。', [update.pendingRestart]) }
      : available || update.error ? null
        : staleExtension ? { tone: 'warning', text: uiFormat('StudyHub 本体已是最新，但检索扩展还是 {0}，需要更新到 {1}。', [staleExtension.version, staleExtension.expected]) }
          : update.checkedAt ? { tone: 'success', text: ui('已是最新版本。') } : { tone: 'hint', text: ui('还没有检查过更新。') };
  const retry = { label: ui('重试'), onClick: checkUpdates };
  async function toggle(autoCheck) {
    setSaving(true); setSaveError('');
    try { await savePreferences(call, { autoCheck }); } catch (error) { setSaveError(errorMessage(error)); }
    finally { setSaving(false); }
  }
  return (
    <fieldset className="settings-section update-settings" data-tour="settings-update">
      <legend className="settings-section__title">{ui('关于与更新')}</legend>
      <dl className="update-facts">
        <div><dt>{ui('当前版本')}</dt><dd>{update?.current || '—'}</dd></div>
        <div><dt>{ui('已安装版本')}</dt><dd>{update?.installed || update?.pendingRestart || update?.current || '—'}</dd></div>
        <div><dt>{ui('最新已知版本')}</dt><dd>{update?.latest || '—'}</dd></div>
        <div><dt>{ui('上次检查')}</dt><dd>{update?.checkedAt ? formatDateTime(update.checkedAt) : ui('尚未检查')}</dd></div>
      </dl>
      {update?.pendingRestart && <Hint>{ui('当前版本是正在运行的代码；已安装版本在重启 DSH 后生效。')}</Hint>}
      {available && <Banner tone="info" icon="sparkle" title={uiFormat('有新版本 {0}', [update.latest])} action={{ label: ui('查看升级'), variant: 'primary', onClick: onOpen }} />}
      {checkError ? <InlineMessage tone="error" title={ui('没能检查更新')} action={retry}>{ui('暂时无法连接 GitHub 检查更新。请检查网络后重试。')}</InlineMessage>
        : update?.error ? <InlineMessage tone="warning" action={retry}>{ui('暂时无法连接 GitHub 检查更新，稍后会自动重试。')}</InlineMessage> : null}
      {!checkError && status && (status.tone === 'hint' ? <Hint>{status.text}</Hint> : <InlineMessage tone={status.tone}>{status.text}</InlineMessage>)}
      {saveError && <InlineMessage tone="error" onDismiss={() => setSaveError('')}>{ui('没能保存这个设置，已恢复原来的选择。')}</InlineMessage>}
      {extension?.installed && <ExtensionUpdateNotice call={call} status={{ extension }} onStatus={onExtension} />}
      <div className="update-settings__actions">
        <Button size="sm" busy={checking} onClick={checkUpdates}>{ui('检查更新')}</Button>
        <Checkbox checked={update?.autoCheck !== false} disabled={saving || !update} onChange={toggle} label={ui('自动检查更新')} />
      </div>
      <p className="settings-section__lead">{ui('自动检查通常间隔 12 小时，失败后稍后重试；手动检查立即查询，不自动安装，也不发送学习数据。')}</p>
    </fieldset>
  );
}

/* Each place that opens the dialog owns it, so a second StudyHub seat on the
   same page (conversation tab + right sidebar) never opens a hidden copy. */

/** Connected settings section for the Settings page. */
export function UpdateSettingsPanel({ call, host }) {
  const { update, checking } = useUpdateStore();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!snapshot.update && !snapshot.checking) refreshUpdate(call); }, [call]);
  // Whether the search extension is behind this StudyHub rides along with the retrieval status (the shared store: an install elsewhere shows here).
  const retrieval = useRetrievalStatus({ call });
  const extension = retrieval.data?.extension;
  return <>
    <UpdateSettings update={update} call={call} checking={checking} onOpen={() => setOpen(true)} extension={extension} onExtension={value => setRetrievalStatus(value)} onCheck={retrieval.refresh} />
    {open && update && <UpdateDialog update={update} call={call} host={host} onClose={() => setOpen(false)} />}
  </>;
}

/** Sidebar chip and its dialog. The first mounted App asks once per page load. */
export default function UpdateCenter({ call, host, compact = false }) {
  const { update } = useUpdateStore();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (started) return;
    started = true;
    refreshUpdate(call);
  }, [call]);
  return <>
    <UpdateChip update={update} compact={compact} onOpen={() => setOpen(true)} />
    {open && update && <UpdateDialog update={update} call={call} host={host} onClose={() => setOpen(false)} />}
  </>;
}
