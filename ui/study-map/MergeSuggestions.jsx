import React, { useEffect, useRef, useState } from 'react';
import { errorMessage, ui, uiFormat } from '../i18n.js';
import { Button, CloseButton, Hint, InlineMessage } from '../components/index.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { useStudy } from '../study-context.jsx';

/**
 * Pure state transition after one proposal is merged: returns null when closed mid-flight or when the last proposal was merged.
 */
export function afterMergeConfirmed(current, targetId) {
  if (!current || !Array.isArray(current.proposals)) return null;
  const remaining = current.proposals.filter((item) => item.targetId !== targetId);
  return remaining.length ? { ...current, proposals: remaining } : null;
}

/**
 * Asking the model which decks of a course are worth merging, and merging the
 * ones the learner confirms. `run()` asks, `confirm(proposal)` merges one
 * proposal and drops it from the list (closing cleanly when the last one is merged), `close()` hides the panel and clears errors.
 */
export function useMergeSuggestions({ suggestMerges, mergeDecks, course, root = '' }) {
  const [suggestions, setSuggestions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reqRef = useRef(0);
  const mountedRef = useRef(true);
  const scopeKey = `${root ?? ''}\0${course ?? ''}`;
  const prevScopeRef = useRef(scopeKey);
  useEffect(() => () => { mountedRef.current = false; reqRef.current += 1; }, []);
  useEffect(() => {
    if (prevScopeRef.current === scopeKey) return;
    prevScopeRef.current = scopeKey;
    reqRef.current += 1;
    setSuggestions(null);
    setError('');
    setBusy(false);
  }, [scopeKey]);
  const attempt = async (work) => {
    const req = ++reqRef.current;
    setBusy(true);
    setError('');
    try { await work(req); }
    catch (failure) { if (mountedRef.current && req === reqRef.current) setError(errorMessage(failure)); }
    finally { if (mountedRef.current && req === reqRef.current) setBusy(false); }
  };
  return {
    suggestions, busy, error,
    clearError: () => setError(''),
    run: () => attempt(async (req) => {
      const next = await suggestMerges?.({ course });
      if (mountedRef.current && req === reqRef.current) setSuggestions(next ?? null);
    }),
    confirm: (proposal) => attempt(async (req) => {
      const done = await mergeDecks?.({ targetId: proposal.targetId, sourceIds: proposal.sourceIds });
      if (!done || !mountedRef.current || req !== reqRef.current) return;
      setSuggestions((current) => afterMergeConfirmed(current, proposal.targetId));
    }),
    close: () => {
      reqRef.current += 1;
      setSuggestions(null);
      setError('');
      setBusy(false);
    },
  };
}

/** The error and the proposals of useMergeSuggestions (nothing when there is neither). */
export default function MergeSuggestions({ merge }) {
  const { busy } = useStudy();
  const { suggestions, error } = merge;
  return (
    <>
      {error && <InlineMessage tone="error" onDismiss={merge.clearError}>{error}</InlineMessage>}
      {suggestions && <div className="merge-suggestions">
        <div className="merge-suggestions-head">
          <strong>{uiFormat('{0} · 合并建议', [suggestions.course || ui('未分类课程')])}</strong>
          <CloseButton onClick={merge.close} />
        </div>
        {!suggestions.proposals.length && (suggestions.method === 'unavailable'
          ? <ModelSetupGate variant="compact" feature="merge" model={{ ready: false }} />
          : <Hint>{ui('没有发现值得合并的题组。')}</Hint>)}
        {suggestions.proposals.map((item) => <div className="merge-suggestion" key={item.targetId}>
          <div><strong>{item.sourceTitles.join('、')} → {item.targetTitle}</strong>
            <p>{item.reason}{' · '}{uiFormat('合并后共 {0} 题，全部题目保留。', [item.count])}</p></div>
          <Button size="sm" lock={busy || merge.busy} onClick={() => merge.confirm(item)}>{ui('确认合并')}</Button>
        </div>)}
      </div>}
    </>
  );
}
