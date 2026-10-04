import React, { useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button } from './components/index.js';
import css from './jev.css';

/* EXPERIMENTAL 题目认知层次对照, the developer panel: Jev's reading of a question's level next to the code's keyword heuristic that the 本轮小结
   uses. Counts of agreement and disagreement, the matrix, and the questions where they disagree. A cross-check only: nothing is changed or
   stored. It lives under Settings > Jev, once the experiment is switched on. */

const LEVELS = ['recall', 'concept', 'apply'];
const NAME = { recall: () => ui('记忆'), concept: () => ui('概念辨析'), apply: () => ui('应用分析') };

/** The panel's body. `result` is jev.levels.check (or null before the first run). */
export function JevLevelCheckView({ result, busy, onRun }) {
  useInjectCss(css, 'study-jev');
  const counts = result?.counts, disagreements = (result?.rows || []).filter(row => row.confident && !row.agree);
  return (
    <div className="jev-levels" data-jev-levels>
      <p className="audio-provider-note">{ui('只是对照：用 Jev 判断题目属于记忆、概念辨析还是应用分析，与「本轮小结」用的关键词判断比一比。不会改动任何题目或学习记录。')}</p>
      <div className="jev-field__actions"><Button variant="secondary" busy={busy} disabled={busy} onClick={onRun}>{ui('对照最多 30 道题')}</Button></div>
      {result?.unavailable && <p className="jev-levels__note">{uiMessage(result.unavailable.message)}</p>}
      {counts?.total > 0 && <>
        <p className="jev-levels__counts"><strong>{uiFormat('一致 {0}', [counts.agree])}</strong> · <strong>{uiFormat('不一致 {0}', [counts.disagree])}</strong> · {uiFormat('把握不足 {0}', [counts.unsure])} <small>{uiFormat('共 {0} 道', [counts.total])}</small></p>
        <table className="jev-levels__matrix"><caption className="sh-visually-hidden">{ui('代码判断（行）与 Jev 判断（列）')}</caption>
          <thead><tr><th scope="col">{ui('代码 ＼ Jev')}</th>{LEVELS.map(level => <th key={level} scope="col">{NAME[level]()}</th>)}</tr></thead>
          <tbody>{LEVELS.map(level => <tr key={level}><th scope="row">{NAME[level]()}</th>{LEVELS.map(other => <td key={other} className={level === other ? 'is-diagonal' : undefined}>{result.matrix?.[level]?.[other] || 0}</td>)}</tr>)}</tbody></table>
        {disagreements.length > 0 && <ul className="jev-levels__list">{disagreements.slice(0, 12).map(row => <li key={row.id}><span>{row.prompt}</span>
          <small>{uiFormat('代码：{0} · Jev：{1}（{2}%）', [NAME[row.heuristic](), NAME[row.jev](), Math.round(row.probability * 100)])}</small></li>)}</ul>}
      </>}
    </div>
  );
}

/** Connected: asks `jev.levels.check` for the library's questions. */
export default function JevLevelCheck({ call }) {
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError('');
    try { setResult(await call('jev.levels.check', { limit: 30 })); } catch (failure) { setError(String(failure?.message || failure)); } finally { setBusy(false); }
  };
  return <>
    <JevLevelCheckView result={result} busy={busy} onRun={run} />
    {error && <p className="jev-levels__note">{uiMessage(error)}</p>}
  </>;
}
