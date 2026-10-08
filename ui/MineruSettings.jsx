import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Checkbox, Hint, Icon, InlineConfirm, InlineMessage, ProviderCard, ProviderGrid, RadioCard, RadioCardGroup, SecretKeyForm, SettingsSection, useToast } from './components/index.js';
import { sizeLabel } from './mineru-flow.js';
import css from './mineru.css';
import { refreshMineruLocal, useMineruState } from './use-mineru.js';
import { usePolling } from './use-polling.js';

/* MinerU: PDF to text with page numbers, for scanned books, formulas, tables and long textbooks.
   Two routes, one place to set up each:
   - the local mineru (free, nothing leaves the computer): detected, never installed silently; its service is started and its
     models downloaded only when the learner clicks, after a sized confirmation;
   - the cloud (the learner's own MinerU token, created for free on mineru.net): the token is pasted once, checked with one
     harmless request, and shown back only as its last four characters. Nothing is uploaded until the learner has confirmed
     that the document goes to MinerU's cloud.
   The panels here are the same ones the import entry shows when a route still needs setting up. */

export const DOCS_URL = 'https://mineru.net/apiManage/docs';

const TEST_TEXT = {
  valid: () => ui('可用：令牌有效，MinerU 也连得上'),
  invalid: () => ui('不可用：令牌无效。请重新复制 mineru.net 页面里的完整令牌'),
  expired: () => ui('不可用：令牌已过期。请到 mineru.net 重新创建一个'),
  unreachable: () => ui('没有验证成功：连不上 MinerU，请检查网络'),
  unavailable: () => ui('没有验证成功：MinerU 暂时不可用，请稍后再试'),
  missing: () => ui('还没有保存令牌'),
};

const tokenResultText = result => TEST_TEXT[result.state]?.() || uiMessage(result.message || ui('没有返回原因'));

/** The privacy note, one sentence, used wherever the cloud route is offered. */
export const privacyNote = () => ui('文档会上传到 MinerU 的云端解析，目前不收费，规则可能变化。本地解析不会上传任何内容。');

/**
 * The cloud acknowledgement as a checkbox. Controlled (`checked` + `onChange`) where the choice is part of a form, or
 * persisted at once (`call`) in Settings. The server refuses to upload anything until it is recorded.
 */
export function PrivacyConfirm({ checked, onChange, disabled, id }) {
  const own = useId(), field = id || own;
  return (
    <div className="mineru-privacy">
      <Hint id={`${field}-note`}>{privacyNote()}</Hint>
      <Checkbox id={field} label={ui('我知道文档会上传到 MinerU 的云端，同意用云端解析')} checked={!!checked} disabled={disabled}
        aria-describedby={`${field}-note`} onChange={onChange} />
    </div>
  );
}

/**
 * Paste the token, save it and check it (one harmless request, no document), verify a saved one, or clear it.
 * `settings` is mineru.settings.get; `onSaved(settings)` gets the new view. `initialResult` shows a check result at first render (previews, tests).
 */
export function MineruTokenForm({ call, settings, onSaved, busy = false, primary = true, initialResult = null, label }) {
  const set = patch => Promise.resolve(call('mineru.settings.set', patch)).then(next => { onSaved?.(next); return next; });
  return <SecretKeyForm name="mineru-token" label={label || ui('MinerU 令牌')} placeholder={ui('粘贴 MinerU 的令牌（eyJ…）')}
    saved={settings?.token} busy={busy || !call} primary={primary} initialResult={initialResult} resultText={tokenResultText} clearLabel={ui('清除已保存的令牌')}
    footnote={<p className="sh-secret__note">{ui('验证只发一次不含文档的请求；令牌只保存在 DSH 主目录里，不进学习库、备份或快照。')}</p>}
    onSave={token => set({ token })} onClear={() => set({ token: '' })} onVerify={() => Promise.resolve(call('mineru.test', {}))} />;
}

const STEP_TEXT = { download: () => ui('正在下载模型'), configure: () => ui('正在启用本地模式'), start: () => ui('正在启动本地服务') };
const TIER_TEXT = {
  basic: () => ui('basic · 更快，适合以文字为主的书'),
  standard: () => ui('standard · 版面理解更好，稍慢'),
};

/** One line saying what the local mineru is, in words; never "installed" unless it was detected. */
export function localSummary(status) {
  if (!status) return ui('正在检测本地 mineru…');
  switch (status.state) {
    case 'not-installed': return ui('这台电脑上没有找到本地 mineru。');
    case 'needs-models': return ui('找到了本地 mineru，但还没有下载并启用解析模型。');
    case 'server-stopped': return ui('本地 mineru 已装好，服务没在运行。点下面的按钮启动；启动后才查得出模型有没有准备好。');
    case 'unknown': return ui('找到了本地 mineru，也在运行，但读不出它的设置。点「重新检测」再试一次。');
    case 'ready': return uiFormat('本地 mineru 可用（{0} 档{1}）。', [status.tier, status.version ? ` · v${status.version}` : '']);
    default: return ui('没有读到本地 mineru 的状态。');
  }
}

/**
 * The local mineru: its state, and the one next step it needs, each a click with its own explanation. `status` is
 * mineru.local.status; `onStatus(status)` receives a fresh one after an action. The model download is sized and confirmed first.
 */
export function LocalMineruPanel({ call, status, onStatus, busy = false, initialConfirm = false }) {
  useInjectCss(css, 'study-mineru');
  const [working, setWorking] = useState(''), [error, setError] = useState(''), [tier, setTier] = useState('basic'), [confirm, setConfirm] = useState(initialConfirm);
  const [setup, setSetup] = useState(status?.setup?.status === 'running' ? status.setup : null);
  const alive = useRef(true), downloadTrigger = useRef(null);
  useEffect(() => () => { alive.current = false; }, []);
  const refresh = useCallback(async () => {
    const next = await refreshMineruLocal(call);
    if (alive.current) onStatus?.(next);
    return next;
  }, [call, onStatus]);
  useEffect(() => {
    if (status?.setup?.status === 'running' && !setup) setSetup(status.setup);
  }, [status?.setup?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // The download and setup run in the background: poll until it ends, then read the state again.
  usePolling(async () => {
    try {
      const run = await call('mineru.local.setup.status', {});
      if (!alive.current) return;
      setSetup(run);
      if (run.status !== 'running') await refresh().catch(() => {}); // the poll stops by itself: `setup.status` is no longer 'running'
    } catch { /* the next tick tries again */ }
  }, { intervalMs: 1500, enabled: setup?.status === 'running' && typeof call === 'function' });
  const act = async (name, work) => {
    if (working) return;
    setWorking(name); setError('');
    try { await work(); } catch (failure) { setError(errorMessage(failure)); } finally { if (alive.current) setWorking(''); }
  };
  const start = restart => act('start', async () => { onStatus?.(await call('mineru.local.start', { restart })); });
  const download = () => act('setup', async () => { setConfirm(false); setSetup(await call('mineru.local.setup', { tier, confirm: true })); });
  const cancel = () => act('cancel', async () => { setSetup(await call('mineru.local.setup.cancel', {})); await refresh().catch(() => {}); });
  const state = status?.state;
  const mb = status?.modelsMbByTier?.[tier] ?? (tier === 'standard' ? 1200 : 800);
  const running = setup?.status === 'running';
  return (
    <div className="mineru-local" data-state={state || 'unknown'}>
      <p className="mineru-local__summary" role="status"><Icon name={state === 'ready' ? 'success' : 'info'} size={16} />{localSummary(status)}</p>
      {state === 'not-installed' && <ol className="mineru-local__steps">
        <li>{ui('在终端运行：uv tool install "mineru>=4.0,<5"（需要先装好 uv）')}</li>
        <li>{ui('装好后回到这里，点「重新检测」。StudyHub 不会替你安装它。')}</li>
      </ol>}
      {state === 'needs-models' && !running && <div className="mineru-local__setup">
        <RadioCardGroup legend={ui('选一个档位')}>
          {['basic', 'standard'].map(name => <RadioCard key={name} name="mineru-tier" value={name} checked={tier === name} onSelect={setTier} disabled={busy || !!working}
            title={TIER_TEXT[name]()}
            hint={uiFormat('模型约 {0}；每页约 {1} 秒（估算：一台只用 CPU 的笔记本上量到的）', [sizeLabel(status?.modelsMbByTier?.[name] ?? (name === 'standard' ? 1200 : 800)), status?.estimates?.[name] ?? (name === 'standard' ? 2.5 : 1.6)])} />)}
        </RadioCardGroup>
        {!confirm
          ? <Button ref={downloadTrigger} variant="primary" icon="download" disabled={busy || !!working} onClick={() => setConfirm(true)}>{ui('下载模型并启用本地解析…')}</Button>
          : <InlineConfirm tone="warning" title={ui('确认下载')} confirmLabel={ui('确认下载')} cancelLabel={ui('先不下载')}
            busy={working === 'setup' || busy} returnFocusRef={downloadTrigger} onConfirm={download} onCancel={() => setConfirm(false)}>
            {uiFormat('将下载约 {0} 到这台电脑，需要联网并占用磁盘。下载中可以随时取消。', [sizeLabel(mb)])}
          </InlineConfirm>}
      </div>}
      {running && <div className="mineru-progress" role="status" aria-live="polite">
        <p><strong>{STEP_TEXT[setup.step]?.() || ui('正在设置')}</strong>{uiFormat('（{0}，已用 {1} 秒）', [sizeLabel(setup.modelsMb), Math.max(0, Math.round((Date.now() - Date.parse(setup.startedAt)) / 1000))])}</p>
        {setup.lastLine && <p className="mineru-progress__line" translate="no">{setup.lastLine}</p>}
        <Hint>{ui('模型很大，下载没有精确的百分比；只要下面这一行在变化，就是在进行。')}</Hint>
        <Button variant="quiet" size="sm" disabled={!!working} onClick={cancel}>{ui('取消')}</Button>
      </div>}
      {state === 'server-stopped' && <div className="mineru-local__actions">
        <Button variant="primary" busy={working === 'start'} disabled={busy || !!working} onClick={() => start(false)}>{ui('启动本地服务')}</Button>
      </div>}
      {setup?.status === 'failed' && <InlineMessage tone="error">{uiMessage(setup.error || ui('本地设置没有完成'))}</InlineMessage>}
      {setup?.status === 'cancelled' && <InlineMessage tone="warning">{ui('已取消；没有改动任何设置。')}</InlineMessage>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      <div className="mineru-local__actions">
        <Button variant="quiet" size="sm" busy={working === 'refresh'} disabled={busy || !!working} onClick={() => void act('refresh', refresh)}>{ui('重新检测')}</Button>
        {state === 'ready' && <Button variant="quiet" size="sm" disabled={busy || !!working} onClick={() => start(true)}>{ui('重新启动本地服务')}</Button>}
      </div>
    </div>
  );
}

/** 设置 › MinerU 解析: local model setup first, then the optional cloud token. `initialSettings` / `initialLocal` skip the first read (previews, tests). */
export default function MineruSettings({ call, busy = false, initialSettings = null, initialLocal = null }) {
  const toast = useToast();
  useInjectCss(css, 'study-mineru');
  const state = useMineruState({ call, initialSettings, initialLocal, enabled: typeof call === 'function' });
  // A failed read keeps the form usable but says so (the shared fallback is not shown as if it were the host's answer).
  const settings = state.settingsFailed ? null : state.settings, local = state.localFailed ? null : state.local;
  const setSettings = state.setSettings, setLocal = state.setLocal;
  const [error, setError] = useState(''), [acknowledging, setAcknowledging] = useState(false);
  useEffect(() => { if (state.settingsFailed) setError(ui('读不到 MinerU 设置。')); }, [state.settingsFailed]);
  const acknowledge = async checked => {
    setAcknowledging(true); setError('');
    try { setSettings(await call('mineru.settings.set', { acknowledge: checked })); toast.success(checked ? ui('已确认：云端解析会把文档上传到 MinerU。') : ui('已撤回确认；之后用云端解析前会再问一次。')); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setAcknowledging(false); }
  };
  return (
    <SettingsSection className="mineru-settings" tour="settings-mineru" title={ui('PDF 转换（MinerU）')}
      lead={ui('把 PDF 转成带页码的文字：支持扫描件、公式、表格和中文，超过 200 页的书会自动分段处理。有两种用法，可以只用其中一种。')}>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      <ProviderGrid columns={2}>
        <ProviderCard layout="stack" data-route="local" set={local?.state === 'ready'} title={ui('本地（mineru 命令行）')}
          badges={<><Badge size="sm" tone="accent">{ui('推荐')}</Badge><Badge size="sm" tone="success">{ui('免费 · 不上传')}</Badge></>}>
          <LocalMineruPanel call={call} status={local} onStatus={setLocal} busy={busy} />
        </ProviderCard>
        <ProviderCard layout="stack" data-route="cloud" set={!!settings?.token?.set} title={ui('云端（MinerU 令牌）')}
          badges={<><Badge size="sm" tone="success">{ui('目前免费')}</Badge><Badge size="sm">{ui('文档会上传')}</Badge></>}
          status={settings?.token?.set ? uiFormat('已保存 {0}', [settings.token.hint]) : ui('未配置')}
          steps={[{ text: ui('打开 MinerU 的 API 管理页，创建一个令牌'), href: settings?.docsUrl || DOCS_URL }, { text: ui('复制令牌，粘贴到下面，点「保存并验证」') }]}>
          <InlineMessage tone="warning">{ui('云端暂不可用：现在导入 PDF 都在本机解析，已保存的令牌暂时不会被用到。')}</InlineMessage>
          <MineruTokenForm call={call} settings={settings} onSaved={setSettings} busy={busy} />
          <PrivacyConfirm checked={!!settings?.acknowledged} disabled={busy || acknowledging || !settings} onChange={acknowledge} />
        </ProviderCard>
      </ProviderGrid>
      {settings?.settingsFile && <Hint>{uiFormat('令牌保存在 {0}，不在学习库里，也不会出现在导出或备份中。', [settings.settingsFile])}</Hint>}
    </SettingsSection>
  );
}
