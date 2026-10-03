import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Icon, InlineMessage } from './components/index.js';
import { sizeLabel } from './mineru-flow.js';
import audioCss from './audio-settings.css';
import css from './mineru.css';

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
      <p className="mineru-privacy__note" id={`${field}-note`}>{privacyNote()}</p>
      <label className="mineru-privacy__check" htmlFor={field}>
        <input id={field} type="checkbox" checked={!!checked} disabled={disabled} aria-describedby={`${field}-note`} onChange={event => onChange?.(event.target.checked)} />
        <span>{ui('我知道文档会上传到 MinerU 的云端，同意用云端解析')}</span>
      </label>
    </div>
  );
}

/**
 * Paste the token, save it and check it (one harmless request, no document), verify a saved one, or clear it.
 * `settings` is mineru.settings.get; `onSaved(settings)` gets the new view. `initialResult` shows a check result at first render (previews, tests).
 */
export function MineruTokenForm({ call, settings, onSaved, busy = false, primary = true, initialResult = null, label }) {
  useInjectCss(audioCss, 'study-audio-settings');
  const [value, setValue] = useState(''), [working, setWorking] = useState(''), [result, setResult] = useState(initialResult);
  const messageId = useId();
  const run = async (kind, work) => {
    if (!call || working) return;
    setWorking(kind); setResult(null);
    try { await work(); } catch (error) { setResult({ ok: false, state: 'error', message: String(error?.message || error) }); } finally { setWorking(''); }
  };
  const verify = async () => setResult(await call('mineru.test', {}));
  const save = event => {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;
    void run('save', async () => { onSaved?.(await call('mineru.settings.set', { token })); setValue(''); await verify(); });
  };
  const text = result && (TEST_TEXT[result.state]?.() || uiMessage(result.message || ui('没有返回原因')));
  return (
    <form className="audio-key-form" onSubmit={save}>
      <input name="mineru-token" className="audio-key-input" type="password" autoComplete="off" spellCheck={false} value={value} disabled={busy || !!working}
        aria-label={label || ui('MinerU 令牌')} aria-describedby={result ? messageId : undefined}
        placeholder={settings?.token?.set ? uiFormat('已保存 {0}；粘贴新的会替换它', [settings.token.hint]) : ui('粘贴 MinerU 的令牌（eyJ…）')}
        onChange={event => setValue(event.target.value)} />
      <div className="audio-key-actions">
        <Button type="submit" variant={primary ? 'primary' : 'secondary'} busy={working === 'save'} disabled={busy || !!working || !value.trim()}>{ui('保存并验证')}</Button>
        {settings?.token?.set && <Button variant="secondary" busy={working === 'verify'} disabled={busy || !!working} onClick={() => void run('verify', verify)}>{ui('验证')}</Button>}
        {settings?.token?.set && settings.token.source !== 'env' && <Button variant="quiet" size="sm" className="audio-key-clear" disabled={busy || !!working}
          onClick={() => void run('clear', async () => { onSaved?.(await call('mineru.settings.set', { token: '' })); })}>{ui('清除已保存的令牌')}</Button>}
      </div>
      <div className="audio-key-foot">
        {result && <InlineMessage id={messageId} tone={result.ok ? 'success' : 'error'}>{text}</InlineMessage>}
        <p className="audio-provider-note">{ui('验证只发一次不含文档的请求；令牌只保存在 DSH 主目录里，不进学习库、备份或快照。')}</p>
      </div>
    </form>
  );
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
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const refresh = useCallback(async () => {
    const next = await call('mineru.local.status', {});
    if (alive.current) onStatus?.(next);
    return next;
  }, [call, onStatus]);
  useEffect(() => {
    if (status?.setup?.status === 'running' && !setup) setSetup(status.setup);
  }, [status?.setup?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // The download and setup run in the background: poll until it ends, then read the state again.
  useEffect(() => {
    if (setup?.status !== 'running' || typeof call !== 'function') return undefined;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const run = await call('mineru.local.setup.status', {});
        if (!live || !alive.current) return;
        setSetup(run);
        if (run.status !== 'running') { clearInterval(timer); await refresh().catch(() => {}); }
      } catch { /* the next tick tries again */ }
    }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [setup?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (name, work) => {
    if (working) return;
    setWorking(name); setError('');
    try { await work(); } catch (failure) { setError(uiMessage(String(failure?.message || failure))); } finally { if (alive.current) setWorking(''); }
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
        <fieldset className="mineru-tier">
          <legend>{ui('选一个档位')}</legend>
          {['basic', 'standard'].map(name => <label key={name} className="mineru-tier__option">
            <input type="radio" name="mineru-tier" value={name} checked={tier === name} onChange={() => setTier(name)} disabled={busy || !!working} />
            <span>{TIER_TEXT[name]()}</span>
            <small>{uiFormat('模型约 {0}；每页约 {1} 秒（估算：一台只用 CPU 的笔记本上量到的）', [sizeLabel(status?.modelsMbByTier?.[name] ?? (name === 'standard' ? 1200 : 800)), status?.estimates?.[name] ?? (name === 'standard' ? 2.5 : 1.6)])}</small>
          </label>)}
        </fieldset>
        {!confirm
          ? <Button variant="primary" icon="download" disabled={busy || !!working} onClick={() => setConfirm(true)}>{ui('下载模型并启用本地解析…')}</Button>
          : <div className="mineru-confirm" role="group" aria-label={ui('确认下载')}>
            <p>{uiFormat('将下载约 {0} 到这台电脑，需要联网并占用磁盘。下载中可以随时取消。', [sizeLabel(mb)])}</p>
            <div className="audio-key-actions">
              <Button variant="primary" busy={working === 'setup'} disabled={busy || !!working} onClick={download}>{ui('确认下载')}</Button>
              <Button variant="quiet" disabled={!!working} onClick={() => setConfirm(false)}>{ui('先不下载')}</Button>
            </div>
          </div>}
      </div>}
      {running && <div className="mineru-progress" role="status" aria-live="polite">
        <p><strong>{STEP_TEXT[setup.step]?.() || ui('正在设置')}</strong>{uiFormat('（{0}，已用 {1} 秒）', [sizeLabel(setup.modelsMb), Math.max(0, Math.round((Date.now() - Date.parse(setup.startedAt)) / 1000))])}</p>
        {setup.lastLine && <p className="mineru-progress__line" translate="no">{setup.lastLine}</p>}
        <p className="audio-provider-note">{ui('模型很大，下载没有精确的百分比；只要下面这一行在变化，就是在进行。')}</p>
        <Button variant="quiet" size="sm" disabled={!!working} onClick={cancel}>{ui('取消')}</Button>
      </div>}
      {state === 'server-stopped' && <div className="audio-key-actions">
        <Button variant="primary" busy={working === 'start'} disabled={busy || !!working} onClick={() => start(false)}>{ui('启动本地服务')}</Button>
      </div>}
      {setup?.status === 'failed' && <InlineMessage tone="error">{uiMessage(setup.error || ui('本地设置没有完成'))}</InlineMessage>}
      {setup?.status === 'cancelled' && <InlineMessage tone="warning">{ui('已取消；没有改动任何设置。')}</InlineMessage>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      <div className="audio-key-actions">
        <Button variant="quiet" size="sm" busy={working === 'refresh'} disabled={busy || !!working} onClick={() => void act('refresh', refresh)}>{ui('重新检测')}</Button>
        {state === 'ready' && <Button variant="quiet" size="sm" disabled={busy || !!working} onClick={() => start(true)}>{ui('重新启动本地服务')}</Button>}
      </div>
    </div>
  );
}

/** 设置 › MinerU 解析: local model setup first, then the optional cloud token. `initialSettings` / `initialLocal` skip the first read (previews, tests). */
export default function MineruSettings({ call, busy = false, setNotice, initialSettings = null, initialLocal = null }) {
  useInjectCss(audioCss, 'study-audio-settings');
  useInjectCss(css, 'study-mineru');
  const [settings, setSettings] = useState(initialSettings), [local, setLocal] = useState(initialLocal), [error, setError] = useState('');
  const [acknowledging, setAcknowledging] = useState(false);
  useEffect(() => {
    let live = true;
    if (!initialSettings && typeof call === 'function') Promise.resolve(call('mineru.settings.get', {})).then(value => { if (live) setSettings(value); }, () => { if (live) setError(ui('读不到 MinerU 设置。')); });
    if (!initialLocal && typeof call === 'function') Promise.resolve(call('mineru.local.status', {})).then(value => { if (live) setLocal(value); }, () => {});
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const acknowledge = async checked => {
    setAcknowledging(true); setError('');
    try { setSettings(await call('mineru.settings.set', { acknowledge: checked })); setNotice?.({ text: checked ? ui('已确认：云端解析会把文档上传到 MinerU。') : ui('已撤回确认；之后用云端解析前会再问一次。'), tone: 'success' }); }
    catch (failure) { setError(uiMessage(String(failure?.message || failure))); }
    finally { setAcknowledging(false); }
  };
  return (
    <fieldset className="audio-settings settings-section mineru-settings" data-tour="settings-mineru">
      <legend className="settings-section__title">{ui('PDF 转换（MinerU）')}</legend>
      <p className="settings-section__lead">{ui('把 PDF 转成带页码的文字：支持扫描件、公式、表格和中文，超过 200 页的书会自动分段处理。有两种用法，可以只用其中一种。')}</p>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      <div className="audio-provider-grid">
        <article className={`audio-provider-card${local?.state === 'ready' ? ' is-set' : ''}`} data-route="local">
          <header className="audio-provider-card__head">
            <h3>{ui('本地（mineru 命令行）')}</h3>
            <span className="audio-chip">{ui('推荐')}</span>
            <span className="audio-provider-card__chips"><span className="audio-chip audio-chip--good">{ui('免费 · 不上传')}</span></span>
          </header>
          <LocalMineruPanel call={call} status={local} onStatus={setLocal} busy={busy} />
        </article>
        <article className={`audio-provider-card${settings?.token?.set ? ' is-set' : ''}`} data-route="cloud">
          <header className="audio-provider-card__head">
            <h3>{ui('云端（MinerU 令牌）')}</h3>
            <span className="audio-provider-card__chips"><span className="audio-chip audio-chip--good">{ui('目前免费')}</span><span className="audio-chip">{ui('文档会上传')}</span></span>
          </header>
          <InlineMessage tone="warning">{ui('云端暂不可用，优先使用本地模型。恢复后可手动选择云端；已保存令牌不代表服务可用。')}</InlineMessage>
          <p className={`audio-key-state${settings?.token?.set ? ' is-set' : ''}`}>
            <Icon name={settings?.token?.set ? 'success' : 'key'} size={16} />{settings?.token?.set ? uiFormat('已保存 {0}', [settings.token.hint]) : ui('未配置')}
          </p>
          <ol className="audio-provider-steps">
            <li><span className="audio-step-num" aria-hidden="true">1</span><a href={settings?.docsUrl || DOCS_URL} target="_blank" rel="noreferrer">{ui('打开 MinerU 的 API 管理页，创建一个令牌')}<span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a></li>
            <li><span className="audio-step-num" aria-hidden="true">2</span><span>{ui('复制令牌，粘贴到下面，点「保存并验证」')}</span></li>
            <li><span className="audio-step-num" aria-hidden="true">3</span><span>{ui('导入 PDF 时选「用 MinerU 云端解析」，其余全自动')}</span></li>
          </ol>
          <MineruTokenForm call={call} settings={settings} onSaved={setSettings} busy={busy} />
          <div className="mineru-settings__privacy">
            <PrivacyConfirm checked={!!settings?.acknowledged} disabled={busy || acknowledging || !settings} onChange={acknowledge} />
          </div>
        </article>
      </div>
      {settings?.settingsFile && <p className="audio-settings-path">{uiFormat('令牌保存在 {0}，不在学习库里，也不会出现在导出或备份中。', [settings.settingsFile])}</p>}
    </fieldset>
  );
}
