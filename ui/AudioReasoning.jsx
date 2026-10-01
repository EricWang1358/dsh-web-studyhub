import React from 'react';
import { getUiLanguage } from './i18n.js';

const levels = ['low', 'medium', 'high'];
export default function AudioReasoning({ settings, busy, onSave, timings = [] }) {
  const en = getUiLanguage() === 'en', t = (zh, english) => en ? english : zh;
  const proof = settings.proofreadReasoning || 'default', translation = settings.translateReasoning || 'low';
  const names = { default: t('跟随模型', 'Model default'), low: t('低 · 更快', 'Low · faster'), medium: t('中 · 均衡', 'Medium · balanced'), high: t('高 · 更精细', 'High · thorough') };
  const preset = (a, b) => proof === a && translation === b;
  const choose = (a, b) => onSave({ proofreadReasoning: a, translateReasoning: b });
  const sample = stage => {
    const summary = timings.find(item => item.stage === stage);
    const value = summary?.byReasoning?.[stage === 'proofread' ? proof : translation] || summary;
    return value?.averageMs == null ? t('等待耗时样本', 'Awaiting timing samples') : `${(value.averageMs / 1000).toFixed(1)}s · ${value.count} ${t('次近七日样本', 'samples in 7 days')}`;
  };
  return <section className="audio-reasoning" aria-labelledby="audio-reasoning-title">
    <div className="audio-section-title"><div><small>{t('时间 × 精度倾向', 'TIME × DEPTH')}</small><h3 id="audio-reasoning-title">{t('校正与翻译策略', 'Proofreading & translation')}</h3></div><span>{t('用于下一次处理', 'Applies to the next run')}</span></div>
    <div className="audio-reasoning-body">
      <div className="audio-reasoning-map">
        <p className="audio-matrix-current">{t('点击组合', 'Choose a pair')} · {t('校正', 'Proofread')} {names[proof].split(' · ')[0]} / {t('翻译', 'Translate')} {names[translation].split(' · ')[0]}</p>
        <span className="audio-matrix-axis">{t('校正 ↓ · 翻译 →', 'Proofreading ↓ · Translation →')}</span>
        <div className="audio-reasoning-grid" role="group" aria-label={t('选择校正与翻译推理组合', 'Choose proofreading and translation depths')}>
          <span />{levels.map(level => <span key={level} className="audio-matrix-level">{t(({ low: '低', medium: '中', high: '高' })[level], ({ low: 'Low', medium: 'Mid', high: 'High' })[level])}</span>)}
          {[...levels].reverse().map(a => <React.Fragment key={a}><span className="audio-matrix-level">{t(({ low: '低', medium: '中', high: '高' })[a], ({ low: 'Low', medium: 'Mid', high: 'High' })[a])}</span>{levels.map(b => <button type="button" key={`${a}:${b}`} disabled={busy} aria-pressed={preset(a, b)}
            aria-label={`${t('校正', 'Proofreading')}: ${names[a]}, ${t('翻译', 'Translation')}: ${names[b]}`}
            className={preset(a, b) ? 'selected' : ''} onClick={() => choose(a, b)}>
            <span className="audio-matrix-dot" aria-hidden="true" />
          </button>)}</React.Fragment>)}
        </div>
        <span className="audio-matrix-axis horizontal">{t('低：更快 · 高：更多推理', 'Low: faster · High: deeper')}</span>
      </div>
      <div className="audio-reasoning-fields">
        {[['proofreadReasoning', 'proofread', t('校正', 'Proofreading'), proof], ['translateReasoning', 'translate', t('翻译', 'Translation'), translation]].map(([field, stage, label, value]) =>
          <label key={field}><span>{label}<small>{sample(stage)}</small></span><select value={value} disabled={busy} onChange={event => onSave({ [field]: event.target.value })}>
            {Object.entries(names).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select></label>)}
        <p>{t('分别调节两项任务。高推理通常花更长时间；模型未提供该档位时，使用模型默认设置。', 'Tune each stage independently. Deeper reasoning usually takes longer; unsupported levels use the model default.')}</p>
      </div>
    </div>
  </section>;
}
