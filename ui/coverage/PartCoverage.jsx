import React from 'react';
import { Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { joinMeta } from '../format.js';
import css from './coverage.css';
import { neverPlannedText, plannedFailedText, rangeCoverageText, rangePendingText, scheduledText } from './copy.js';

/** What the range of one part of a run has, under its name in 资料部分: a small bar and 「覆盖 3/8 小节」. `range` is lib/coverage.js coverageInRange's answer.
    `pending`: the batch has not reported yet (it is waiting or being written): sections only count as covered once its questions are saved, so a range with nothing covered says that instead of 「覆盖 0/10 小节」. */
export function PartCoverage({ range, units, recorded = true, pending = false }) {
  useInjectCss(css, 'study-coverage');
  if (!range?.leaves) return null;
  const covered = range.covered / range.leaves * 100, failed = range.plannedFailed / range.leaves * 100;
  const later = Math.min(range.scheduled || 0, range.neverPlanned || 0);
  const said = pending && range.covered === 0 ? rangePendingText(range, units) : rangeCoverageText(range, units);
  const full = joinMeta([said, range.plannedFailed > 0 && plannedFailedText(range.plannedFailed), later > 0 && scheduledText(later),
    range.neverPlanned - later > 0 && neverPlannedText(range.neverPlanned - later, recorded)]);
  return <Tooltip layer content={full} placement="bottom-start">
    <span className="tc-cover" data-part-coverage aria-label={full}>
      <span className="cov-meter__bar" aria-hidden="true"><i style={{ width: `${covered}%` }} />{failed > 0 && <i style={{ width: `${failed}%` }} />}</span>
      <span>{said}</span>
    </span>
  </Tooltip>;
}
