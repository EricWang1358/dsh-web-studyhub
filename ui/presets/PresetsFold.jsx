import React from 'react';
import { ui } from '../i18n.js';
import { HelpTip, SegmentedControl } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { depthLabel } from './depth-label.js';
import { depthNote, depthTip } from './depth-copy.js';
import { costLoading, costTip, costWords, matrixWords } from './cost-words.js';
import css from './presets-fold.css';

/* The parts of 出题方式 that wait for their own chunk (ui/presets/Presets.jsx has the presets of the main path): 出题深度 beside the 覆盖强度 in 更多选项, the
   matrix of the rough cost of every cell, and the line of rough costs beside the presets. 创建题组 loads this file on its own (deferredView), after the first
   screen, so the workspace's first load does not carry it (tests/workspace-closure-pages.test.mjs). It reaches nothing in lib/: the form hands it the depths,
   the columns and the costs, so loading it apart splits none of the first load's chunks (that test's count of waves). */

/** 出题深度 in 更多选项 (`depths`: lib/contexts/generation/presets.js DEPTHS; `offReason`: why it does nothing for these question types), with the matrix under it
    once there is something to price (`costs`: ui/presets/cost.js cellCosts of every cell, or null; `cell`: the form's; `columns`: ui/presets/copy.js matrixColumns). */
export default function PresetsFold({ depth, depths, applies, offReason, disabled = false, onDepth, costs, cell, columns }) {
  const matrix = costs ? matrixWords(costs, cell, { columns, depths }) : null;
  return <>
    <DepthChoice depth={depth} depths={depths} applies={applies} offReason={offReason} disabled={disabled} onDepth={onDepth} />
    {matrix && <CostMatrix matrix={matrix} />}
  </>;
}

/** 出题深度 in 更多选项: the depth alone, what it does, and why it does nothing for other question types. */
export function DepthChoice({ depth, depths, applies, offReason, disabled = false, onDepth }) {
  useInjectCss(css, 'study-presets-fold');
  return <div className="presets-depth" data-depth={applies ? depth : 'off'}>
    <span className="presets-depth__choice">
      <SegmentedControl label={ui('出题深度')} value={applies ? depth : ''} disabled={disabled || !applies}
        options={depths.map(value => ({ value, label: depthLabel(value) }))} onChange={onDepth} />
      <HelpTip label={ui('出题深度是什么')}>{depthTip()}</HelpTip>
    </span>
    <p className="generate-note" data-depth-note>{applies ? depthNote(depth) : offReason}</p>
  </div>;
}

/** 「大致花费 ⓘ 快问 约 ×0.3（26–33 题） · 情境题 ×1 · 逐题精出 约 ×0.7（28 题）」 (情境题 chosen) beside the presets: `items` { label, cost, current } a preset
    each, `lead` the words the main path already shows before them; nothing when the default cell could not be estimated. */
export function CostLine({ items, lead }) {
  const ready = items.every(item => item.cost?.ready), base = items.find(item => item.cost?.base)?.cost;
  if (ready && !(base?.ratio > 0)) return null;
  return <p className="generate-note presets__cost" data-preset-cost data-status={ready ? 'ready' : 'loading'}>
    <span className="presets__cost-lead">{lead}</span>
    <HelpTip label={ui('大致花费是怎么算的')}>{costTip()}</HelpTip>
    <span className="presets__cost-items">{ready ? items.map(costWords).join(' · ') : costLoading()}</span>
  </p>;
}

/** The matrix in 更多选项: a row per depth, a column per 覆盖强度, each cell its rough cost and questions; the form's own cell is marked. Read only: the two
    controls above choose. */
export function CostMatrix({ matrix }) {
  useInjectCss(css, 'study-presets-fold');
  return <div className="presets-matrix-wrap"><table className="presets-matrix" data-preset-matrix data-status={matrix.ready ? 'ready' : 'loading'}>
    <caption><span className="presets-matrix__caption"><span>{matrix.caption}</span><HelpTip label={ui('大致花费是怎么算的')}>{matrix.tip}</HelpTip></span></caption>
    <thead><tr><th scope="col"><span className="sh-visually-hidden">{ui('出题深度')}</span></th>{matrix.columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
    <tbody>{matrix.rows.map(row => <tr key={row.key}><th scope="row">{row.label}</th>{row.cells.map(cell =>
      <td key={cell.key} data-cell={cell.key} data-current={cell.current ? 'true' : undefined}>
        {/* While asked: a mark the width of a figure, 正在估算 said to a screen reader only (in each of nine narrow cells it would push the table past 320 px). */}
        {!cell.ready ? <><span className="presets-matrix__ratio" aria-hidden="true">…</span><span className="sh-visually-hidden">{matrix.loading}</span></> :
          <span className="presets-matrix__ratio">{cell.ratio}</span>}
        <small>{cell.questions}</small>
        {cell.current && <span className="sh-visually-hidden">{ui('（当前）')}</span>}
      </td>)}</tr>)}</tbody>
  </table></div>;
}
