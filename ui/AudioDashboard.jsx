import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import AudioReasoning from './AudioReasoning.jsx';
import { formatNumber } from './format.js';
import { Hint } from './components/index.js';
import { usePolling } from './use-polling.js';
import { AUDIO_PROVIDERS, AUDIO_TIERS, KEY_FIELDS, providerOf } from '../lib/audio-providers.js';

/* 用量控制台：首次转写之前不显示（什么都没配置时由音频页的配置卡片代替），
   显示后默认折叠；展开时才轮询。服务商按请求顺序排列：Gemini 免费 → 硅基流动 → Groq → Gemini 付费。 */

const providerName = tier => ui(providerOf(tier).shortName);
const fmt = value => formatNumber(value, { maximumFractionDigits: 1 });
const anyKey = settings => KEY_FIELDS.some(field => settings?.[field]?.set);

/** Shown only once something is configured and at least one request has been recorded. */
export function dashboardVisible(settings, usage) {
  return anyKey(settings) && usage?.since !== null && usage?.since !== undefined;
}

export function AudioDashboardView({ data, settings, busy, refresh, save, error }) {
  const providers = [...data.providers].sort((a, b) => AUDIO_TIERS.indexOf(a.tier) - AUDIO_TIERS.indexOf(b.tier));
  const sum = field => providers.reduce((n, provider) => n + provider.today[field], 0);
  const total = sum('requests');
  const freeQuota = providers.filter(p => p.tier !== 'paid' && p.configured).flatMap(p => p.models.map(model => ({ ...model, tier: p.tier }))).find(model => model.limit !== null && model.limit > 0);
  const usedQuota = freeQuota ? freeQuota.limit - freeQuota.remaining : 0;
  const share = freeQuota ? Math.max(0, Math.min(100, Math.round(usedQuota / freeQuota.limit * 100))) : 0;
  const dayTotal = day => AUDIO_TIERS.reduce((n, tier) => n + (day[tier] || 0), 0);
  const max = Math.max(1, ...data.trend.map(dayTotal));
  return <section className="audio-dashboard" aria-labelledby="audio-dashboard-title">
    <header className="audio-dashboard-heading"><div><small>AUDIO / USAGE</small><h2 id="audio-dashboard-title">{ui('用量控制台')}</h2></div>
      <button type="button" disabled={busy} onClick={refresh}>{ui('刷新')} ↻</button></header>
    {error && <p className="audio-dashboard-error" role="alert">{uiMessage(error)}</p>}
    <div className="audio-dashboard-summary">
      <div className="audio-usage-dial" style={{ '--share': `${share}%` }}><div><strong>{freeQuota ? fmt(freeQuota.remaining) : '—'}</strong>
        <span>{freeQuota ? `${freeQuota.tier === 'free' ? 'Gemini' : providerName(freeQuota.tier)} · ${freeQuota.source === 'provider' ? ui('服务端余量') : ui('估算余量')}` : ui('免费额度待确认')}</span>
        {freeQuota && <small title={freeQuota.model}>{uiFormat('{0} / {1} 已用', [fmt(usedQuota), fmt(freeQuota.limit)])}</small>}
      </div></div>
      <div className="audio-dashboard-metrics">
        <div><span>{ui('今日模型请求')}</span><strong>{fmt(total)}<small>{ui('次')}</small></strong></div>
        <div><span>{ui('已转录音频')}</span><strong>{fmt(sum('audioSeconds') / 60)}<small>min</small></strong></div>
        <div><span>{ui('输入 / 输出 Token')}</span><strong className="audio-token-count">{fmt(sum('inputTokens'))}<small title={sum('outputUnknown') ? ui('部分请求未报告输出 Token') : undefined}> / {sum('outputUnknown') ? (sum('outputTokens') ? `≥${fmt(sum('outputTokens'))}` : '—') : fmt(sum('outputTokens'))}</small></strong></div>
        <div><span>{ui('限流 / 其他失败')}</span><strong>{fmt(sum('limited'))}<small> / {fmt(sum('failures') - sum('limited'))}</small></strong></div>
      </div>
    </div>
    <div className="audio-provider-list">
      {providers.map(provider => <article key={provider.tier} className={`audio-provider ${provider.tier}`}>
        <div className="audio-provider-heading"><span className="audio-provider-dot" aria-hidden="true" /><h3>{providerName(provider.tier)}</h3>
          <small>{provider.configured ? settings[`${provider.tier}Key`]?.hint || ui('已配置') : ui('未配置')}</small>
          <strong>{fmt(provider.today.requests)}<span>{ui('次请求')}</span></strong></div>
        {provider.models.map(model => {
          const known = provider.configured && model.limit !== null;
          const used = model.source === 'provider' ? model.limit - model.remaining : model.used;
          const ratio = known ? Math.max(0, Math.min(100, used / Math.max(1, model.limit) * 100)) : 0;
          return <div className="audio-model-quota" key={model.model}><div><span title={model.model}>{model.model}</span><small>{!provider.configured ? '—'
            : known ? uiFormat('余 {0} / {1}', [fmt(model.remaining), fmt(model.limit)]) : ui('额度待确认')}</small></div>
            {known && <div className="audio-quota-track" role="progressbar"
              aria-label={uiFormat('{0} 已用每日额度', [model.model])} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? model.limit : undefined} aria-valuenow={known ? Math.min(model.limit, Math.max(0, used)) : undefined}>
              <i style={{ width: `${ratio}%` }} /></div>}
            {known && <small>{model.source === 'provider' ? ui('供应商响应 · 每日请求额度')
              : model.source === 'local-estimate' ? ui('本地估算 · 仅本插件')
              : provider.tier === 'paid' ? ui('付费通道 · 余额请查看供应商控制台')
              : ui('有额度响应后自动显示，或查看供应商控制台')}</small>}
            {model.source === 'unknown' && model.lastQuota && <small>{ui('上次额度响应已过期')}</small>}
          </div>;
        })}
        {provider.tier === 'paid' ? <Hint size="xs" className="audio-provider-footnote">{ui('付费余额请查看供应商控制台')}</Hint>
          : provider.models.some(model => model.source === 'unknown') && <Hint size="xs" className="audio-provider-footnote">{ui('未知额度不会显示为零；可查看供应商控制台。')}</Hint>}
      </article>)}
    </div>
    <section className="audio-usage-trend" aria-label={ui('近七日请求趋势')}>
      <div className="audio-section-title"><h3>{ui('近 7 日')}</h3><span>{AUDIO_PROVIDERS.map(provider => <React.Fragment key={provider.tier}><i className={provider.tier} /> {providerName(provider.tier)} </React.Fragment>)}</span></div>
      <div className="audio-trend-bars">{data.trend.map(day => <div key={day.date} className="audio-trend-day" tabIndex={0}
        aria-label={uiFormat('{0}: {1}', [day.date, AUDIO_TIERS.map(tier => `${providerName(tier)} ${day[tier] || 0}`).join(', ')])}>
        <span>{dayTotal(day) || '—'}</span><div className="audio-trend-column">
          {[...AUDIO_TIERS].reverse().map(tier => <i className={tier} key={tier} style={{ height: `${(day[tier] || 0) / max * 100}%` }} />)}
        </div><small>{day.date.slice(5).replace('-', '/')}</small></div>)}</div>
    </section>
    <AudioReasoning settings={settings} busy={busy} onSave={save} timings={data.timings} />
    <details className="audio-quota-settings"><summary>{ui('设置 Gemini 免费每日上限')}</summary>
      <p>{ui('从 AI Studio 填入当前模型的 RPD。Gemini 同项目共享额度，这里的已用量只统计本插件；0 表示未知。')}</p>
      <form onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); const dailyLimits = { ...settings.dailyLimits };
        for (const [model, value] of values) dailyLimits[model] = Number(value); save({ dailyLimits }); }}>
        {[...new Set([settings.transcribeModel, settings.textModel].filter(Boolean))].map(model => <label key={model}>{model}<input type="number" name={model} min="0" max="1000000000" step="1" defaultValue={settings.dailyLimits?.[model] || 0} required disabled={busy} /></label>)}
        <button type="submit" disabled={busy}>{ui('保存上限')}</button>
      </form>
    </details>
    <footer className="audio-dashboard-footer"><span>{ui('今日按太平洋时间 · 从启用此统计起记录模型请求，包含失败及重试。课堂实时音频与 DSH Token 不计入。')}</span>
      {AUDIO_PROVIDERS.filter(provider => provider.tier !== 'paid').map(provider => <a key={provider.tier} href={provider.usageUrl} target="_blank" rel="noreferrer">{providerName(provider.tier)} ↗</a>)}</footer>
  </section>;
}

/** The console folded away under one line with today's count; it opens on demand. */
export function AudioDashboardPanel({ data, settings, busy, refresh, save, error, onToggle }) {
  const today = data.providers.reduce((n, provider) => n + (provider.today?.requests || 0), 0);
  return <details className="audio-usage-panel" onToggle={onToggle ? event => onToggle(event.currentTarget.open) : undefined}>
    <summary><span>{ui('用量与额度')}</span><small>{uiFormat('今日 {0} 次请求', [today])}</small></summary>
    <AudioDashboardView data={data} settings={settings} busy={busy} refresh={refresh} save={save} error={error} />
  </details>;
}

export default function AudioDashboard({ call }) {
  const [data, setData] = useState(null), [settings, setSettings] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const saving = useRef(false);
  const polling = useRef(false);
  const revision = useRef(0);
  const load = useCallback(async () => {
    const [usage, config] = await Promise.all([call('audio.usage', {}), call('audio.settings.get', {})]);
    return { usage, config };
  }, [call]);
  const update = useCallback(() => {
    if (saving.current || polling.current) return undefined;
    polling.current = true;
    const expected = revision.current;
    return load().then(({ usage, config }) => { if (!saving.current && expected === revision.current) { setData(usage); setSettings(config); setError(''); } },
      e => { if (!saving.current && expected === revision.current) setError(e.message); })
      .finally(() => { polling.current = false; });
  }, [load]);
  // A folded console is read when it mounts, when it opens and when the tab comes back, to decide whether to show at all;
  // an open one is also kept fresh (not while the tab is hidden).
  useEffect(() => {
    if (!document.hidden) void update();
    const back = () => { if (!document.hidden) void update(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [update, open]);
  usePolling(update, { intervalMs: 15000, enabled: open });
  const refresh = async () => {
    revision.current++;
    setBusy(true);
    try { const { usage, config } = await load(); setData(usage); setSettings(config); setError(''); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const save = async patch => {
    if (saving.current) return;
    revision.current++;
    saving.current = true; setBusy(true);
    try { setSettings(await call('audio.settings.set', patch)); setData(await call('audio.usage', {})); setError(''); }
    catch (e) { setError(e.message); } finally { saving.current = false; setBusy(false); }
  };
  // Before the first transcription there is nothing to show; with nothing configured the setup card stands in for it.
  if (!data || !settings || !dashboardVisible(settings, data)) return null;
  return <AudioDashboardPanel data={data} settings={settings} error={error} busy={busy} refresh={refresh} save={save} onToggle={setOpen} />;
}
