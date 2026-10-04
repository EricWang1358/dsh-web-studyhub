import React, { useEffect, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, InlineMessage, LoadingState } from '../components/index.js';
import ModelErrorNote from '../ModelErrorNote.jsx';
import { describeModelError } from '../generation-status.js';
import { useInjectCss } from '../shared.js';
import css from './teaching-status.css';

/** True once `active` has been true for `ms` (it starts over each time `active` turns on again). */
function useElapsed(active, ms) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!active) return undefined;
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return late;
}

/**
 * What the guided-learning chips (逐步理解 / 计算题引导练习) are doing, next to them: a quiet inline spinner while a step is being
 * prepared; after `slowAfterMs` it says the learner may carry on and offers 取消 (the late answer is ignored); a failure is shown in
 * place, as a model note (the settings for a key or a balance, 重试 for a busy service) or, for any other error, as its text with 重试.
 * busy: a request is in flight. failure: the error text of the last one ('' for none). onCancel / onRetry: the learner's two choices.
 */
export default function TeachingStatus({ busy, failure = '', onCancel, onRetry, slowAfterMs = 20000 }) {
  useInjectCss(css, 'study-teaching-status');
  const slow = useElapsed(busy, slowAfterMs);
  if (busy) {
    return (
      <span className="teaching-status">
        <LoadingState inline label={slow ? ui('仍在准备，可以先继续答题') : ui('正在准备当前步骤…')} />
        {slow && <Button variant="link" size="sm" onClick={onCancel}>{ui('取消')}</Button>}
      </span>
    );
  }
  if (!failure) return null;
  const known = describeModelError(failure).kind !== 'unknown';
  return known
    ? <ModelErrorNote error={failure} context="teaching" onRetry={onRetry} className="teaching-status-note" />
    : <InlineMessage tone="error" className="teaching-status-note" action={onRetry ? { label: ui('重试'), onClick: onRetry } : undefined}>{failure}</InlineMessage>;
}
