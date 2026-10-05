import React, { useMemo } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, useNow } from '../components/index.js';
import { formatDateTime } from '../format.js';
import { timelineModel } from './call-model.js';

/* The parallel timeline: one lane per slot of the pool the calls ran in, one bar per model call (dashed = a rate-limit wait). Drawn from the contract's
   calls (call-model.js timelineModel). A bar is a button: it selects the call, whose live output the right panel shows. The chart has a fixed height and
   scrolls inside itself, so more slots never push the panels below it. */

const LEGEND = { audio: [['transcribe', '转写'], ['proofread', '校对'], ['translate', '翻译']], generation: [['plan', '规划'], ['author', '出题'], ['review', '审阅'], ['repair', '修复']], coach: [['prep', '备题']] };
const LANE_WORD = { transcribe: '转写', slot: '槽', other: '其他' };

function laneLabel(lane) {
  if (lane.kind === 'slot') return uiFormat('槽 {0}', [lane.index]);
  return lane.index > 1 ? uiFormat('{0} {1}', [ui(LANE_WORD[lane.kind]), lane.index]) : ui(LANE_WORD[lane.kind]);
}

export default function Timeline({ calls, running, family, selected, onSelect }) {
  const now = useNow(2000, { enabled: running });
  const model = useMemo(() => timelineModel(calls, { now, running }), [calls, now, running]);
  const legend = LEGEND[family] || LEGEND.generation;
  const ticks = [0, 1 / 3, 2 / 3, 1].map((fraction) => model.begin + (model.end - model.begin) * fraction);
  return (
    <section className="tc-timeline" aria-label={ui('并行时间线')}>
      <div className="tc-panel-head">
        <h3>{ui('并行时间线')}</h3>
        <span className="tc-legend" aria-hidden="true">
          {legend.map(([kind, label]) => <span key={kind} data-kind={kind}><i />{ui(label)}</span>)}
          <span data-kind="wait"><i />{ui('限流')}</span>
        </span>
      </div>
      <div className="tc-lanes">
        {model.lanes.length === 0 && <p className="tc-empty">{ui('还没有模型调用。')}</p>}
        {model.lanes.map((lane) => (
          <div className="tc-lane" key={lane.key} data-lane={lane.key}>
            <span className="tc-lane__label">{laneLabel(lane)}</span>
            <div className="tc-track">
              {lane.bars.map((bar) => (
                <Button key={bar.callId} variant="quiet" className="tc-callbar" data-kind={bar.kind} data-wait={bar.wait || undefined} data-running={bar.running || undefined}
                  aria-pressed={selected === bar.callId} aria-label={bar.label} title={bar.label} style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  onClick={() => !bar.wait && onSelect(bar.callId)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="tc-axis" aria-hidden="true">
        <span className="tc-lane__label" />
        <div>{ticks.map((tick, index) => <span key={index}>{index === ticks.length - 1 && running ? ui('现在') : formatDateTime(tick, 'time')}</span>)}</div>
      </div>
    </section>
  );
}

