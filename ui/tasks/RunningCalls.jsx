import React from 'react';
import { ui } from '../i18n.js';
import { Button, useNow } from '../components/index.js';
import { formatElapsed, joinMeta } from '../format.js';
import { callLabel, runnerLabel, runningCalls } from './call-model.js';

/* 正在进行: the calls in flight, one row each: what it is, how long it has run, who runs it. A row selects the call; its live output is the right panel. */

export default function RunningCalls({ calls, active, selected, onSelect, idleText }) {
  const rows = runningCalls(calls), now = useNow(1000, { enabled: rows.length > 0 });
  if (!rows.length) return <p className="tc-empty">{idleText || (active ? ui('现在没有正在进行的调用。') : ui('任务已经结束，没有正在进行的调用。'))}</p>;
  return rows.map((call) => (
    <Button key={call.callId} variant="quiet" block className="tc-callrow" aria-pressed={selected === call.callId} data-call-id={call.callId} onClick={() => call.kind !== 'wait' && onSelect(call.callId)}>
      <span className="tc-dot" data-state={call.kind === 'wait' ? 'paused' : 'run'} aria-hidden="true" />
      <span className="tc-callrow__step">{callLabel(call, { file: true })}</span>
      <span className="tc-num">{formatElapsed(now - Date.parse(call.startedAt))}</span>
      <span className="tc-callrow__by">{joinMeta([runnerLabel(call), call.slot ? `${ui('槽')} ${call.slot}` : ''])}</span>
    </Button>
  ));
}
