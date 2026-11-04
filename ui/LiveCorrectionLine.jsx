import React from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { joinMeta } from './format.js';
import { Button } from './components/index.js';

/**
 * The line above the transcript that says what the context polish has done: how many sentences it checked and changed, how many it gave up on (kept as
 * they were), and, when something went wrong, the error next to the one button that answers it. The plain counts are the whole story; how it works and
 * what it spent is behind 说明与用量. `total` is the number of sentences of the class, `polished` how many of them were changed.
 */
export default function LiveCorrectionLine({ correction, total, polished, active, busy, lock, onRetry, onSettings }) {
  const { running, paused: pausedValue = null, covered = 0, pending = 0, skipped = 0, error = '', calls = 0, cacheHits = 0, usage, warnings = [], skippedItems = [] } = correction;
  // Skipped sentences are asked again on the learner's word, while the class runs or after it; waiting sentences only after an error or the end.
  // 'format' | 'skips' | 'transient' | null (the correction's pause reason; absent before it was added). A model problem links to the audio settings; a network one does not.
  const paused = pausedValue ?? null;
  const modelProblem = paused === 'format' || paused === 'skips';
  const canRetry = !running && (skipped > 0 || !!paused || (pending > 0 && (!!error || !active)));
  const retry = <Button busy={busy} lock={lock} onClick={onRetry}>{ui('重试待校正内容')}</Button>;
  return <div className="live-correction-line" data-live-polish data-tour="live-polish">
    <span className={`live-correction-state${running ? ' running' : ''}`}>{running ? ui('正在按上下文润色…') : ui('上下文润色')}</span>
    <span className="muted">{total === 0 ? ui('等第一句说完后开始润色')
      : joinMeta([uiFormat('已检查 {0} / {1} 句 · 已润色 {2} 句', [covered, total, polished]),
        skipped > 0 ? uiFormat('已跳过 {0} 句（原文保留）', [skipped]) : '', pending > 0 ? uiFormat('待处理 {0}', [pending]) : ''])}</span>
    <span className="live-legend" aria-label={ui('右侧标记说明')}>
      <span><i className="live-dot polished" aria-hidden="true" />{ui('已润色')}</span>
      <span><i className="live-dot checked" aria-hidden="true" />{ui('已检查未改')}</span></span>
    {(error || canRetry) && <span className="live-correction-fix">
      {error ? <span className="live-correction-error" role="status">{uiMessage(error)}</span>
        : paused && <span className="live-correction-error" role="status">{ui('润色已暂停，点「重试待校正内容」再继续。')}</span>}
      {canRetry && retry}
      {modelProblem && onSettings && <Button variant="link" size="sm" data-live-model-setting onClick={onSettings}>{ui('到音频设置换一个文字模型')}</Button>}</span>}
    <details className="live-correction-more"><summary>{ui('说明与用量')}</summary>
      <p className="muted">{ui('每 30 秒检查一次新句子，按顺序分批，并带上前面几句作上下文；结束后补齐剩余内容。只有模型高置信度改动过的句子才会亮绿点：实心表示已润色，空心圈表示检查过、无需修改。')}</p>
      {skippedItems.length > 0 && <p>{uiFormat('已跳过的句子：{0}', [skippedItems.map(item => `${uiFormat('句 {0}', [item.id])} · ${uiMessage(item.reason)}`).join('；')])}</p>}
      {warnings.length > 0 && <><p>{ui('模型给出但没能用的内容')}</p>
        <ul>{warnings.map((warning, index) => <li key={index}>{uiMessage(warning)}</li>)}</ul></>}
      <p>{uiFormat('模型调用 {0} 次 · 本地结果复用 {1} 次', [calls, cacheHits])}</p>
      {usage && <p>{uiFormat('服务商缓存命中 {0} 输入 tokens', [(usage.free?.cachedInputTokens || 0) + (usage.paid?.cachedInputTokens || 0)])}</p>}
    </details>
  </div>;
}
