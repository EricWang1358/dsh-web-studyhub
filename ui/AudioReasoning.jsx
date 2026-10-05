import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Hint } from './components/index.js';
import { EffortSelect, effortNoteText } from './EffortSelect.jsx';

export { EffortSelect, effortNoteText };

/* Reasoning strength of the audio text steps. One control per setting: a select whose options are the levels the model in use
   offers (its own names) plus "model default" (ui/EffortSelect.jsx, shared with the per-stage levels of 出题偏好). The saved value is a relative
   strength (lib/model-effort.js); when the model has no level of that strength the nearest one is shown and used, and the note says so. */

export default function AudioReasoning({ settings, busy, onSave, timings = [], efforts = null, modelName = '' }) {
  const proof = settings.proofreadReasoning || 'default', translation = settings.translateReasoning || 'low';
  const sample = (stage, level) => {
    const summary = timings.find(item => item.stage === stage);
    const value = summary?.byReasoning?.[level] || summary;
    return value?.averageMs == null ? ui('等待耗时样本') : uiFormat('{0}s · {1} 次近七日样本', [(value.averageMs / 1000).toFixed(1), value.count]);
  };
  return <section className="audio-reasoning" aria-labelledby="audio-reasoning-title">
    <div className="audio-section-title"><div><small>{ui('时间 × 精度倾向')}</small><h3 id="audio-reasoning-title">{ui('校对与翻译的推理强度')}</h3></div><span>{ui('用于下一次处理')}</span></div>
    <div className="audio-reasoning-fields">
      <EffortSelect label={ui('校正')} value={proof} efforts={efforts} disabled={busy} description={sample('proofread', proof)} onChange={value => onSave({ proofreadReasoning: value })} />
      <EffortSelect label={ui('翻译')} value={translation} efforts={efforts} disabled={busy} description={sample('translate', translation)} onChange={value => onSave({ translateReasoning: value })} />
      <Hint className="audio-reasoning-help">{modelName ? uiFormat('档位来自当前模型 {0}。高推理通常花更长时间；换模型后，同样的倾向会对应到新模型最接近的档位，并在这里说明。', [modelName])
        : ui('档位来自当前模型。高推理通常花更长时间；换模型后，同样的倾向会对应到新模型最接近的档位，并在这里说明。')}</Hint>
    </div>
  </section>;
}
