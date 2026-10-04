import React from 'react';
import { ui, uiFormat } from './i18n.js';

const levels = ['low', 'medium', 'high'];
export default function AudioReasoning({ settings, busy, onSave, timings = [] }) {
  const proof = settings.proofreadReasoning || 'default', translation = settings.translateReasoning || 'low';
  const names = { default: ui('跟随模型'), low: ui('低 · 更快'), medium: ui('中 · 均衡'), high: ui('高 · 更精细') };
  const levelName = { low: ui('低'), medium: ui('中'), high: ui('高') };
  const preset = (a, b) => proof === a && translation === b;
  const choose = (a, b) => onSave({ proofreadReasoning: a, translateReasoning: b });
  const sample = stage => {
    const summary = timings.find(item => item.stage === stage);
    const value = summary?.byReasoning?.[stage === 'proofread' ? proof : translation] || summary;
    return value?.averageMs == null ? ui('等待耗时样本') : uiFormat('{0}s · {1} 次近七日样本', [(value.averageMs / 1000).toFixed(1), value.count]);
  };
  return <section className="audio-reasoning" aria-labelledby="audio-reasoning-title">
    <div className="audio-section-title"><div><small>{ui('时间 × 精度倾向')}</small><h3 id="audio-reasoning-title">{ui('校正与翻译策略')}</h3></div><span>{ui('用于下一次处理')}</span></div>
    <div className="audio-reasoning-body">
      <div className="audio-reasoning-map">
        <p className="audio-matrix-current">{uiFormat('点击组合 · 校正 {0} / 翻译 {1}', [names[proof].split(' · ')[0], names[translation].split(' · ')[0]])}</p>
        <span className="audio-matrix-axis">{ui('校正 ↓ · 翻译 →')}</span>
        <div className="audio-reasoning-grid" role="group" aria-label={ui('选择校正与翻译推理组合')}>
          <span />{levels.map(level => <span key={level} className="audio-matrix-level">{levelName[level]}</span>)}
          {[...levels].reverse().map(a => <React.Fragment key={a}><span className="audio-matrix-level">{levelName[a]}</span>{levels.map(b => <button type="button" key={`${a}:${b}`} disabled={busy} aria-pressed={preset(a, b)}
            aria-label={uiFormat('校正: {0}, 翻译: {1}', [names[a], names[b]])}
            className={preset(a, b) ? 'selected' : ''} onClick={() => choose(a, b)}>
            <span className="audio-matrix-dot" aria-hidden="true" />
          </button>)}</React.Fragment>)}
        </div>
        <span className="audio-matrix-axis horizontal">{ui('低：更快 · 高：更多推理')}</span>
      </div>
      <div className="audio-reasoning-fields">
        {[['proofreadReasoning', 'proofread', ui('校正'), proof], ['translateReasoning', 'translate', ui('翻译'), translation]].map(([field, stage, label, value]) =>
          <label key={field}><span>{label}<small>{sample(stage)}</small></span><select value={value} disabled={busy} onChange={event => onSave({ [field]: event.target.value })}>
            {Object.entries(names).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select></label>)}
        <p>{ui('分别调节两项任务。高推理通常花更长时间；模型未提供该档位时，使用模型默认设置。')}</p>
      </div>
    </div>
  </section>;
}
