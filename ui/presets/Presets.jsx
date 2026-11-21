import React from 'react';
import { ui } from '../i18n.js';
import { SegmentedControl } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { deferredView } from '../deferred-view.jsx';
import { PRESETS, presetOf } from '../../lib/contexts/generation/presets.js';
import { cellKey, PRESET_CELLS } from './cost.js';
import { costLead, customNote, depthOffReason, presetLabel, presetNote } from './copy.js';
import css from './presets.css';

/* 出题方式 on the 创建题组 form (lib/contexts/generation/presets.js): the three presets of the main path (the depth and the matrix of 更多选项 are
   ui/presets/PresetsFold.jsx, loaded after the first screen). Every rough cost is read from the token estimate of the chosen materials (ui/presets/cost.js); with
   nothing to estimate there is none. `cell` is the form's { density, depth, count }; `applies` whether the depth means anything for the chosen question types
   (depthApplies); `costs` key → { ratio, coverage, base, ready } (cellCosts), or null when nothing is estimated. */

/* The line of rough costs is drawn by the chunk of 更多选项 (its words are mostly the hover card's, ui/presets/cost-words.js): the costs take an estimate per
   preset to arrive, and until the chunk is there the line holds its place with its lead, so nothing under it moves. */
const CostLine = deferredView(() => import('./PresetsFold.jsx').then(module => ({ default: module.CostLine })), { loading: () => <CostLead /> });
const CostLead = () => <p className="generate-note presets__cost" data-preset-cost data-status="loading"><span className="presets__cost-lead">{costLead()}</span></p>;

/** The main path: the three presets, what the chosen one does (or the combination it is, 自定义), and their rough costs. */
export function PresetPicker({ cell, applies, costs, disabled = false, onPick }) {
  useInjectCss(css, 'study-presets');
  const preset = presetOf(cell);
  return <div className="presets" data-presets data-preset={applies ? preset ?? 'custom' : 'off'}>
    <SegmentedControl label={ui('出题方式')} className="presets__choice" value={applies ? preset ?? '' : ''} disabled={disabled || !applies}
      options={PRESETS.map(({ id }) => ({ value: id, label: presetLabel(id) }))} onChange={onPick} />
    <p className="generate-note" data-preset-note>{!applies ? depthOffReason() : preset ? presetNote(preset) : customNote(cell)}</p>
    {applies && costs && <CostLine lead={costLead()}
      items={PRESET_CELLS.map(item => ({ label: presetLabel(presetOf(item)), cost: costs.get(cellKey(item)), current: cellKey(item) === cellKey(cell) }))} />}
  </div>;
}
