import React, { Fragment, memo, useEffect, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, Tooltip } from '../components/index.js';
import { codeOf } from '../../lib/course-book-lookup.js';
import { fillParts, templateParts } from './exam-kit-model.js';
import { bookRows } from './model.js';
import css from './book-kit.css';

/* 答题模板 of the review book (#710 S4 + 5.0.0 Evolution 2 #1): the exam answer kit the build made from the sample papers (lib/course-book-exam-kit.js examKitView),
   in two parts. 按题型的答题模板: a card per question type T01…, what it really tests, its trigger words, the template with its [slots] marked, the fill of each past
   question (paper and number; the question's own words in a Tooltip) and the points it tests. When `drill` is enabled (`settings.book.confusableDrill`), learners can
   toggle 「对照自测」 to mask `[slot]` placeholders (and fold fills) while keeping `signals` trigger words visible, and mark stuck templates back to `book.crunch.mark`. */

/** A point the kit links to, named by its row of the book (ui/book/model.js bookRows); a point the book no longer has: its code alone. */
function Point({ hid, row, onGo }) {
  return (
    <li className="book-kit__point">
      <Button variant="link" size="sm" wrap className="book-kit__code" data-book-code={hid} onClick={() => onGo(hid)}>
        {row && <><span className="book-kit__number">{row.number}</span> {row.title} </>}<span className="book-node__code">{codeOf(hid)}</span>
      </Button>
    </li>
  );
}
const Points = ({ hids, rows, onGo }) => <ul className="book-kit__points">{hids.map(hid => <Point key={hid} hid={hid} row={rows.get(hid)} onGo={onGo} />)}</ul>;

function Template({ text, masked = false, revealedSlots = null, onToggleSlot }) {
  let slotNo = 0;
  return <p className="book-kit__template">{templateParts(text).map((part, at) => {
    if (!part.slot) return <Fragment key={at}>{part.text}</Fragment>;
    const idx = slotNo++;
    const hidden = masked && !revealedSlots?.has(idx);
    if (hidden) {
      return <Button key={at} size="sm" variant="quiet" className="book-kit__slot book-kit__slot--masked" data-slot-masked={idx}
        onClick={() => onToggleSlot?.(idx)}>{uiFormat('槽位 {0}', [idx + 1])}</Button>;
    }
    return <mark key={at} className="book-kit__slot">{part.text}</mark>;
  })}</p>;
}

function Fill({ fill }) {
  return (
    <li className="book-kit__fill">
      <Tooltip layer content={fill.quote} anchorClassName="book-kit__ref"><span tabIndex={0}>{fill.ref}</span></Tooltip>
      <span className="book-kit__values">{fillParts(fill.fill).map((part, at) => <span key={at} className="book-kit__value">
        {part.slot && <span className="book-kit__name">{part.slot}</span>}{part.slot ? ' ' : ''}{part.value}</span>)}</span>
    </li>
  );
}

function Card({ type, rows, onGo, quizOn = false, cardRevealed = false, revealedSlots = null, onToggleCard, onRevealSlot, onMarkStuck, isStuck = false }) {
  const masked = quizOn && !cardRevealed;
  const anchorHid = type.hids?.find(Boolean) || '';
  return (
    <article className="book-kit__type" id={`book-kit-${type.code}`} data-kit-type={type.code} data-kit-masked={masked ? '' : undefined}>
      <div className="book-kit__head-row">
        <h3 className="book-kit__label"><span className="book-kit__tcode">{type.code}</span> {type.name}</h3>
        {quizOn && (
          <span className="book-kit__card-actions">
            <Button size="sm" variant="quiet" wrap onClick={() => onToggleCard?.(type.code)}>
              {masked ? ui('揭晓槽位') : ui('重新遮住')}
            </Button>
            {anchorHid && onMarkStuck && (
              <Button size="sm" variant="quiet" wrap aria-pressed={isStuck} data-kit-stuck={type.code} onClick={() => onMarkStuck(anchorHid, !isStuck)}>
                {isStuck ? ui('已记卡住') : ui('卡住了')}
              </Button>
            )}
          </span>
        )}
      </div>
      {type.asks && <p className="book-kit__asks">{type.asks}</p>}
      {type.signals.length > 0 && <p className="book-kit__muted">{uiFormat('题干信号：{0}', [type.signals.join(' · ')])}</p>}
      <Template text={type.template} masked={masked} revealedSlots={revealedSlots} onToggleSlot={idx => onRevealSlot?.(type.code, idx)} />
      {type.fills.length > 0 && !masked && <>
        <h4 className="book-kit__head">{ui('每道真题的填法')}</h4>
        <ul className="book-kit__fills">{type.fills.map((fill, at) => <Fill key={`${at}|${fill.ref}`} fill={fill} />)}</ul>
      </>}
      {type.hids.length > 0 && <div className="book-kit__where">
        <h4 className="book-kit__head">{ui('知识点')}</h4>
        <Points hids={type.hids} rows={rows} onGo={onGo} />
      </div>}
    </article>
  );
}

/** The card of `code` in the middle of the dialog. */
const jump = code => document.getElementById(`book-kit-${code}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

/** A cell of the matrix: its content in one box, so on a narrow screen the column's name (data-head, drawn by book-kit.css) stands beside it. Empty: nothing. */
const Cell = ({ head, children }) => <td data-head={head}>{children ? <span className="book-kit__cell">{children}</span> : null}</td>;

/** One row per type; on a narrow screen each row is a small block of name-value lines. */
function Matrix({ types, rows, onGo }) {
  const heads = [ui('题干原词'), ui('考查本质与切入点'), ui('模板'), ui('知识点'), ui('真题')];
  return (
    <div className="book-kit__scroll">
      <table className="book-kit__matrix">
        <thead><tr>{heads.map(head => <th key={head} scope="col">{head}</th>)}</tr></thead>
        <tbody>{types.map(type => <tr key={type.code} className="book-kit__row">
          <Cell head={heads[0]}>{type.signals.join(' · ')}</Cell>
          <Cell head={heads[1]}>{type.asks}</Cell>
          <Cell head={heads[2]}><Button variant="link" size="sm" className="book-kit__code" data-kit-jump={type.code} onClick={() => jump(type.code)}>{type.code}</Button></Cell>
          <Cell head={heads[3]}>{type.hids.length > 0 && <Points hids={type.hids} rows={rows} onGo={onGo} />}</Cell>
          <Cell head={heads[4]}>{type.anchors.join(' · ')}</Cell>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

/** book: what course.book.open gave the page (its `examKit` and the points, `nodes`, that name the kit's links); onGo(hid) opens the book at that point. */
export default memo(function BookExamKit({ book, drill = false, onGo, onMarkStuck, stuckHids = null }) {
  useInjectCss(css, 'study-book-kit');
  const kit = book.examKit;
  const rows = useMemo(() => new Map(bookRows(book.nodes).map(row => [row.hid, row])), [book.nodes]);
  const [quizOn, setQuizOn] = useState(false);
  const [revealedCards, setRevealedCards] = useState(() => new Set());
  const [revealedSlots, setRevealedSlots] = useState(() => new Map());
  useEffect(() => {
    setQuizOn(false);
    setRevealedCards(new Set());
    setRevealedSlots(new Map());
  }, [kit, drill]);
  const toggleDrill = () => {
    setQuizOn(value => !value);
    setRevealedCards(new Set());
    setRevealedSlots(new Map());
  };
  const toggleCard = code => {
    setRevealedCards(current => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setRevealedSlots(current => {
      if (!current.has(code)) return current;
      const next = new Map(current);
      next.delete(code);
      return next;
    });
  };
  const revealSlot = (code, idx) => {
    setRevealedSlots(current => {
      const next = new Map(current);
      const set = new Set(next.get(code) || []);
      set.add(idx);
      next.set(code, set);
      return next;
    });
  };
  return (
    <div className="book-kit">
      <div className={drill && kit.types.length > 0 ? 'book-kit__bar' : undefined}>
        <p className="book-kit__muted">{ui('由样卷题目整理：每种题型一个答题模板，和每道真题怎么填。点知识点打开讲它的那一节。')}</p>
        {drill && kit.types.length > 0 && (
          <Button size="sm" variant="secondary" wrap className="book-kit__toggle" aria-pressed={quizOn} onClick={toggleDrill}>
            {quizOn ? ui('退出对照自测') : ui('对照自测')}
          </Button>
        )}
      </div>
      <section className="book-kit__part" aria-labelledby="book-kit-types">
        <h2 id="book-kit-types" className="book-kit__title">{ui('按题型的答题模板')}</h2>
        {kit.types.map(type => {
          const anchorHid = type.hids?.find(Boolean) || '';
          return <Card key={type.code} type={type} rows={rows} onGo={onGo} quizOn={drill && quizOn}
            cardRevealed={revealedCards.has(type.code)} revealedSlots={revealedSlots.get(type.code) || null}
            onToggleCard={toggleCard} onRevealSlot={revealSlot} onMarkStuck={onMarkStuck}
            isStuck={Boolean(anchorHid && stuckHids?.has?.(anchorHid))} />;
        })}
      </section>
      <section className="book-kit__part" aria-labelledby="book-kit-matrix">
        <h2 id="book-kit-matrix" className="book-kit__title">{ui('题干信号矩阵')}</h2>
        <Matrix types={kit.types} rows={rows} onGo={onGo} />
      </section>
    </div>
  );
});
