import React, { useMemo } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip, useNow } from '../components/index.js';
import { formatDateTime, formatElapsed, joinMeta } from '../format.js';
import { shortFile, timelineLegend, timelineModel } from './call-model.js';
import { callMs, longRuleText, slowestText } from './time-limit.js';

/* The parallel timeline: one lane per unit of work (a file of an audio import, a part of a question run, 整体 for the rest; one lane per pool slot only when the
   calls name neither), one bar per model call (dashed = a rate-limit wait). Drawn from the contract's calls (call-model.js timelineModel). A bar is a button:
   it selects the call, whose live output the right panel shows; its title also says which slot it ran in. The chart has a fixed height and scrolls inside
   itself, so more lanes never push the panels below it. */

const LANE_WORD = { transcribe: '转写', slot: '槽', other: '其他', whole: '整体' };

/** What a lane is called: { text, title }. The extra lanes of a unit (row 2, 3) carry no label: they continue the lane above. */
function laneLabel(lane) {
  if (lane.row > 1) return { text: '', title: '' };
  if (lane.kind === 'file') return { text: shortFile(lane.file), title: lane.file };
  if (lane.kind === 'part') { const text = uiFormat('第 {0} 批', [lane.part]); return { text, title: text }; }
  if (lane.kind === 'slot') { const text = uiFormat('槽 {0}', [lane.index]); return { text, title: text }; }
  const text = lane.index > 1 ? uiFormat('{0} {1}', [ui(LANE_WORD[lane.kind]), lane.index]) : ui(LANE_WORD[lane.kind]);
  return { text, title: text };
}
const barTitle = (bar) => (bar.slot ? uiFormat('{0} · 槽 {1}', [bar.label, bar.slot]) : bar.label);
/** A bar the strip points at (time-limit.js slowSteps): its title also says how long the call took and why it is marked. */
const markTitle = (bar, mark, ms) => joinMeta([barTitle(bar), ms === null ? '' : formatElapsed(ms), mark === 'long' ? longRuleText() : slowestText()]);

export default function Timeline({ calls, running, family, contractKind, selected, marks, onSelect }) {
  const now = useNow(2000, { enabled: running });
  const model = useMemo(() => timelineModel(calls, { now, running, pinned: marks ? [...marks.keys()] : [] }), [calls, now, running, marks]);
  const legend = useMemo(() => timelineLegend(family, contractKind), [family, contractKind]);
  const byId = useMemo(() => new Map((calls || []).map((call) => [call.callId, call])), [calls]);
  const ticks = [0, 1 / 3, 2 / 3, 1].map((fraction) => model.begin + (model.end - model.begin) * fraction);
  return (
    <section className="tc-timeline" aria-label={ui('并行时间线')}>
      <div className="tc-panel-head">
        <h3>{ui('并行时间线')}</h3>
        <span className="tc-legend" aria-hidden="true">
          {legend.map(([kind, label]) => <span key={kind} data-kind={kind}><i />{ui(label)}</span>)}
          <span data-kind="wait"><i />{ui('限流')}</span>
          {marks?.size > 0 && <span data-kind="slow"><i />{ui('偏久')}</span>}
        </span>
      </div>
      <div className="tc-lanes">
        {model.lanes.length === 0 && <p className="tc-empty">{ui('还没有模型调用。')}</p>}
        {model.lanes.map((lane) => { const name = laneLabel(lane); return (
          <div className="tc-lane" key={lane.key} data-lane={lane.key} data-lane-kind={lane.kind}>
            {name.title ? <Tooltip layer anchorClassName="tc-lane__label" content={name.title}><span tabIndex={0}>{name.text}</span></Tooltip> : <span className="tc-lane__label">{name.text}</span>}
            <div className="tc-track">
              {lane.bars.map((bar) => (
                <Button key={bar.callId} variant="quiet" className="tc-callbar" data-kind={bar.kind} data-wait={bar.wait || undefined} data-running={bar.running || undefined} data-slow={marks?.get(bar.callId)}
                  aria-pressed={selected === bar.callId} aria-label={marks?.get(bar.callId) ? joinMeta([bar.label, ui(marks.get(bar.callId) === 'long' ? '运行偏久' : '最慢的一步')]) : bar.label} title={marks?.get(bar.callId) ? markTitle(bar, marks.get(bar.callId), callMs(byId.get(bar.callId), now)) : barTitle(bar)}
                  style={{ left: `${bar.left}%`, width: `${bar.width}%` }} onClick={() => !bar.wait && onSelect(bar.callId)} />
              ))}
            </div>
          </div>
        ); })}
        {model.hiddenLanes > 0 && <p className="tc-lanes__more">{uiFormat('另有 {0} 条', [model.hiddenLanes])}</p>}
      </div>
      <div className="tc-axis" aria-hidden="true">
        <span className="tc-lane__label" />
        <div>{ticks.map((tick, index) => <span key={index}>{index === ticks.length - 1 && running ? ui('现在') : formatDateTime(tick, 'time')}</span>)}</div>
      </div>
    </section>
  );
}

