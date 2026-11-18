import React, { memo, useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button } from '../components/index.js';
import { maskConceptNames } from './confusable-drill.js';
import css from './book-confusables.css';

/* 易混概念 of the review book (#710 S3): for each pair of term cards the book calls opposite or parallel (lib/course-book-confusables.js confusablesView), a
   comparison under the two names: what each is, when to use it, the key difference, the common mistake. A card's number is a link that goes to that card
   (`onCard(hid, code)`, else opens its point). On a narrow screen each row is a small block, each cell under its name. Generated, never edited here.
   When `drill` is enabled (`settings.book.confusableDrill`), learners can toggle 「对照自测」 to mask headers, `data-head`, and in-cell concept names before revealing. */

const aspectLabel = aspect => ({ what: ui('是什么'), when: ui('什么时候用'), difference: ui('关键区别'), mistake: ui('常见误区') })[aspect] ?? aspect;
const maskedLabel = at => (at === 0 ? ui('概念 A') : at === 1 ? ui('概念 B') : uiFormat('概念 {0}', [at + 1]));

function CardLink({ code, hid, onGo, onCard }) {
  return <Button variant="link" size="sm" className="book-conf__code" data-term-link={code} onClick={() => (onCard && hid ? onCard(hid, code) : hid && onGo(hid))}>{code}</Button>;
}

/** confusables: lookup.confusables, [{ id, items: [K code, K code], names, rows: [{ aspect, cells }], hids }]; onGo(hid) opens the book at a point. */
export default memo(function BookConfusables({ confusables, drill = false, onGo, onCard }) {
  useInjectCss(css, 'study-book-confusables');
  const [quizOn, setQuizOn] = useState(false);
  const [revealed, setRevealed] = useState(() => new Set());
  useEffect(() => {
    setQuizOn(false);
    setRevealed(new Set());
  }, [confusables, drill]);
  const togglePair = id => setRevealed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleDrill = () => {
    setQuizOn(value => !value);
    setRevealed(new Set());
  };
  return (
    <div className="book-conf">
      <div className={drill && confusables.length > 0 ? 'book-conf__bar' : undefined}>
        <p className="book-conf__muted">{ui('术语卡里对立或并列的概念，一对一对比较；点编号去那张术语卡。')}</p>
        {drill && confusables.length > 0 && (
          <Button size="sm" variant="secondary" wrap className="book-conf__toggle" aria-pressed={quizOn} onClick={toggleDrill}>
            {quizOn ? ui('退出对照自测') : ui('对照自测')}
          </Button>
        )}
      </div>
      {confusables.map(each => {
        const isMasked = drill && quizOn && !revealed.has(each.id);
        const shownNames = each.names.map((name, at) => (isMasked ? maskedLabel(at) : name));
        return <article key={each.id} className="book-conf__pair" data-confusable={each.id} data-confusable-masked={isMasked ? '' : undefined}>
          <h3 className="book-conf__head">
            <span className="book-conf__id">{each.id}</span>
            {isMasked ? <span className="book-conf__cue">{ui('先按下方线索分辨这两个概念')}</span>
              : each.names.map((name, at) => <React.Fragment key={each.items[at]}>
                {at > 0 && <span className="book-conf__vs" aria-hidden="true">·</span>}
                <span className="book-conf__name">{name}</span> <CardLink code={each.items[at]} hid={each.hids?.[at]} onGo={onGo} onCard={onCard} />
              </React.Fragment>)}
            {drill && quizOn && (
              <Button size="sm" variant="quiet" wrap className="book-conf__toggle" onClick={() => togglePair(each.id)}>
                {isMasked ? ui('揭晓名称') : ui('重新遮住')}
              </Button>
            )}
          </h3>
          <table className="book-conf__table">
            <thead><tr><td aria-hidden="true" />{each.items.map((item, at) => <th key={item} scope="col">{shownNames[at]}</th>)}</tr></thead>
            <tbody>{each.rows.map(row => <tr key={row.aspect} className="book-conf__row" data-aspect={row.aspect}>
              <th scope="row">{aspectLabel(row.aspect)}</th>
              {row.cells.map((cell, at) => <td key={at} data-head={shownNames[at]}>{isMasked ? maskConceptNames(cell, each.names) : cell}</td>)}
            </tr>)}</tbody>
          </table>
        </article>;
      })}
    </div>
  );
});
