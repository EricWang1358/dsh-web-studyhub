import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { kinds } from './shared.js';
import { Button } from './components/index.js';
import { describeFailure } from './generation-status.js';
import { DIFFICULTIES, focusIncludes, hasSettings } from './generate-form.js';

/* The 帮我想想 assist under 这次想练什么 (WP23). It only presents: Generate.jsx
   asks `generate.suggest` and keeps the result. With a model the button says
   what is sent (titles and outlines, never full text); without one, or after
   a failure, the same button answers from the learner's own wrong answers and
   material outlines. Failures read as one quiet sentence, never a banner. */
export default function GenerateAssist({ ready = false, phase = 'idle', result = null, focus = '', applied = false, disabled = false, onAsk, onPick, onApply }) {
  const loading = phase === 'loading';
  const local = result?.source === 'local';
  const failed = local && result?.unavailable?.reason === 'failed';
  const items = Array.isArray(result?.focus) ? result.focus : [];
  const settings = [Number.isInteger(result?.count) ? uiFormat('{0} 题', [result.count]) : '',
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
      {phase === 'done' && result && (
        <div className="generate-assist__result" aria-live="polite">
          {local && <p className="generate-assist__label">{ui('来自你的错题与资料目录')}</p>}
          {failed && <p className="generate-assist__note">{uiFormat('{0}，先给你来自本地数据的建议。', [describeFailure(result.unavailable.message).title])}</p>}
          {items.length ? (
            <div className="generate-chips" role="group" aria-label={ui('练习重点建议')}>
              {items.map((item) => (
                <button type="button" key={item} className="generate-chip generate-suggestion" aria-pressed={focusIncludes(focus, item)}
                  title={item} onClick={() => onPick?.(item)}>{item}</button>
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
