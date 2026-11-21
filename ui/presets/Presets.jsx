import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { HelpTip, SegmentedControl } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { PRESETS, presetOf } from '../../lib/generation-presets.js';
import { cellKey, PRESET_CELLS } from './cost.js';
import { costLead, costLoading, costTip, customNote, depthOffReason, presetLabel, presetNote, questionsText, ratioText } from './copy.js';
import css from './presets.css';

/* 出题方式 on the 创建题组 form (lib/generation-presets.js): the three presets of the main path (the depth and the matrix of 更多选项 are ui/presets/PresetsFold.jsx,
   loaded after the first screen). Every rough cost is read from the token estimate of the chosen materials (ui/presets/cost.js); with nothing to estimate there is none.
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
