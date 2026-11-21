import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { HelpTip, SegmentedControl } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { DENSITIES, DEPTHS, PRESETS, presetOf } from '../../lib/generation-presets.js';
import { levelLabel } from '../coverage/copy.js';
import { cellKey, PRESET_CELLS } from './cost.js';
import { costLead, costLoading, costTip, customNote, depthLabel, depthNote, depthOffReason, depthTip, presetLabel, presetNote, questionsText, ratioText } from './copy.js';
import css from './presets.css';

/* 出题方式 on the 创建题组 form (lib/generation-presets.js): the three presets of the main path, and in 更多选项 the depth beside the 覆盖强度 with the rough cost of every
   cell of the matrix. Every rough cost is read from the token estimate of the chosen materials (ui/presets/cost.js); with nothing to estimate there is none.
   `cell` is the form's { density, depth }; `applies` whether the depth means anything for the chosen question types (depthApplies); `costs` key → { ratio,
   coverage, base, ready } (cellCosts), or null when nothing is estimated. */

/** The main path: the three presets, what the chosen one does (or the combination it is, 自定义), and their rough costs. */
export function PresetPicker({ cell, applies, costs, disabled = false, onPick }) {
  useInjectCss(css, 'study-presets');
  const preset = presetOf(cell);
  return <div className="presets" data-presets data-preset={applies ? preset ?? 'custom' : 'off'}>
    <SegmentedControl label={ui('出题方式')} className="presets__choice" value={applies ? preset ?? '' : ''} disabled={disabled || !applies}
      options={PRESETS.map(({ id }) => ({ value: id, label: presetLabel(id) }))} onChange={onPick} />
    <p className="generate-note" data-preset-note>{!applies ? depthOffReason() : preset ? presetNote(preset) : customNote(cell)}</p>
    {applies && costs && <CostLine items={PRESET_CELLS.map(item => ({ label: presetLabel(presetOf(item)), cost: costs.get(cellKey(item)), current: cellKey(item) === cellKey(cell) }))} />}
  </div>;
}

// The form's own cell says no number of questions: the summary beside the button says it, once (one fact, one place).
const costWords = ({ label, cost, current }) => {
  const ratio = ratioText(cost.ratio, { base: cost.base }), questions = current ? '' : questionsText(cost.coverage);
  return `${label}${ratio ? ` ${ratio}` : ''}${questions ? uiFormat('（{0}）', [questions]) : ''}`;
};

/** 「大致花费 ⓘ 快问 约 ×0.3（26–33 题） · 情境题 ×1 · 逐题精出 约 ×0.7（28 题）」 (情境题 chosen); nothing when the default cell could not be estimated. */
function CostLine({ items }) {
  const ready = items.every(item => item.cost?.ready), base = items.find(item => item.cost?.base)?.cost;
  if (ready && !(base?.ratio > 0)) return null;
  return <p className="generate-note presets__cost" data-preset-cost data-status={ready ? 'ready' : 'loading'}>
    <span className="presets__cost-lead">{costLead()}</span>
    <HelpTip label={ui('大致花费是怎么算的')}>{costTip()}</HelpTip>
    <span className="presets__cost-items">{ready ? items.map(costWords).join(' · ') : costLoading()}</span>
  </p>;
}

/** 出题深度 in 更多选项: the depth alone, what it does, and why it does nothing for other question types. */
export function DepthChoice({ depth, applies, disabled = false, onDepth }) {
  useInjectCss(css, 'study-presets');
  return <div className="presets-depth" data-depth={applies ? depth : 'off'}>
    <span className="presets-depth__choice">
      <SegmentedControl label={ui('出题深度')} value={applies ? depth : ''} disabled={disabled || !applies}
        options={DEPTHS.map(value => ({ value, label: depthLabel(value) }))} onChange={onDepth} />
      <HelpTip label={ui('出题深度是什么')}>{depthTip()}</HelpTip>
    </span>
    <p className="generate-note" data-depth-note>{applies ? depthNote(depth) : depthOffReason()}</p>
  </div>;
}

/** The matrix in 更多选项: a row per depth, a column per 覆盖强度, each cell its rough cost and questions; the form's own cell is marked. Read only: the two controls above choose. */
export function CostMatrix({ cell, costs }) {
  useInjectCss(css, 'study-presets');
  const ready = [...costs.values()].every(cost => cost.ready), base = [...costs.values()].find(cost => cost.base);
  if (ready && !(base?.ratio > 0)) return null;
  return <table className="presets-matrix" data-preset-matrix data-status={ready ? 'ready' : 'loading'}>
    <caption><span className="presets-matrix__caption"><span>{ui('各组合的大致花费（相对「情境题」）')}</span><HelpTip label={ui('大致花费是怎么算的')}>{costTip()}</HelpTip></span></caption>
    <thead><tr><th scope="col"><span className="sh-visually-hidden">{ui('出题深度')}</span></th>{DENSITIES.map(density => <th scope="col" key={density}>{levelLabel(density)}</th>)}</tr></thead>
    <tbody>{DEPTHS.map(depth => <tr key={depth}><th scope="row">{depthLabel(depth)}</th>{DENSITIES.map((density) => {
      const cost = costs.get(cellKey({ density, depth })), current = cell.density === density && cell.depth === depth;
      return <td key={density} data-cell={cellKey({ density, depth })} data-current={current ? 'true' : undefined}>
        {/* While asked: a mark the width of a figure, 正在估算 said to a screen reader only (in each of nine narrow cells it would push the table past 320 px). */}
        {!cost?.ready ? <><span className="presets-matrix__ratio" aria-hidden="true">…</span><span className="sh-visually-hidden">{costLoading()}</span></> : <><span className="presets-matrix__ratio">{ratioText(cost.ratio, { base: cost.base, bare: true }) || '—'}</span>
          {!current && questionsText(cost.coverage) && <small>{questionsText(cost.coverage)}</small>}</>}
        {current && <span className="sh-visually-hidden">{ui('（当前）')}</span>}
      </td>;
    })}</tr>)}</tbody>
  </table>;
}
