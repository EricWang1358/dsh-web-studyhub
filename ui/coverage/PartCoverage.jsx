import React from 'react';
import { Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { joinMeta } from '../format.js';
import css from './coverage.css';
import { neverPlannedText, plannedFailedText, rangeCoverageText } from './copy.js';

/** What the range of one part of a run has, under its name in 资料部分: a small bar and 「覆盖 3/8 小节」. `range` is lib/coverage.js coverageInRange's answer. */
export function PartCoverage({ range, units, recorded = true }) {
  useInjectCss(css, 'study-coverage');
  if (!range?.leaves) return null;
  const covered = range.covered / range.leaves * 100, failed = range.plannedFailed / range.leaves * 100;
  const full = joinMeta([rangeCoverageText(range, units), range.plannedFailed > 0 && plannedFailedText(range.plannedFailed), range.neverPlanned > 0 && neverPlannedText(range.neverPlanned, recorded)]);
  return <Tooltip layer content={full} placement="bottom-start">
    <span className="tc-cover" data-part-coverage aria-label={full}>
      <span className="cov-meter__bar" aria-hidden="true"><i style={{ width: `${covered}%` }} />{failed > 0 && <i style={{ width: `${failed}%` }} />}</span>
      <span>{rangeCoverageText(range, units)}</span>
    </span>
  </Tooltip>;
}
