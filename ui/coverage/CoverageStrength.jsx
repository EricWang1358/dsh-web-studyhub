import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Chip, Disclosure, SegmentedControl } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { TokenEstimateView } from '../TokenUsage.jsx';
import css from './coverage.css';
import { COUNT_MAX, COUNT_MIN, COUNT_PRESETS, COVERAGE_LEVELS, budgetNote, clampCount, coverageLead, customCountOf, levelNote, levelsLine, suggestCount } from '../generate-form.js';
import { parseTokenBudget } from '../../lib/coverage-run.js';
import { autoCompleteOf } from '../../lib/coverage-strength.js';
import { autoLabel, autoLine, tokensText } from './copy.js';

/* 覆盖强度 on the 创建题组 form (phase 3 of docs/plans/coverage-generation): the choice of how completely the chosen materials are covered (精简 / 标准 / 完整), what it means in words, and, BEFORE the run,
   what it means for exactly these materials in one plain line: 「标准：约 343 道题，覆盖 81/81 个部分，分 12 轮，预计 2.10M–2.96M tok · 285–896 次模型调用」. The line is the answer of `usage.estimate`
   for the request the form sends (lib/token-estimate.js: the plan of lib/coverage-plan.js priced from the real prompts), so the number the learner reads is the number the run is planned with.
   A number of questions is for people who want one: it hides under 「自定义题数」, and what does not fit in one round of 30 becomes rounds.
   A plan of several rounds is a choice too: 「自动补到完整」 (the rounds go on one after another by themselves, or the learner presses 补题 for each; default per level: lib/coverage-strength.js) and, hidden
   under 「花费上限」, how many tokens the run may use before it stops at a round boundary. */

/**
 * `level` / `customCount` are the form's (`gen.coverageLevel`, `gen.customCount`); `state` is the estimate of the request (ui/TokenUsage.jsx useUsageEstimate); `stats` the selection's
 * size (ui/generate-form.js selectionStats), for the number the custom field starts from; `enabled` is whether anything is selected.
 * `compact`: the consequences (the plan, the count, the estimate, whether the rounds go on by themselves) are said once by the form around it, under the button: draw only the choices.
 */
export default function CoverageStrength({ level, customCount = '', onLevel, onCustom, auto = autoCompleteOf(level), onAuto, budget = '', onBudget, state = { status: 'idle' }, stats, enabled = true, disabled = false, compact = false }) {
  useInjectCss(css, 'study-coverage');
  const coverage = state.status === 'ready' ? state.estimate?.coverage : null, custom = customCountOf({ customCount });
  const hint = suggestCount(stats, level), rounds = coverage?.rounds ?? 0, spend = parseTokenBudget(budget);
  return <div className="cov-strength" data-coverage-strength data-level={level}>
    <SegmentedControl label={ui('覆盖强度')} className="cov-strength__levels" value={level} disabled={disabled}
      options={COVERAGE_LEVELS.map(({ value, label }) => ({ value, label }))} onChange={onLevel} />
    <p className="generate-note" data-coverage-level-note>{levelNote(level)}</p>
    {enabled && !compact && <div className="cov-strength__line" data-coverage-consequence>
      <TokenEstimateView state={state} lead={coverageLead(coverage)} tight />
      {coverage && !custom && <p className="cov-strength__levels-line" data-coverage-levels>{levelsLine(coverage)}</p>}
    </div>}
    {enabled && compact && coverage && !custom && <p className="cov-strength__levels-line" data-coverage-levels>{levelsLine(coverage)}</p>}
    {onAuto && <div className="cov-strength__auto" data-coverage-auto data-auto={auto ? 'on' : 'off'}>
      <Checkbox label={autoLabel()} checked={auto} disabled={disabled} onChange={onAuto} />
      {rounds > 1 && !compact && <p className="generate-note" data-coverage-auto-note>{autoLine(auto, rounds, coverage?.leaves > 0 && Number.isFinite(coverage.firstRoundSections) ? { level: coverage.level, percent: Math.round(coverage.firstRoundSections / coverage.leaves * 100) } : undefined)}</p>}
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
      <p className="generate-note" id="generate-count-note">{uiFormat('填了题数就按这个数出，题仍按所选覆盖强度的规则分到各个小节；超过 30 道的会分成几轮（每轮最多 30 题），最多 {0} 题。', [COUNT_MAX])}</p>
    </Disclosure>
    {onBudget && <Disclosure className="cov-strength__budget" summary={ui('花费上限')} meta={spend ? tokensText(spend) : ui('可选')} defaultOpen={String(budget).trim() !== ''}>
      <div className="generate-count cov-strength__count">
        <label className="cov-strength__unit" htmlFor="generate-budget">{ui('最多用')}</label>
        <input id="generate-budget" className="cov-strength__input cov-strength__input--budget" type="text" inputMode="text" autoComplete="off" value={budget} disabled={disabled} placeholder={ui('例如 2M')}
          aria-describedby="generate-budget-note" aria-invalid={String(budget).trim() !== '' && !spend ? 'true' : undefined} onChange={(event) => onBudget(event.target.value)} />
        <span className="cov-strength__unit">tok</span>
      </div>
      <p className="generate-note" id="generate-budget-note">{budgetNote(budget)}</p>
    </Disclosure>}
  </div>;
}
