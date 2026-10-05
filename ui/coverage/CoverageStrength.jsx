import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Chip, Disclosure, SegmentedControl } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { TokenEstimateView } from '../TokenUsage.jsx';
import css from './coverage.css';
import { COUNT_MAX, COUNT_MIN, COUNT_PRESETS, COVERAGE_LEVELS, clampCount, coverageLead, customCountOf, levelNote, levelsLine, suggestCount } from '../generate-form.js';

/* 覆盖强度 on the 创建题组 form (phase 3 of docs/plans/coverage-generation): the choice of how completely the chosen materials are covered (精简 / 标准 / 完整), what it means in words, and, BEFORE the run,
   what it means for exactly these materials in one plain line: 「标准：约 343 道题，覆盖 81/81 个部分，分 12 轮，预计 2.10M–2.96M tok · 285–896 次模型调用」. The line is the answer of `usage.estimate`
   for the request the form sends (lib/token-estimate.js: the plan of lib/coverage-plan.js priced from the real prompts), so the number the learner reads is the number the run is planned with.
   A number of questions is for people who want one: it hides under 「自定义题数」, and what does not fit in one round of 30 becomes rounds. */

/**
 * `level` / `customCount` are the form's (`gen.coverageLevel`, `gen.customCount`); `state` is the estimate of the request (ui/TokenUsage.jsx useUsageEstimate); `stats` the selection's
 * size (ui/generate-form.js selectionStats), for the number the custom field starts from; `enabled` is whether anything is selected.
 */
export default function CoverageStrength({ level, customCount = '', onLevel, onCustom, state = { status: 'idle' }, stats, enabled = true, disabled = false }) {
  useInjectCss(css, 'study-coverage');
  const coverage = state.status === 'ready' ? state.estimate?.coverage : null, custom = customCountOf({ customCount });
  const hint = suggestCount(stats, level);
  return <div className="cov-strength" data-coverage-strength data-level={level}>
    <SegmentedControl label={ui('覆盖强度')} className="cov-strength__levels" value={level} disabled={disabled}
      options={COVERAGE_LEVELS.map(({ value, label }) => ({ value, label }))} onChange={onLevel} />
    <p className="generate-note" data-coverage-level-note>{levelNote(level)}</p>
    {enabled && <div className="cov-strength__line" data-coverage-consequence>
      <TokenEstimateView state={state} lead={coverageLead(coverage)} tight />
      {coverage && !custom && <p className="cov-strength__levels-line" data-coverage-levels>{levelsLine(coverage)}</p>}
    </div>}
    <Disclosure className="cov-strength__custom" summary={ui('自定义题数')} meta={custom ? uiFormat('{0} 题', [custom]) : ui('可选')} defaultOpen={String(customCount).trim() !== ''}>
      <div className="generate-count cov-strength__count">
        <input id="generate-count" className="cov-strength__input" type="number" min={COUNT_MIN} max={COUNT_MAX} inputMode="numeric" value={customCount} disabled={disabled}
          placeholder={hint ? uiFormat('例如 {0}', [hint]) : ''} aria-describedby="generate-count-note"
          onChange={(event) => onCustom(event.target.value)} onBlur={(event) => { if (event.target.value.trim() !== '') onCustom(String(clampCount(event.target.value))); }} />
        <div className="generate-presets" role="group" aria-label={ui('常用题数')}>
          {COUNT_PRESETS.map((preset) => <Chip key={preset} className="generate-preset" selected={custom === preset} onClick={() => onCustom(String(preset))}>{preset}</Chip>)}
        </div>
        {String(customCount).trim() !== '' && <Button variant="link" size="sm" onClick={() => onCustom('')}>{ui('改回按覆盖强度')}</Button>}
      </div>
      <p className="generate-note" id="generate-count-note">{uiFormat('填了题数就按这个数出，题仍按所选覆盖强度的规则分到各个部分；超过 30 道的会分成几轮（每轮最多 30 题），最多 {0} 题。', [COUNT_MAX])}</p>
    </Disclosure>
  </div>;
}
