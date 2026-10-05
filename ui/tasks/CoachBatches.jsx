import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatDateTime, joinMeta } from '../format.js';
import { formatCompactTokens } from '../../lib/token-usage.js';
import { STRENGTH_LABEL } from '../../lib/model-effort.js';
import { batchReason } from './call-model.js';

/* 批次: the batches of a day of 为你定制, newest first, one line each (when, how many cards it was asked for, what was written and kept, what it used), and below
   them, in a strip of fixed height, the three settings in force today. A batch that wrote nothing says why in its own words (the console puts the code into words). */

const STATE = { ok: 'done', failed: 'fail', skipped: 'queued', running: 'run' };
const STATUS_WORD = { ok: '已完成', failed: '失败', skipped: '已跳过', running: '进行中' };

export default function CoachBatches({ contract }) {
  const { batches = [], limits } = contract.detail;
  const list = [...batches].reverse();
  return (
    <div className="tc-files">
      <div className="tc-scroll">
        {list.map((batch) => {
          const used = batch.tokens ? batch.tokens.input + batch.tokens.output + batch.tokens.cache : 0;
          return (
            <div className="tc-batch" key={batch.id} data-batch={batch.id} data-status={batch.status}>
              <span className="tc-dot" data-state={STATE[batch.status] || 'run'} aria-hidden="true" />
              <span className="tc-batch__time">{formatDateTime(batch.startedAt, 'time')}</span>
              <span className="tc-batch__text">{joinMeta([batch.status === 'ok' ? uiFormat('写了 {0} 道，留下 {1} 道', [batch.generated, batch.passed])
                : batch.status === 'running' ? uiFormat('为 {0} 道题备变式', [batch.targets]) : batchReason(batch), used > 0 ? uiFormat('{0} tok', [formatCompactTokens(used)]) : ''])}</span>
              <span className="tc-num" data-state={STATE[batch.status] || 'run'}>{ui(STATUS_WORD[batch.status] || '已完成')}</span>
            </div>
          );
        })}
        {list.length === 0 && <p className="tc-empty">{ui('今天还没有备过题。')}</p>}
      </div>
      <div className="tc-strip">
        {limits
          ? <span className="tc-strip__line">{joinMeta([uiFormat('推理 {0}', [ui(STRENGTH_LABEL[limits.reasoning] || limits.reasoning)]), uiFormat('今天最多 {0} 批', [limits.maxBatchesPerDay]), uiFormat('备好的题最多 {0} 道', [limits.maxReady])])}</span>
          : <span className="tc-strip__hint">{ui('这是过去的一天，只留作记录。')}</span>}
      </div>
    </div>
  );
}
