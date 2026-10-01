import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getUiLanguage, ui, uiFormat } from './i18n.js';
import AudioReasoning from './AudioReasoning.jsx';

/* 用量控制台：首次转写之前不显示（什么都没配置时由音频页的配置卡片代替），
   显示后默认折叠；展开时才轮询。服务商按请求顺序排列：Gemini 免费 → 硅基流动 → Groq → Gemini 付费。 */

const providerNames = { free: 'Gemini Free', siliconflow: 'SiliconFlow', groq: 'Groq', paid: 'Gemini Paid' };
const REQUEST_ORDER = ['free', 'siliconflow', 'groq', 'paid'];
const fmt = value => new Intl.NumberFormat(getUiLanguage() === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 1 }).format(value);
const anyKey = settings => ['freeKey', 'siliconflowKey', 'groqKey', 'paidKey'].some(field => settings?.[field]?.set);

/** Shown only once something is configured and at least one request has been recorded. */
export function dashboardVisible(settings, usage) {
  return anyKey(settings) && usage?.since !== null && usage?.since !== undefined;
}

export function AudioDashboardView({ data, settings, busy, refresh, save, error }) {
  const en = getUiLanguage() === 'en', t = (zh, english) => en ? english : zh;
  const providers = [...data.providers].sort((a, b) => REQUEST_ORDER.indexOf(a.tier) - REQUEST_ORDER.indexOf(b.tier));
  const sum = field => providers.reduce((n, provider) => n + provider.today[field], 0);
  const total = sum('requests');
  const freeQuota = providers.filter(p => p.tier !== 'paid' && p.configured).flatMap(p => p.models.map(model => ({ ...model, tier: p.tier }))).find(model => model.limit !== null && model.limit > 0);
  const usedQuota = freeQuota ? freeQuota.limit - freeQuota.remaining : 0;
  const share = freeQuota ? Math.max(0, Math.min(100, Math.round(usedQuota / freeQuota.limit * 100))) : 0;
  const dayTotal = day => REQUEST_ORDER.reduce((n, tier) => n + (day[tier] || 0), 0);
  const max = Math.max(1, ...data.trend.map(dayTotal));
  return <section className="audio-dashboard" aria-labelledby="audio-dashboard-title">
    <header className="audio-dashboard-heading"><div><small>AUDIO / USAGE</small><h2 id="audio-dashboard-title">{t('用量控制台', 'Usage console')}</h2></div>
      <button type="button" disabled={busy} onClick={refresh}>{t('刷新', 'Refresh')} ↻</button></header>
    {error && <p className="audio-dashboard-error" role="alert">{error}</p>}
    <div className="audio-dashboard-summary">
      <div className="audio-usage-dial" style={{ '--share': `${share}%` }}><div><strong>{freeQuota ? fmt(freeQuota.remaining) : '—'}</strong>
        <span>{freeQuota ? `${freeQuota.tier === 'free' ? 'Gemini' : providerNames[freeQuota.tier]} · ${freeQuota.source === 'provider' ? t('服务端余量', 'Reported left') : t('估算余量', 'Estimated left')}` : t('免费额度待确认', 'Free limit unknown')}</span>
        {freeQuota && <small title={freeQuota.model}>{fmt(usedQuota)} / {fmt(freeQuota.limit)} {t('已用', 'used')}</small>}
      </div></div>
      <div className="audio-dashboard-metrics">
        <div><span>{t('今日模型请求', 'Model requests today')}</span><strong>{fmt(total)}<small>{t('次', 'calls')}</small></strong></div>
        <div><span>{t('已转录音频', 'Audio transcribed')}</span><strong>{fmt(sum('audioSeconds') / 60)}<small>min</small></strong></div>
        <div><span>{t('输入 / 输出 Token', 'Input / output tokens')}</span><strong className="audio-token-count">{fmt(sum('inputTokens'))}<small title={sum('outputUnknown') ? t('部分请求未报告输出 Token', 'Some calls did not report output tokens') : undefined}> / {sum('outputUnknown') ? (sum('outputTokens') ? `≥${fmt(sum('outputTokens'))}` : '—') : fmt(sum('outputTokens'))}</small></strong></div>
        <div><span>{t('限流 / 其他失败', 'Rate limited / other failures')}</span><strong>{sum('limited')}<small> / {sum('failures') - sum('limited')}</small></strong></div>
      </div>
    </div>
    <div className="audio-provider-list">
      {providers.map(provider => <article key={provider.tier} className={`audio-provider ${provider.tier}`}>
        <div className="audio-provider-heading"><span className="audio-provider-dot" aria-hidden="true" /><h3>{providerNames[provider.tier]}</h3>
          <small>{provider.configured ? settings[`${provider.tier}Key`]?.hint || t('已配置', 'Configured') : t('未配置', 'Not configured')}</small>
          <strong>{provider.today.requests}<span>{t('次请求', 'calls')}</span></strong></div>
        {provider.models.map(model => {
          const known = provider.configured && model.limit !== null;
          const used = model.source === 'provider' ? model.limit - model.remaining : model.used;
          const ratio = known ? Math.max(0, Math.min(100, used / Math.max(1, model.limit) * 100)) : 0;
          return <div className="audio-model-quota" key={model.model}><div><span title={model.model}>{model.model}</span><small>{!provider.configured ? '—'
            : known ? `${t('余', 'Left')} ${fmt(model.remaining)} / ${fmt(model.limit)}` : t('额度待确认', 'Limit not known')}</small></div>
            {known && <div className="audio-quota-track" role="progressbar"
              aria-label={`${model.model} ${t('已用每日额度', 'daily quota used')}`} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? model.limit : undefined} aria-valuenow={known ? Math.min(model.limit, Math.max(0, used)) : undefined}>
              <i style={{ width: `${ratio}%` }} /></div>}
            {known && <small>{model.source === 'provider' ? t('供应商响应 · 每日请求额度', 'Provider response · daily requests')
              : model.source === 'local-estimate' ? t('本地估算 · 仅本插件', 'Local estimate · this plugin only')
              : provider.tier === 'paid' ? t('付费通道 · 余额请查看供应商控制台', 'Paid route · check the provider for credit balance')
              : t('有额度响应后自动显示，或查看供应商控制台', 'Shown when a quota response is available; check the provider console')}</small>}
            {model.source === 'unknown' && model.lastQuota && <small>{t('上次额度响应已过期', 'Last quota response has expired')}</small>}
          </div>;
        })}
        {provider.tier === 'paid' ? <p className="audio-provider-note">{t('付费余额请查看供应商控制台', 'Check the provider console for credit balance')}</p>
          : provider.models.some(model => model.source === 'unknown') && <p className="audio-provider-note">{t('未知额度不会显示为零；可查看供应商控制台。', 'Unknown quota is not zero. Check the provider console.')}</p>}
      </article>)}
    </div>
    <section className="audio-usage-trend" aria-label={t('近七日请求趋势', 'Requests over seven days')}>
      <div className="audio-section-title"><h3>{t('近 7 日', 'Last 7 days')}</h3><span><i className="free" /> Gemini <i className="siliconflow" /> SiliconFlow <i className="groq" /> Groq <i className="paid" /> {t('付费', 'Paid')}</span></div>
      <div className="audio-trend-bars">{data.trend.map(day => <div key={day.date} className="audio-trend-day" tabIndex={0}
        aria-label={`${day.date}: Gemini Free ${day.free}, SiliconFlow ${day.siliconflow || 0}, Groq ${day.groq}, Gemini Paid ${day.paid}`}>
        <span>{dayTotal(day) || '—'}</span><div className="audio-trend-column">
          {['paid', 'groq', 'siliconflow', 'free'].map(tier => <i className={tier} key={tier} style={{ height: `${(day[tier] || 0) / max * 100}%` }} />)}
        </div><small>{day.date.slice(5).replace('-', '/')}</small></div>)}</div>
    </section>
    <AudioReasoning settings={settings} busy={busy} onSave={save} timings={data.timings} />
    <details className="audio-quota-settings"><summary>{t('设置 Gemini 免费每日上限', 'Set Gemini free daily limits')}</summary>
      <p>{t('从 AI Studio 填入当前模型的 RPD。Gemini 同项目共享额度，这里的已用量只统计本插件；0 表示未知。', 'Enter each model’s RPD from AI Studio. Gemini quotas are shared by project; usage here covers this plugin only. 0 means unknown.')}</p>
      <form onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); const dailyLimits = { ...settings.dailyLimits };
        for (const [model, value] of values) dailyLimits[model] = Number(value); save({ dailyLimits }); }}>
        {[...new Set([settings.transcribeModel, settings.textModel].filter(Boolean))].map(model => <label key={model}>{model}<input type="number" name={model} min="0" max="1000000000" step="1" defaultValue={settings.dailyLimits?.[model] || 0} required disabled={busy} /></label>)}
        <button type="submit" disabled={busy}>{t('保存上限', 'Save limits')}</button>
      </form>
    </details>
    <footer className="audio-dashboard-footer"><span>{t('今日按太平洋时间 · 从启用此统计起记录模型请求，包含失败及重试。课堂实时音频与 DSH Token 不计入。', 'Today uses Pacific time · recorded model calls include failures and retries. Live audio streams and DSH tokens are excluded.')}</span>
      <a href="https://aistudio.google.com/usage" target="_blank" rel="noreferrer">AI Studio ↗</a><a href="https://cloud.siliconflow.cn" target="_blank" rel="noreferrer">SiliconFlow ↗</a><a href="https://console.groq.com/settings/limits" target="_blank" rel="noreferrer">Groq ↗</a></footer>
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
  useEffect(() => {
    let alive = true;
    const update = () => {
      if (saving.current || polling.current || document.visibilityState === 'hidden') return;
      polling.current = true;
      const expected = revision.current;
      return load().then(({ usage, config }) => { if (alive && !saving.current && expected === revision.current) { setData(usage); setSettings(config); setError(''); } }, e => { if (alive && !saving.current && expected === revision.current) setError(e.message); })
        .finally(() => { polling.current = false; });
    };
    void update();
    // Only an open console is kept fresh; a folded one is read once to decide whether to show at all.
    const timer = open ? setInterval(update, 15000) : null;
    document.addEventListener('visibilitychange', update);
    return () => { alive = false; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [load, open]);
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
