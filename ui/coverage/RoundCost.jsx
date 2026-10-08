import React from 'react';
import { ui } from '../i18n.js';
import { useStudy } from '../study-context.jsx';
import { useUsageEstimate } from '../TokenUsage.jsx';
import { estimateSummary } from '../token-usage.js';
import { roundCostLine } from './copy.js';

/* What a top-up that goes on by itself is expected to use, said where it is started (the 资料 row's confirm button, the choice 自动补到完整 of the draft page): the estimate of the round it begins
   with (usage.estimate prices exactly the request the generate action will make), and, as a separate clause, that the rounds after it follow by themselves and are counted on their own.
   The view draws what the state says and nothing it cannot say: an estimate that is not there (idle, failed) leaves the slot empty instead of a made-up number. */

/** The slot: `state` is useUsageEstimate's, `roundsAfter` how many rounds follow the one that starts. */
export function RoundCostView({ state = { status: 'idle' }, roundsAfter = 0 }) {
  const text = state.status === 'ready' ? roundCostLine(estimateSummary(state.estimate), roundsAfter) : state.status === 'loading' ? ui('正在估算…') : '';
  return <small className="cov-cost" data-round-cost data-status={state.status} data-rounds-after={roundsAfter} aria-live="polite">{text}</small>;
}

/** The slot, asking `usage.estimate` for `request` (with `feature`) once it settles. */
export default function RoundCost({ request, roundsAfter = 0, enabled = true }) {
  const { call } = useStudy();
  const state = useUsageEstimate(call, request, { enabled });
  return enabled ? <RoundCostView state={state} roundsAfter={roundsAfter} /> : null;
}
