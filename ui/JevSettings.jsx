import React, { useCallback, useEffect, useId, useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Icon, InlineMessage } from './components/index.js';
import { TokenUsage } from './TokenUsage.jsx';
import { JEV_FEATURE_META, dshUsage, failureCode, percentText, privacyPoints, setupStep, thresholdChoices } from './jev-flow.js';
import audioCss from './audio-settings.css';
import css from './jev.css';

/* 设置 › 实验性 · Jev 判断服务. EXPERIMENTAL and off by default.

   Jev is TypeSafe AI's "System One" model: a cheap, fast classifier-shaped service. StudyHub uses it only for small judgements
   that it then treats as SIGNALS (which course, is this question flawed); it never writes anything by itself, and when Jev is
   missing or failing everything works as before. Nothing is sent until ALL of these hold: a key is saved, the privacy note
   below is confirmed, the master switch is on, and the individual experiment is switched on. The key is stored in the DSH
   home (never in the library, an export or a backup) and shown back only as its last four characters. */

const TEST_STATE = { valid: () => ui('可用：密钥有效，Jev 连得上') };

/** The privacy note and the one-time confirmation: what is sent, where it goes, what the provider says (and does not say). */
export function JevPrivacy({ confirmed, onChange, disabled, privacyUrl }) {
  const id = useId();
  return (
    <div className="jev-privacy" data-confirmed={confirmed ? 'true' : 'false'}>
      <h3 className="jev-privacy__title">{ui('发送内容与隐私')}</h3>
      <ul className="jev-privacy__list">{privacyPoints().map((text, index) => <li key={index}>{text}</li>)}</ul>
      {privacyUrl && <p className="jev-privacy__link"><a href={privacyUrl} target="_blank" rel="noreferrer">{ui('查看服务商的隐私与数据说明')}<span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a></p>}
      <label className="mineru-privacy__check" htmlFor={id}>
        <input id={id} type="checkbox" checked={!!confirmed} disabled={disabled} onChange={event => onChange?.(event.target.checked)} />
        <span>{ui('我已阅读以上说明，同意把这些内容发送到 Jev（TypeSafe 云端）')}</span>
      </label>
    </div>
  );
}

/** Tokens and calls: today, in total, and per experiment, in the same rows as the study model's usage. Tokens only, never a price. */
export function JevUsageView({ usage }) {
  const used = JEV_FEATURE_META.filter(feature => usage?.byFeature?.[feature.id]?.calls > 0);
  const test = usage?.byFeature?.test?.calls > 0;
  return (
    <div className="jev-usage" data-jev-usage>
      <h3 className="jev-usage__title">{ui('Jev 用量')}</h3>
      {!usage?.total?.calls ? <p className="muted">{ui('还没有调用过 Jev。')}</p> : <>
        <div className="jev-usage__row"><strong>{ui('今天')}</strong><TokenUsage usage={dshUsage(usage.today)} inline copy={false} /></div>
        <div className="jev-usage__row"><strong>{ui('合计')}</strong><TokenUsage usage={dshUsage(usage.total)} inline copy={false} /></div>
        {(used.length > 0 || test) && <details className="jev-usage__more"><summary>{ui('按功能查看')}</summary>
          {used.map(feature => <div key={feature.id} className="jev-usage__row"><span>{feature.label()}</span><TokenUsage usage={dshUsage(usage.byFeature[feature.id])} inline copy={false} /></div>)}
          {test && <div className="jev-usage__row"><span>{ui('验证密钥时的调用')}</span><TokenUsage usage={dshUsage(usage.byFeature.test)} inline copy={false} /></div>}
        </details>}
      </>}
      <p className="audio-provider-note">{ui('Jev 的 token 与学习模型的用量分开统计；这里只显示 token 数，不显示价格。')}</p>
    </div>
  );
}

/** The controls of one saved state. `settings` is jev.settings.get, `usage` is jev.usage's `usage`; `failure` its last failure. */
export function JevSettingsView({ settings, usage, failure, busy, working, result, error, onKey, onVerify, onClearKey, onConfirm, onEnabled, onFeature, onThreshold }) {
  const [value, setValue] = useState('');
  const messageId = useId(), step = setupStep(settings), ready = step === 'ready';
  const locked = busy || !!working;
  const save = event => { event.preventDefault(); const key = value.trim(); if (key) { onKey(key); setValue(''); } };
  const text = result && (result.ok ? TEST_STATE.valid() : uiMessage(result.message || failureCode('unexpected')));
  return (
    <>
      <JevPrivacy confirmed={settings.confirmed} disabled={locked} onChange={onConfirm} privacyUrl={settings.privacyUrl} />
      <article className={`audio-provider-card jev-card${settings.key.set ? ' is-set' : ''}`}>
        <header className="audio-provider-card__head">
          <h3>{ui('Jev 密钥')}</h3>
          <span className="audio-provider-card__chips"><span className="audio-chip">{ui('文字内容会上传')}</span></span>
        </header>
        <p className={`audio-key-state${settings.key.set ? ' is-set' : ''}`}>
          <Icon name={settings.key.set ? 'success' : 'key'} size={16} />
          {settings.key.set ? uiFormat('已保存 {0}', [settings.key.hint]) : ui('未配置')}
          {settings.key.source === 'env' && <span className="muted"> · {ui('来自环境变量')}</span>}
        </p>
        <form className="audio-key-form" onSubmit={save}>
          <input name="jev-key" className="audio-key-input" type="password" autoComplete="off" spellCheck={false} value={value} disabled={locked}
            aria-label={ui('Jev 密钥')} aria-describedby={result ? messageId : undefined}
            placeholder={settings.key.set ? uiFormat('已保存 {0}；粘贴新的会替换它', [settings.key.hint]) : ui('粘贴 TypeSafe 控制台里的 Jev 密钥')}
            onChange={event => setValue(event.target.value)} />
          <div className="audio-key-actions">
            <Button type="submit" variant="primary" busy={working === 'save'} disabled={locked || !value.trim()}>{ui('保存 Jev 密钥')}</Button>
            {settings.key.set && <Button variant="secondary" busy={working === 'verify'} disabled={locked || step !== 'ready'} onClick={onVerify}>{ui('验证 Jev 密钥')}</Button>}
            {settings.key.set && settings.key.source !== 'env' && <Button variant="quiet" size="sm" className="audio-key-clear" disabled={locked} onClick={onClearKey}>{ui('清除已保存的密钥')}</Button>}
          </div>
          <div className="audio-key-foot">
            {step === 'confirm' && <p className="audio-provider-note">{ui('先确认上面的隐私说明，才能验证密钥或使用任何 Jev 功能。')}</p>}
            {result && <InlineMessage id={messageId} tone={result.ok ? 'success' : 'error'}>{text}</InlineMessage>}
            <p className="audio-provider-note">{ui('验证只发一句不含你内容的话；密钥只保存在 DSH 主目录里，不进学习库、备份或快照。')}</p>
          </div>
        </form>
      </article>
      <fieldset className="jev-switches" disabled={!ready || locked}>
        <legend>{ui('实验功能开关')}</legend>
        {!ready && <p className="audio-provider-note">{ui('保存密钥并确认隐私说明之后才能打开。')}</p>}
        <label className="jev-switch jev-switch--master">
          <input type="checkbox" checked={!!settings.enabled} onChange={event => onEnabled(event.target.checked)} />
          <span><strong>{ui('启用 Jev 实验功能（总开关）')}</strong><small>{ui('关掉它就停用下面所有功能，立即生效；各项开关的选择会保留。')}</small></span>
        </label>
        {JEV_FEATURE_META.map(feature => <label key={feature.id} className="jev-switch" data-feature={feature.id}>
          <input type="checkbox" checked={!!settings.features[feature.id]} onChange={event => onFeature(feature.id, event.target.checked)} />
          <span><strong>{feature.label()}</strong><small>{feature.hint()}</small></span>
        </label>)}
        <label className="jev-threshold">
          <span><strong>{ui('自动填入所需的把握')}</strong><small>{ui('Jev 的把握低于这条线时，建议只展示概率，留给你决定。默认 80%。')}</small></span>
          <select value={String(settings.threshold)} onChange={event => onThreshold(Number(event.target.value))}>
            {thresholdChoices(settings.threshold).map(choice => <option key={choice} value={String(choice)}>{percentText(choice)}</option>)}
          </select>
        </label>
      </fieldset>
      {failure && <InlineMessage tone="warning" className="jev-failure">{uiMessage(failureCode(failure.reason))}</InlineMessage>}
      <JevUsageView usage={usage} />
      {error && <InlineMessage tone="error">{uiMessage(error)}</InlineMessage>}
    </>
  );
}

/** The settings section, connected. `initial` ({ settings, usage, failure }) skips the first read (previews, tests). */
export default function JevSettings({ call, busy = false, setNotice, initial = null, initialResult = null }) {
  useInjectCss(audioCss, 'study-audio-settings');
  useInjectCss(css, 'study-jev');
  const [settings, setSettings] = useState(initial?.settings ?? null), [usage, setUsage] = useState(initial?.usage ?? null), [failure, setFailure] = useState(initial?.failure ?? null);
  const [working, setWorking] = useState(''), [result, setResult] = useState(initialResult), [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const page = await call('jev.usage', {});
    setSettings(page.settings); setUsage(page.usage); setFailure(page.failure);
  }, [call]);
  useEffect(() => {
    let live = true;
    if (!initial && typeof call === 'function') Promise.resolve(call('jev.usage', {})).then(page => { if (live) { setSettings(page.settings); setUsage(page.usage); setFailure(page.failure); } }, () => { if (live) setError(ui('读不到 Jev 设置。')); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (kind, work) => {
    if (working) return;
    setWorking(kind); setError('');
    try { await work(); } catch (failed) { setError(String(failed?.message || failed)); } finally { setWorking(''); }
  };
  const change = (kind, patch, then) => run(kind, async () => { const next = await call('jev.settings.set', patch); setSettings(next); await then?.(next); await refresh(); });
  const verify = async () => { setResult(null); setResult(await call('jev.test', {})); await refresh(); };
  return (
    <fieldset className="audio-settings settings-section jev-settings" data-tour="settings-jev" data-experimental="true">
      <legend className="settings-section__title">{ui('实验性 · Jev 判断服务')}<span className="audio-chip audio-chip--accent jev-chip">{ui('实验性')}</span></legend>
      <p className="settings-section__lead">{ui('Jev 是 TypeSafe AI 的「System One」模型：又快又便宜，擅长做选择题式的判断，比如一份资料属于哪门课、一道题有没有问题。默认全部关闭；它给出的只是参考信号，不会替你做决定，出错或不可用时一切照旧。')}</p>
      {!settings && !error && <p className="muted">{ui('正在读取 Jev 设置…')}</p>}
      {settings && <JevSettingsView settings={settings} usage={usage} failure={failure} busy={busy} working={working} result={result} error={error}
        onKey={key => change('save', { key }, async next => { setResult(null); if (next.confirmed) await verify(); })}
        onVerify={() => run('verify', verify)}
        onClearKey={() => change('clear', { key: '' }, async () => { setResult(null); })}
        onConfirm={checked => change('confirm', { confirm: checked }, async () => { setNotice?.({ text: checked ? ui('已确认：Jev 功能会把所需内容发送到 TypeSafe 云端。') : ui('已撤回确认；之后使用 Jev 前会再问一次。'), tone: 'success' }); })}
        onEnabled={checked => change('enabled', { enabled: checked })}
        onFeature={(id, checked) => change('feature', { features: { [id]: checked } })}
        onThreshold={threshold => change('threshold', { threshold })} />}
      {settings?.settingsFile && <p className="audio-settings-path">{uiFormat('密钥和开关保存在 {0}，不在学习库里，也不会出现在导出或备份中。', [settings.settingsFile])}</p>}
    </fieldset>
  );
}
