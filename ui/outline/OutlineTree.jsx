import React, { memo, useCallback, useId, useMemo, useState } from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Checkbox, Icon, LoadingState } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { LEVEL_LABEL, plainPrompt } from '../shared.js';
import { MasteryLine } from '../document-preview/practice/MasteryMark.jsx';
import { cardTicked, outlineKey } from './model.js';
import { displayTitle } from '../../lib/document-title.js';
import LeafNotes from './LeafNotes.jsx';
import { moreText, numberText, otherText, practiceLabel, reasonText, rowTitle, tierText, unfiledText } from './words.js';

/* The outline as a disclosure list (the repository's pattern, as ui/exam-prep/PointTree.jsx): one flat list in reading order, a document opens
   its chapters, a chapter (or a document without chapters, or 未归位) opens its questions. The row buttons are one tab stop: the arrow keys,
   Home and End walk the rows, Right and Left open and close, Enter and Space toggle. A row's checkbox picks all its questions; a question's
   checkbox picks it alone (a question already in a picked row shows ticked). */

const LEVEL_TONE = { weak: 'error', learning: 'warning', familiar: 'info', mastered: 'success', new: 'neutral' };

function Questions({ data, holders, pick, onPickCard }) {
  if (data === undefined) return <LoadingState className="outline-questions__state" label={ui('正在读取题目…')} />;
  if (!data?.cards?.length) return <p className="outline-questions__none">{ui('这里还没有题。')}</p>;
  return (
    <ul className="outline-questions">
      {data.cards.map(ref => {
        const byRow = holders.some(key => pick.keys.has(key));
        return (
          <li key={`${ref.deckId}|${ref.cardId}`} className="outline-q" data-card={ref.cardId}>
            <Checkbox className="outline-q__pick" label={plainPrompt(ref.prompt)} hint={ref.reason ? `${ref.deckTitle} · ${reasonText(ref.reason)}` : ref.deckTitle}
              checked={cardTicked(pick, ref, holders)} disabled={byRow} onChange={on => onPickCard(ref, on)} />
            <span className="outline-q__badges">
              <Badge size="sm" tone={LEVEL_TONE[ref.level] || 'neutral'}>{LEVEL_LABEL[ref.level] || LEVEL_LABEL.new}</Badge>
              {ref.due && <Badge size="sm" tone="warning">{ui('到期')}</Badge>}
              {ref.shared && <Badge size="sm">{ui('也列在别处')}</Badge>}
            </span>
          </li>
        );
      })}
      {data.more > 0 && <li className="outline-questions__more">{moreText(data.more)}</li>}
    </ul>
  );
}

const Row = memo(function Row({ row, data, tabStop, bodyId, pick, papers, onPick, onPickCard, onPractice, onOpenSources, onOpenSource }) {
  const { busy } = useStudy();
  const { node } = row, title = rowTitle(row);
  // Every row above this one on screen holds its questions too (an AI outline nests up to five rows deep).
  const above = row.ancestors || (row.parentKey ? [row.parentKey] : []), holders = [row.key, ...above];
  const inPickedRow = above.some(key => pick.keys.has(key));
  return (
    <li className="outline-row" data-level={row.level} data-kind={row.kind} data-key={row.key} data-depth={row.kind === 'chapter' && !row.ancestors ? Math.min(3, node.level || 1) : undefined}>
      <div className="outline-row__line">
        <Checkbox className="outline-row__pick" label={<span className="sh-visually-hidden">{title}</span>} checked={pick.keys.has(row.key) || inPickedRow}
          disabled={!node.total || inPickedRow} onChange={on => onPick(row.key, on)} />
        <Button variant="quiet" size="sm" wrap className="outline-row__toggle" data-outline-toggle={row.key} tabIndex={tabStop ? 0 : -1} aria-expanded={row.expanded}
          aria-controls={row.hasChildren ? undefined : bodyId}>
          <Icon name="caret" size={14} className="outline-row__caret" />
          {row.number && <span className="outline-row__number">{numberText(row)}</span>}
          <span className="outline-row__title">{title}</span>
        </Button>
        {papers > 0 && node.tier && <Badge size="sm" tone={node.tier === 'must' ? 'warning' : 'neutral'} className="outline-row__tier">{tierText(node, papers)}</Badge>}
        <MasteryLine className="outline-row__mastery" summary={node.summary} title={title} />
        {node.total > 0 && <Button size="sm" variant="secondary" icon="play" className="outline-row__practice" disabled={busy} onClick={() => onPractice(row)}>{practiceLabel(node.resume)}</Button>}
      </div>
      {node.intro && (row.kind === 'part' || row.kind === 'section' || row.kind === 'point') && <p className="outline-row__intro">{node.intro}</p>}
      {row.kind === 'point' && row.expanded && data?.notes && <LeafNotes notes={data.notes} onOpenSource={onOpenSource} />}
      {row.kind === 'other' && node.anchors > 0 && <p className="outline-row__hint"><span>{otherText(node.anchors)}</span></p>}
      {row.kind === 'unplaced' && node.materials?.length > 0 && <p className="outline-row__hint">
        <span>{unfiledText(node.materials.map(material => displayTitle(material.title)), node.materialCount)}</span>
        {onOpenSources && <Button variant="link" size="sm" onClick={onOpenSources}>{ui('去资料页归入课程')}</Button>}
      </p>}
      {!row.hasChildren && <div id={bodyId} className="outline-row__body" hidden={!row.expanded}>
        {row.expanded && <Questions data={data} holders={holders} pick={pick} onPickCard={onPickCard} />}
      </div>}
    </li>
  );
});

/** `rows`: ./model.js outlineRows; `details`: the opened rows' answers; `papers`: the sample papers an AI outline rests on (0: no tier is shown);
    onToggle(key, open), onPick(key, on), onPickCard(ref, on), onPractice(row), onOpenSources() (the 资料 page), onOpenSource(sourceId, quote) (a 角标 of a point's notes). */
export default function OutlineTree({ rows, details, pick, papers = 0, onToggle, onPick, onPickCard, onPractice, onOpenSources, onOpenSource, label }) {
  const [active, setActive] = useState(null);
  const listId = useId();
  const stop = useMemo(() => (rows.some(row => row.key === active) ? active : rows[0]?.key), [rows, active]);
  const keyOf = event => event.target.closest?.('[data-outline-toggle]')?.getAttribute('data-outline-toggle') ?? null;
  const onClick = useCallback(event => {
    const key = keyOf(event);
    if (key === null) return;
    const row = rows.find(item => item.key === key);
    if (row) onToggle(key, !row.expanded);
    setActive(key);
  }, [rows, onToggle]);
  const onKeyDown = event => {
    const key = keyOf(event);
    if (key === null || event.key === 'Enter' || event.key === ' ') return;
    const result = outlineKey(rows, key, event.key);
    if (!result) return;
    event.preventDefault();
    if (result.focus !== undefined) {
      setActive(result.focus);
      [...event.currentTarget.querySelectorAll('[data-outline-toggle]')].find(button => button.getAttribute('data-outline-toggle') === result.focus)?.focus();
    } else if (result.toggle !== undefined) onToggle(result.toggle, result.open);
  };
  return (
    <ul className={rows.some(row => row.ancestors) ? 'outline-tree outline-tree--book' : 'outline-tree'} aria-label={label} onClick={onClick} onKeyDown={onKeyDown}>
      {rows.map((row, index) => <Row key={row.key} row={row} data={details[row.key]} tabStop={row.key === stop} bodyId={`${listId}-${index}`}
        pick={pick} papers={papers} onPick={onPick} onPickCard={onPickCard} onPractice={onPractice} onOpenSources={onOpenSources} onOpenSource={onOpenSource} />)}
    </ul>
  );
}
