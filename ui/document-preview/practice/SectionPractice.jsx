import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, InlineMessage, LoadingState, SegmentedControl } from '../../components/index.js';
import StudyInline from '../../StudyInline.jsx';
import { useStudy } from '../../study-context.jsx';
import { useInjectCss } from '../../shared.js';
import { QaList } from '../../book/BookQa.jsx';
import { cardKey, refsOf } from './practice-range.js';
import { rangeLabel } from './mastery-copy.js';
import { questionsOf, sectionRanges, shownRange } from './section-practice.js';
import { useSectionStats } from './useSectionStats.js';
import css from './section-practice.css';

/* 本节题目 of the reader (#1013): the questions of the section (or the chapter) on screen, at most 30, answered right here, beside the text, in an ordinary
   review run: started with the arguments of 做这几页的题 and shown by the embedder's `inline.Run` (ui/app/modals/ReaderRun.jsx, a compact practice
   session), so grading, scheduling, mastery and the wrong book are the practice page's. Nothing here moves the text: the reading position is only read
   (to keep it with the run), and closing the round brings the list back with the text where it was. Under the heading: 错题 n · 追问 n · 批注 n, each
   opening what already shows them (the 错题 panel, the 追问 kept on these questions, the 批注 in the text).

   Props: loop (practice/useReadingLoop), outline (the reader's, for the order of the text), title (the section on screen), chapterName, unit ('page' | 'slide' |
   'section'), inline ({ start(refs, reading, then), Run }), version (the library's revision), visible (the panel is on screen: only then is anything
   read), request ({ option, nonce }: 做这几页的题 › 在这里做), onWrong(), onNotes(), onSeek(ref) -> boolean, onElsewhere(option) (the whole range on the
   practice page). */

/** The round's own label: 本节 · 3 题. */
const roundLabel = (option, count, unit) => `${rangeLabel(option, unit)} · ${count === 1 ? ui('1 题') : uiFormat('{0} 题', [count])}`;

function Stat({ count, label, onOpen, ...rest }) {
  const text = `${label} ${count}`;
  return count > 0 && onOpen ? <Button variant="link" size="sm" className="section-practice__stat" onClick={onOpen} {...rest}>{text}</Button>
    : <span className="section-practice__stat" data-empty={count > 0 ? undefined : 'true'}>{text}</span>;
}

export default function SectionPractice({ loop, outline, title, chapterName = '', unit = 'section', inline, version, visible, request, onWrong, onNotes, onSeek, onElsewhere }) {
  useInjectCss(css, 'study-section-practice');
  const { call, busy } = useStudy();
  const headingId = useId(), qaId = useId();
  const [choice, setChoice] = useState(null);
  // The round on screen: { started, option, label }; the list under it is the range it was started on, whatever the text shows meanwhile.
  const [active, setActive] = useState(null), [note, setNote] = useState('');
  const ranges = useMemo(() => sectionRanges(loop.options), [loop.options]);
  const option = active?.option ?? shownRange(ranges, choice);
  const order = useMemo(() => new Map(outline.map((item, at) => [item.id, at])), [outline]);
  const listed = useMemo(() => questionsOf(option, { entryOf: loop.entryOf, order }), [option, loop.entryOf, order]);
  const stats = useSectionStats({ call, enabled: visible && loop.status === 'ready' && !active, version, allCards: loop.cards, cards: listed.cards, ids: option?.ids ?? null, noteAssigned: loop.noteAssigned });
  const [qaOpen, setQaOpen] = useState(false);
  const lastRow = useRef('');

  const start = (card, from = option) => {
    const shown = from === option ? listed.shown : questionsOf(from, { entryOf: loop.entryOf, order }).shown;
    if (!inline || !shown.length || busy) return;
    setNote('');
    lastRow.current = card ? cardKey(card) : '';
    const label = roundLabel(from, shown.length, unit);
    // The reading context of 做这几页的题 (where the learner is, read, not changed); a question clicked in the list is the one the round opens at.
    Promise.resolve(inline.start(refsOf(shown), loop.start(from).reading, async started => {
      let run = started;
      const at = card ? (run.navigation || []).findIndex(stop => stop.deckId === card.deckId && stop.cardId === card.cardId && !stop.answered && !stop.retry) : -1;
      if (at >= 0 && at !== run.index) run = await call('review.move', { runId: run.id, cardId: run.card?.id, queueVersion: run.queueVersion || 0, index: at });
      setActive({ started: run, option: from, label });
    })).then(result => { if (!result) setNote(ui('没能开始这一轮，稍后再试一次。')); });
  };
  // 做这几页的题 › 在这里做: the range chosen there, started here.
  useEffect(() => { if (request?.option) start(null, request.option); }, [request?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    setActive(null);
    // Back to the list, at the question the round was opened from.
    requestAnimationFrame(() => document.querySelector(`[data-section-card="${CSS.escape(lastRow.current)}"]`)?.focus?.({ preventScroll: true }));
  };

  const Run = inline?.Run;
  // Which part of the text the list is about: the section's title, or the chapter's name (the range itself is said by 本页 | 本章 above).
  const where = !option || active ? '' : option.kind === 'chapter' ? chapterName : title;
  return <section className="section-practice" aria-labelledby={headingId} data-tour="reader-section-practice">
    <div className="section-practice__head">
      <h3 id={headingId} className="reader-panel__title">{ui('本节题目')}</h3>
      {!active && ranges.length > 1 && <SegmentedControl size="xs" label={ui('题目范围')} value={option?.kind} onChange={setChoice}
        options={ranges.map(range => ({ value: range.kind, label: `${rangeLabel(range, unit)} ${range.cards.length}` }))} />}
    </div>
    {where && <p className="section-practice__where">{where}</p>}
    {!active && loop.status === 'ready' && option && <div className="section-practice__stats" data-testid="section-stats">
      <Stat count={stats.wrong} label={ui('错题')} onOpen={onWrong} />
      <span aria-hidden="true">·</span>
      {/* The 追问 open in the panel itself (a popover would be cut off by the panel's own scrolling). */}
      <Stat count={stats.followups} label={ui('追问')} onOpen={() => setQaOpen(open => !open)} aria-expanded={qaOpen} aria-controls={qaId} />
      <span aria-hidden="true">·</span>
      <Stat count={stats.notes} label={ui('批注')} onOpen={onNotes} />
    </div>}
    {!active && qaOpen && stats.followups > 0 && <div id={qaId} className="section-practice__qa-panel">
      <QaList items={stats.items} cardLabel={ui('在这里做这道题')}
        onCard={ref => { setQaOpen(false); const card = listed.cards.find(item => item.deckId === ref.deckId && item.cardId === ref.cardId); if (card) start(card); }} />
    </div>}
    {active && Run ? <Run started={active.started} label={active.label} onClose={close} onSeek={onSeek} shown={visible} />
      : loop.status === 'loading' ? <LoadingState inline label={ui('正在读取这几页的题…')} />
        : loop.status !== 'ready' ? <p className="section-practice__none" role="status">{ui('没能读取这几页的题。')}</p>
          : !listed.cards.length ? <p className="section-practice__none" role="status">{option?.kind === 'chapter' ? ui('这一章还没有题。') : ui('这一节还没有题。')}</p>
            : <>
              <ol className="section-practice__list">
                {listed.shown.map(card => <li key={cardKey(card)}>
                  <Button variant="quiet" size="sm" className="section-practice__row" data-section-card={cardKey(card)} disabled={!inline} lock={busy} onClick={() => start(card)}>
                    <span className={`map-dot lv-${card.level || 'new'}`} aria-hidden="true" /><StudyInline text={card.prompt} />
                  </Button>
                </li>)}
              </ol>
              {note && <InlineMessage tone="warning">{note}</InlineMessage>}
              <div className="section-practice__actions">
                {inline && <Button variant="primary" size="sm" icon="arrow-right" lock={busy} onClick={() => start(null)} data-usage="reader.section-practice">
                  {listed.shown.length === 1 ? ui('在这里做这 1 道题') : uiFormat('在这里做这 {0} 道题', [listed.shown.length])}</Button>}
                {onElsewhere && <Button variant="quiet" size="sm" lock={busy} onClick={() => onElsewhere(option)}>
                  {listed.rest > 0 ? uiFormat('还有 {0} 道，去练习页做全部', [listed.rest]) : ui('去练习页做')}</Button>}
              </div>
            </>}
  </section>;
}
