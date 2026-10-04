import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, CloseButton, Hint, InlineMessage } from '../components/index.js';

/**
 * Asking the model which decks of a course are worth merging, and merging the
 * ones the learner confirms. `run()` asks, `confirm(proposal)` merges one
 * proposal and drops it from the list, `close()` hides the panel.
 */
export function useMergeSuggestions({ suggestMerges, mergeDecks, course }) {
  const [suggestions, setSuggestions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = async (work) => {
    setBusy(true);
    setError('');
    try { await work(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return {
    suggestions, busy, error,
    run: () => attempt(async () => setSuggestions(await suggestMerges?.({ course }))),
    confirm: (proposal) => attempt(async () => {
      await mergeDecks?.({ targetId: proposal.targetId, sourceIds: proposal.sourceIds });
      setSuggestions((current) => ({ ...current, proposals: current.proposals.filter((item) => item.targetId !== proposal.targetId) }));
    }),
    close: () => setSuggestions(null),
  };
}

/** The error and the proposals of useMergeSuggestions (nothing when there is neither). */
export default function MergeSuggestions({ merge, busy }) {
  const { suggestions, error } = merge;
  return (
    <>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {suggestions && <div className="merge-suggestions">
        <div className="merge-suggestions-head">
          <strong>{uiFormat('{0} · 合并建议', [suggestions.course])}</strong>
          <CloseButton onClick={merge.close} />
        </div>
        {!suggestions.proposals.length && <Hint>
          {suggestions.method === 'unavailable' ? ui('当前没有可用模型；可以在题组管理中手动合并。') : ui('没有发现值得合并的题组。')}
        </Hint>}
        {suggestions.proposals.map((item) => <div className="merge-suggestion" key={item.targetId}>
          <div><strong>{item.sourceTitles.join('、')} → {item.targetTitle}</strong>
            <p>{item.reason}{' · '}{uiFormat('合并后共 {0} 题，全部题目保留。', [item.count])}</p></div>
          <Button size="sm" disabled={busy || merge.busy} onClick={() => merge.confirm(item)}>{ui('确认合并')}</Button>
        </div>)}
      </div>}
    </>
  );
}
