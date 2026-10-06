import React from 'react';
import { ui } from '../i18n.js';
import { TokenUsage } from '../TokenUsage.jsx';
import { timingRows } from '../token-usage.js';
import { jobTiming } from '../../lib/job-timing.js';

/* A job's own numbers, in the detail of the 任务 console: exactly what DSH's session
   panel shows. 实际用量 is the DSH usage block (Token 用量 / 缓存命中 / 未缓存输入 /
   缓存读取 / 缓存写入 / 输出, lib/token-usage.js) and, beside it, DSH's two speed
   figures 首 token 平均（TTFT）and 输出速度（TPS）.

   The figures are folded from the job's own calls, which is where the contract already
   carries them: a call whose child session was observed keeps DSH's own `sessionStats`
   (`call.timing`), and any other call contributes the boundaries the plugin observed.
   lib/job-timing.js owns that rule, so the console adds nothing of its own, never
   estimates a figure, and shows nothing rather than a guess when a job could not
   measure one. A running job's numbers are its settled calls' and grow as the rest end. */

export default function TaskUsage({ contract }) {
  const usage = contract?.usage?.tokenUsage || null;
  const rows = timingRows(jobTiming(contract?.calls));
  if (!usage && !rows.length) return null;
  return (
    <section className="tc-figures" aria-label={ui('用量与速度')}>
      {usage && <div className="tc-figures__row" data-task-usage>
        <span className="tc-figures__k">{ui('实际用量')}</span>
        <TokenUsage usage={usage} inline copy={false} className="tc-figures__usage" />
      </div>}
      {rows.length > 0 && <div className="tc-figures__row" data-task-timing>
        <span className="tc-figures__k">{ui('速度')}</span>
        <dl className="tc-figures__timings">
          {rows.map((row) => <div key={row.id} className="tc-figures__cell" data-figure={row.id}>
            <dt>{row.label}</dt><dd>{row.value}</dd>
          </div>)}
        </dl>
      </div>}
    </section>
  );
}
