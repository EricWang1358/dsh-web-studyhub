import React, { memo, useCallback, useId, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Icon } from '../components/index.js';
import { cx } from '../components/css.js';
import Explain from './Explain.jsx';
import { lacksSlides, placesOf, treeKey, treeRows } from './model.js';
import { backingLine, tierWords } from './words.js';

/* The exam points as a two-level list: a big point opens its small points, any point opens the places it came from (quotes with 看原页).
   A disclosure list, not an ARIA tree: a row also holds a badge and buttons the keyboard must reach, so it is the repository's disclosure
   pattern (a button with aria-expanded) plus the tree's arrow keys on the row buttons (one tab stop for all of them; ./model.js treeKey).
   The rows are one flat list in reading order, the small points indented, so a long list is one list and a closed point costs one row. */

const placeLabel = place => place.kind === 'paper' ? ui('样卷') : place.page ? uiFormat('课件 第 {0} 页', [place.page]) : ui('课件');

function Places({ point, onOpenSource }) {
  const places = placesOf(point);
  if (!places.length) return null;
  return (
    <ul className="exam-prep-places">
      {places.map((place, index) => (
        <li key={`${place.sourceId}:${index}`} className="exam-prep-place" data-kind={place.kind}>
          <span className="exam-prep-place__where">{placeLabel(place)}</span>
          <q className="exam-prep-place__quote">{place.quote}</q>
          <Explain k={place.kind === 'paper' ? 'peek.paper' : 'peek'}>
            <Button variant="quiet" size="sm" icon="external" data-usage="examprep.peek" onClick={() => onOpenSource(place.sourceId, place.quote)}>
              {place.kind === 'paper' ? ui('看原题') : ui('看原页')}
            </Button>
          </Explain>
        </li>
      ))}
    </ul>
  );
}

const Row = memo(function Row({ node, level, open, tabStop, basis, onOpenSource, bodyId }) {
  const point = node.point, flagged = lacksSlides(point);
  return (
    <li className={cx('exam-prep-point', level > 1 && 'is-sub')} data-point={node.id} data-tier={node.tier}>
      <div className="exam-prep-point__line">
        <Button variant="quiet" size="sm" wrap className="exam-prep-point__toggle" data-point-toggle={node.id} tabIndex={tabStop ? 0 : -1} aria-expanded={open} aria-controls={bodyId}>
          <Icon name="caret" size={14} className="exam-prep-point__caret" />
          <span className="exam-prep-point__title">{point.title}</span>
          {point.requirement && <span className="exam-prep-point__requirement">{point.requirement}</span>}
        </Button>
        <span className="exam-prep-point__marks">
          <Explain k={`tier.${node.tier}`} focusable>
            <Badge size="sm" tone={node.tier === 'must' ? 'accent' : 'neutral'}>{tierWords(node.tier, point, basis)}</Badge>
          </Explain>
          {flagged && <Explain k="noSlides" focusable><Badge size="sm" tone="warning" icon="warning">{ui('课件里没找到对应内容')}</Badge></Explain>}
        </span>
        <span className="exam-prep-point__backing">{backingLine(point)}</span>
      </div>
      <div id={bodyId} className="exam-prep-point__body" hidden={!open}>
        {open && <Places point={point} onOpenSource={onOpenSource} />}
      </div>
    </li>
  );
});

/**
 * `roots`: the (filtered) roots of ./model.js buildTree. `basis`: what the list rests on (its sample-paper count is the total of 样卷考过（N/M 份）). `forceOpen` opens every big point (a search is on); `initialOpen` lists the points open at first. The row buttons are one tab stop:
 * the arrow keys, Home and End walk the rows on screen, Right and Left open and close, Enter and Space toggle (the button's own click).
 */
export default function PointTree({ roots, basis = null, forceOpen = false, initialOpen = [], onOpenSource, label }) {
  const [openIds, setOpenIds] = useState(() => new Set(initialOpen));
  const [active, setActive] = useState(null);
  const listId = useId();
  const open = useMemo(() => forceOpen ? new Set([...openIds, ...roots.filter(node => node.children.length).map(node => node.id)]) : openIds, [forceOpen, openIds, roots]);
  const rows = useMemo(() => treeRows(roots, open), [roots, open]);
  const stop = rows.some(row => row.id === active) ? active : rows[0]?.id;
  const set = useCallback((id, value) => setOpenIds(current => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; }), []);
  const idOf = event => event.target.closest?.('[data-point-toggle]')?.getAttribute('data-point-toggle') ?? null;
  const onClick = event => {
    const id = idOf(event);
    if (id === null) return;
    // A big point that a search holds open stays open: the click only moves the focus.
    if (!(forceOpen && roots.some(node => node.id === id && node.children.length))) set(id, !open.has(id));
    setActive(id);
  };
  const onKeyDown = event => {
    const id = idOf(event);
    if (id === null || event.key === 'Enter' || event.key === ' ') return;
    const result = treeKey(rows, id, event.key, open);
    if (!result) return;
    event.preventDefault();
    if (result.focus !== undefined) {
      setActive(result.focus);
      [...event.currentTarget.querySelectorAll('[data-point-toggle]')].find(button => button.getAttribute('data-point-toggle') === result.focus)?.focus();
    } else if (result.toggle !== undefined && !forceOpen) set(result.toggle, result.open);
  };
  return (
    <ul className="exam-prep-tree" aria-label={label} onClick={onClick} onKeyDown={onKeyDown}>
      {rows.map(row => <Row key={row.id} node={row.node} level={row.level} open={!!(row.hasChildren ? row.expanded : open.has(row.id))}
        tabStop={row.id === stop} basis={basis} onOpenSource={onOpenSource} bodyId={`${listId}-${row.id}`} />)}
    </ul>
  );
}
