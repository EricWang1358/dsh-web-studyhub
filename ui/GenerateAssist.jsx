import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { kinds } from './shared.js';
import { Button, Chip } from './components/index.js';
import AiHelperNote from './AiHelperNote.jsx';
import { DIFFICULTIES, focusIncludes, hasSettings, levelLabel } from './generate-form.js';

/* The 帮我想想 assist under 这次想练什么 (WP23). It only presents: Generate.jsx
   asks `generate.suggest` and keeps the result. With a model the button says
   what is sent (titles and outlines, never full text); without one, or after
   a failure, the same button answers from the learner's own wrong answers and
   material outlines. A failure says why in one quiet line (AiHelperNote: no model, the
   call's error, or an answer that could not be read, with 再试一次), never a banner. */
export default function GenerateAssist({ ready = false, phase = 'idle', result = null, focus = '', applied = false, disabled = false, estimate = null, onAsk, onPick, onApply, onSettings }) {
  const loading = phase === 'loading';
  const local = result?.source === 'local';
  // A learner who knowingly has no model is told by the button itself; the line is for a helper that was expected to work.
  const why = local && (ready || result?.unavailable?.reason !== 'no-model') ? result?.unavailable : null;
  const items = Array.isArray(result?.focus) ? result.focus : [];
  const settings = [result?.coverage ? uiFormat('覆盖强度：{0}', [levelLabel(result.coverage)]) : '',
    DIFFICULTIES.find((item) => item.value === result?.difficulty)?.label || '',
    result?.kind ? kinds[result.kind] || (result.kind === 'mixed' ? ui('测验 + 闪卡') : '') : ''].filter(Boolean).join(' · ');
  return (
    <div className="generate-assist" data-tour="generate-assist">
      <div className="generate-assist__bar">
        <Button variant="secondary" size="sm" icon={ready ? 'sparkle' : undefined} busy={loading} disabled={disabled} data-generate-assist onClick={onAsk}>
          {ready ? ui('帮我想想') : ui('看看建议')}
        </Button>
        <span className="generate-assist__sent">{ready ? ui('只发送资料标题与目录，不发送全文') : ui('只用你的错题与资料目录，不调用模型')}</span>
      </div>
      {estimate}
      {phase === 'done' && result && (
        <div className="generate-assist__result" aria-live="polite">
          {local && <p className="generate-assist__label">{ui('来自你的错题与资料目录')}</p>}
          {why && <AiHelperNote unavailable={why} fallback="先给你来自本地数据的建议" onRetry={onAsk} onSettings={onSettings} />}
          {items.length ? (
            <div className="generate-presets" role="group" aria-label={ui('练习重点建议')}>
              {items.map((item) => (
                <Chip key={item} className="generate-suggestion" selected={focusIncludes(focus, item)} title={item} onClick={() => onPick?.(item)}>{item}</Chip>
              ))}
            </div>
          ) : <p className="generate-assist__note">{ui('还没有可以推荐的内容。先选好资料，或多做几轮练习再来。')}</p>}
          {!local && hasSettings(result) && (
            <div className="generate-assist__apply">
              <Button variant="secondary" size="sm" disabled={applied} onClick={onApply}>{applied ? ui('已按建议设置') : ui('按建议设置')}</Button>
              <span className="generate-assist__why">{[settings, result.why].filter(Boolean).join(' — ')}</span>
            </div>
          )}
          {!local && !hasSettings(result) && result.why && <p className="generate-assist__note">{result.why}</p>}
        </div>
      )}
    </div>
  );
}
