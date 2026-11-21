import React from 'react';
import { ui } from '../i18n.js';
import { HelpTip, SegmentedControl } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { depthLabel } from './depth-label.js';
import { depthNote, depthTip } from './depth-copy.js';
import css from './presets-fold.css';

/* The part of 出题方式 that lives in 更多选项 (ui/presets/Presets.jsx has the presets of the main path): 出题深度 beside the 覆盖强度, and the matrix of the rough
   cost of every cell. 创建题组 loads this file on its own (deferredView), after the first screen: the fold is shut when the page opens, so the workspace's first
   load does not carry it (tests/workspace-closure-pages.test.mjs). It reaches nothing in lib/: the form hands it the depths and the matrix in words
   (ui/presets/copy.js matrixWords), so loading it apart splits none of the first load's chunks (that test's count of waves). */

/** 出题深度 in 更多选项 (`depths`: lib/generation-presets.js DEPTHS; `offReason`: why it does nothing for these question types), with the matrix under it once
    the costs are in (`matrix`: matrixWords, or null). */
export default function PresetsFold({ depth, depths, applies, offReason, disabled = false, onDepth, matrix }) {
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

/** The matrix in 更多选项: a row per depth, a column per 覆盖强度, each cell its rough cost and questions; the form's own cell is marked. Read only: the two
    controls above choose. */
export function CostMatrix({ matrix }) {
  useInjectCss(css, 'study-presets-fold');
  return <table className="presets-matrix" data-preset-matrix data-status={matrix.ready ? 'ready' : 'loading'}>
    <caption><span className="presets-matrix__caption"><span>{matrix.caption}</span><HelpTip label={ui('大致花费是怎么算的')}>{matrix.tip}</HelpTip></span></caption>
    <thead><tr><th scope="col"><span className="sh-visually-hidden">{ui('出题深度')}</span></th>{matrix.columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
    <tbody>{matrix.rows.map(row => <tr key={row.key}><th scope="row">{row.label}</th>{row.cells.map(cell =>
      <td key={cell.key} data-cell={cell.key} data-current={cell.current ? 'true' : undefined}>
        {/* While asked: a mark the width of a figure, 正在估算 said to a screen reader only (in each of nine narrow cells it would push the table past 320 px). */}
        {!cell.ready ? <><span className="presets-matrix__ratio" aria-hidden="true">…</span><span className="sh-visually-hidden">{matrix.loading}</span></> : <>
          <span className="presets-matrix__ratio">{cell.ratio}</span>{cell.questions && <small>{cell.questions}</small>}</>}
        {cell.current && <span className="sh-visually-hidden">{ui('（当前）')}</span>}
      </td>)}</tr>)}</tbody>
  </table>;
}
