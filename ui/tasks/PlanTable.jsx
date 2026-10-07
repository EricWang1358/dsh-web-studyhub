import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useApp } from '../app/app-context.js';
import { taskKindOf } from './task-model.js';
import { taskKindLabel } from './task-summary.js';
import { taskMaterial } from './task-material.js';
import { FILTERS, filterCounts, goalLines, groupShort, groupTitle, narrowTable, planCount, planTable, pointWhy, pointWhyLong, sourceText, stateMeaning, stateWord } from './plan-table.js';
import css from './plan-table.css';

/* 目标与知识点: the third tab of the left panel of a question run (ui/tasks/TaskBody.jsx). The goal of the task in a few lines, then a table of the knowledge points the planning stage
   listed (ui/tasks/plan-table.js reads them from the contract; they cost no extra model call), one row each, grouped by batch with a header that sticks, a filter and a search. Every
   state, the group header and the reasons explain themselves in a Tooltip. A row opens its material at the quote by the app's own opener (learn.openSourceAt), when the material is still in the library. */

const EXPLAIN = '这是 AI 在规划阶段为本次任务列出的知识点；不会额外花 token。';
const TONE = { pending: 'neutral', authoring: 'info', 'awaiting-review': 'info', reviewing: 'info', repairing: 'info', passed: 'success', failed: 'error', stopped: 'neutral' };

/** The tab of the strip: the full label (a short one where the strip is narrow), the count when it is known, and what the list is on hover and focus. */
export function planTabItem(contract) {
  const count = planCount(contract), full = ui('目标与知识点'), label = count === '' ? full : `${full} ${count}`;
  return { value: 'plan', ariaLabel: label, tooltip: ui(EXPLAIN), attrs: { 'data-plan-tab': '', ...(full.length > 8 ? { 'data-long': '' } : {}) },
    content: <><span className="sh-tab__label"><span className="tc-tab__full">{full}</span><span className="tc-tab__short" aria-hidden="true">{ui('目标')}</span>{count === '' ? '' : <> <span className="tc-tab__count">{count}</span></>}</span></> };
}

const sameRow = (a, b) => a.canOpen === b.canOpen && a.row.state === b.row.state && a.row.reason === b.row.reason && a.row.objective === b.row.objective && a.row.part === b.row.part
  && a.row.at === b.row.at && a.row.source?.sourceId === b.row.source?.sourceId && a.row.source?.title === b.row.source?.title && a.row.source?.page === b.row.source?.page && a.onOpen === b.onOpen;

/** One point: its batch, the point, its source and its state. Memoised on what it shows, so a poll that changes one row draws one row. */
const PointRow = memo(function PointRow({ row, canOpen, onOpen }) {
  const from = sourceText(row.source), word = stateWord(row.state), why = row.state === 'failed' || row.state === 'stopped' ? pointWhy(row.reason) : '';
  return (
    <div role="row" className="tc-plan__row" data-point={row.key} data-state={row.state || undefined}>
      <span role="cell" className="tc-plan__part tc-num">{row.part}</span>
      <span role="cell" className="tc-plan__what">
        {row.objective.length > 48 ? <Tooltip layer content={row.objective} anchorClassName="tc-plan__what"><span className="tc-plan__text" tabIndex={0}>{row.objective}</span></Tooltip> : <span className="tc-plan__text">{row.objective}</span>}
      </span>
      <span role="cell" className="tc-plan__from">
        {from && canOpen ? <Button variant="quiet" size="sm" className="tc-plan__open" data-plan-open onClick={() => onOpen(row.source.sourceId, row.at)}>{from}</Button> : from}
      </span>
      <span role="cell" className="tc-plan__state">
        {word && <Tooltip layer content={stateMeaning(row.state)} placement="bottom-end"><Badge tone={TONE[row.state]} size="sm" className="tc-plan__badge" tabIndex={0} data-plan-state={row.state}>{word}</Badge></Tooltip>}
        {why && <Tooltip layer content={pointWhyLong(row.reason)} placement="bottom-end"><span className="tc-plan__why" tabIndex={0}>{why}</span></Tooltip>}
      </span>
    </div>
  );
}, sameRow);

export default function PlanTable({ contract, task }) {
  useInjectCss(css, 'study-plan-table');
  const app = useApp(), learn = app?.learn, sources = app?.data?.sources;
  // Where the strip of tabs scrolls sideways (a narrow column), the tab that was just picked is brought into view.
  const root = useRef(null);
  useEffect(() => {
    const tab = root.current?.closest('.tc-col')?.querySelector('[data-plan-tab]'), strip = tab?.closest('.tc-tabs');
    if (!strip) return;
    const box = tab.getBoundingClientRect(), edge = strip.getBoundingClientRect();
    if (box.right > edge.right) strip.scrollLeft += box.right - edge.right; else if (box.left < edge.left) strip.scrollLeft -= edge.left - box.left;
  }, []);
  const table = useMemo(() => planTable(contract), [contract]);
  const [filter, setFilter] = useState('all'), [query, setQuery] = useState('');
  const groups = useMemo(() => narrowTable(table, { filter, query }), [table, filter, query]);
  const counts = useMemo(() => filterCounts(table), [table]);
  const material = useMemo(() => taskMaterial(task, sources)?.title || '', [task, sources]);
  const lines = useMemo(() => goalLines(contract, { material, kindLabel: taskKindLabel(taskKindOf(task)), table }), [contract, material, task, table]);
  const known = useMemo(() => new Set((Array.isArray(sources) ? sources : []).map((source) => source.id)), [sources]);
  const here = (id) => !Array.isArray(sources) || known.has(id);
  const open = learn?.openSourceAt, openTop = learn?.openAudioSources;
  const onOpen = useCallback((sourceId, at) => { if (Number.isInteger(at) && typeof open === 'function') open(sourceId, at); else if (typeof openTop === 'function') openTop([sourceId]); }, [open, openTop]);
  const canOpen = typeof open === 'function' || typeof openTop === 'function';
  const listed = table.groups.length > 0, total = table.points + table.more;
  return (
    <div className="tc-plan" data-plan ref={root}>
      <div className="tc-plan__goal" aria-label={ui('这次任务的目标')}>
        <p className="tc-plan__title">
          <Tooltip layer content={ui(EXPLAIN)}><span className="tc-plan__anchor" tabIndex={0}>{ui('目标与知识点')}</span></Tooltip>
          {total > 0 && <small>{uiFormat('{0} 个考点', [total])}</small>}
        </p>
        {lines.map((line) => <p key={line.key} data-goal={line.key}>{line.text}</p>)}
      </div>
      {!listed && (
        <p className="tc-plan__wait" data-plan-wait={table.planning ? 'planning' : 'none'}>
          {table.planning ? ui('规划还在进行，考点清单出来后会列在这里。') : ui('这个任务没有记录考点清单（它可能是在有这项记录之前运行的）。')}
        </p>
      )}
      {listed && (
        <div className="tc-plan__bar">
          <div className="tc-filters" role="group" aria-label={ui('考点筛选')}>
            {FILTERS.map(([id, label]) => <Button key={id} size="sm" className="tc-filter" aria-pressed={filter === id} onClick={() => setFilter(id)}>{`${ui(label)} ${counts[id]}`}</Button>)}
          </div>
          <input type="search" className="tc-plan__search" value={query} placeholder={ui('搜索考点')} aria-label={ui('搜索考点')} autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        </div>
      )}
      {listed && (
        <div className="tc-plan__list" role="table" aria-label={ui('这次任务的考点')} aria-rowcount={counts.all}>
          <div role="row" className="tc-plan__cols">
            <span role="columnheader">{ui('批次')}</span><span role="columnheader">{ui('知识点')}</span><span role="columnheader">{ui('来自')}</span><span role="columnheader">{ui('状态')}</span>
          </div>
          {groups.length === 0 && <p className="tc-empty" role="row">{ui('没有符合的考点。')}</p>}
          {groups.map((group) => (
            <div role="rowgroup" key={group.key} data-group={group.key}>
              <div role="row" className="tc-plan__group">
                <Tooltip layer content={ui('一批是交给模型的一次出题工作，同一批的考点一起写、一起审阅。这一批失败时，它的考点会一起没通过。')}><span tabIndex={0}>{groupTitle(group)}</span></Tooltip>
                {group.range && <small>{group.range}</small>}
                {groupShort(group) && <Tooltip layer content={ui('规划这一批时，模型给出的考点比需要的少，缺的考点不会出题。补题时会再规划。')}><small data-short tabIndex={0}>{groupShort(group)}</small></Tooltip>}
              </div>
              {group.rows.map((row) => <PointRow key={row.key} row={row} canOpen={canOpen && !!row.source && here(row.source.sourceId)} onOpen={onOpen} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
