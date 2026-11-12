import React, { useEffect, useMemo, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, LoadingState, Popover } from '../../components/index.js';
import StudyInline from '../../StudyInline.jsx';
import { useInjectCss } from '../../shared.js';
import { useLiveEffect } from '../../use-async.js';
import { statusLabel, statusOf } from '../../wrongbook-model.js';
import { cardKey } from '../practice/practice-range.js';
import { SHOWN_MAX } from '../practice/section-practice.js';
import { wrongRowsOf } from './wrong-rows.js';
import css from './reader-slim.css';

/* 错题 of the reader: the questions of this material that are still wrong or still to be consolidated (the rows of the 错题与待巩固 page, call 'wrongbook', so
   the two never disagree), the current chapter's first and then the rest of the book. Each row goes to practice (去练, the reader's own way: the run comes
   back to this place) or to the passage it asks about (看原文). The list is read when the panel opens; nothing is stored. */

export { SHOWN_MAX };

function Rows({ rows, onPractice, onSeek }) {
  return <ul className="reader-wrong__list">
    {rows.slice(0, SHOWN_MAX).map(row => <li key={row.key} className="reader-wrong__row">
      <p className="reader-wrong__prompt"><span className="reader-wrong__status">{statusLabel(statusOf(row.item))}</span><StudyInline text={row.item.prompt} /></p>
      <span className="reader-wrong__actions">
        <Button size="sm" variant="secondary" icon="arrow-right" onClick={() => onPractice(row)}>{ui('去练')}</Button>
        <Button size="sm" variant="quiet" disabled={!row.entryId} onClick={() => onSeek(row)}>{ui('看原文')}</Button>
      </span>
    </li>)}
    {rows.length > SHOWN_MAX && <li className="reader-wrong__more">{uiFormat('还有 {0} 道，在「错题与待巩固」里看', [rows.length - SHOWN_MAX])}</li>}
  </ul>;
}

/** The body, mounted when the panel opens: reads the list, then lists the rows that belong to this material. */
function WrongBody({ read, cards, entryOf, drawn, chapterTitle, onPractice, onSeek }) {
  const [state, setState] = useState({ status: 'loading', items: [] }), [again, setAgain] = useState(0);
  const keys = useMemo(() => new Set(cards.map(cardKey)), [cards]);
  useLiveEffect(live => {
    setState({ status: 'loading', items: [] });
    read(keys).then(items => { if (live()) setState({ status: 'ready', items }); },
      () => { if (live()) setState({ status: 'error', items: [] }); });
  }, [read, keys, again]);
  const rows = useMemo(() => wrongRowsOf({ items: state.items, cards, entryOf, drawn }), [state.items, cards, entryOf, drawn]);
  if (state.status === 'loading') return <LoadingState label={ui('正在读取错题…')} />;
  if (state.status === 'error') return <div className="reader-wrong__empty" role="alert"><p>{ui('没能读取错题。')}</p><Button size="sm" onClick={() => setAgain(count => count + 1)}>{ui('重试')}</Button></div>;
  if (!rows.total) return <p className="reader-wrong__empty" role="status">{ui('这份资料里没有待巩固的题。')}</p>;
  return <div className="reader-wrong__body">
    {rows.here.length > 0 && <section>{drawn && <h4 className="reader-wrong__heading">{chapterTitle || ui('这一章')}<small>{rows.here.length}</small></h4>}
      <Rows rows={rows.here} onPractice={onPractice} onSeek={onSeek} /></section>}
    {rows.rest.length > 0 && <section><h4 className="reader-wrong__heading">{ui('书的其余部分')}<small>{rows.rest.length}</small></h4>
      <Rows rows={rows.rest} onPractice={onPractice} onSeek={onSeek} /></section>}
  </div>;
}

/**
 * The 错题 button of the toolbar and its panel. read(keys): reads the 错题 rows of those `deckId|cardId` keys (readWrongBook with the reader's call); cards: the questions linked to this material (practice/useReadingLoop `cards`);
 * entryOf(key): the outline entry a question is placed in; drawn: the ids of the entries of the chapter that is drawn (null: the material has no chapters);
 * onPractice(row), onSeek(row): what the two buttons of a row do (the panel closes after either); openRequest: true asks for the panel to open (错题 n of
 * the 本节题目 line, #1013), once: onOpenRequested() is called as it opens.
 */
export default function WrongPanel({ read, cards, entryOf, drawn, chapterTitle, onPractice, onSeek, openRequest = false, onOpenRequested }) {
  useInjectCss(css, 'study-reader-slim');
  const [open, setOpen] = useState(false);
  useEffect(() => { if (openRequest) { setOpen(true); onOpenRequested?.(); } }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps -- once per request
  const done = action => row => { setOpen(false); action(row); };
  return <Popover open={open} onOpenChange={setOpen} label={ui('错题')} className="reader-popover reader-wrong" panelClassName="reader-popover__panel reader-wrong__panel"
    boundsSelector=".study-document-viewer" flip={false} data-tour="reader-wrong"
    trigger={({ props, ref }) => <Button ref={ref} size="sm" variant="quiet" icon="nav-wrongbook" iconClassName="reader-toolbar__word-icon" className="reader-toolbar__action" {...props}>{ui('错题')}</Button>}>
    <WrongBody read={read} cards={cards} entryOf={entryOf} drawn={drawn} chapterTitle={chapterTitle} onPractice={done(onPractice)} onSeek={done(onSeek)} />
  </Popover>;
}
