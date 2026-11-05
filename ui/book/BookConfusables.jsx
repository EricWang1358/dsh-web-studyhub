import React, { memo } from 'react';
import { ui } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button } from '../components/index.js';
import css from './book-confusables.css';

/* 易混概念 of the review book (#710 S3): for each pair of term cards the book calls opposite or parallel (lib/course-book-confusables.js confusablesView), a
   comparison under the two names: what each is, when to use it, the key difference, the common mistake. A card's number is a link that goes to that card
   (`onCard(hid, code)`, else opens its point). On a narrow screen each row is a small block, each cell under its name. Generated, never edited here. */

const aspectLabel = aspect => ({ what: ui('是什么'), when: ui('什么时候用'), difference: ui('关键区别'), mistake: ui('常见误区') })[aspect] ?? aspect;

function CardLink({ code, hid, onGo, onCard }) {
  return <Button variant="link" size="sm" className="book-conf__code" data-term-link={code} onClick={() => (onCard && hid ? onCard(hid, code) : hid && onGo(hid))}>{code}</Button>;
}

/** confusables: lookup.confusables, [{ id, items: [K code, K code], names, rows: [{ aspect, cells }], hids }]; onGo(hid) opens the book at a point. */
export default memo(function BookConfusables({ confusables, onGo, onCard }) {
  useInjectCss(css, 'study-book-confusables');
  return (
    <div className="book-conf">
      <p className="book-conf__muted">{ui('术语卡里对立或并列的概念，一对一对比较；点编号去那张术语卡。')}</p>
      {confusables.map(each => <article key={each.id} className="book-conf__pair" data-confusable={each.id}>
        <h3 className="book-conf__head">
          <span className="book-conf__id">{each.id}</span>
          {each.names.map((name, at) => <React.Fragment key={each.items[at]}>
            {at > 0 && <span className="book-conf__vs" aria-hidden="true">·</span>}
            <span className="book-conf__name">{name}</span> <CardLink code={each.items[at]} hid={each.hids?.[at]} onGo={onGo} onCard={onCard} />
          </React.Fragment>)}
        </h3>
        <table className="book-conf__table">
          <thead><tr><td aria-hidden="true" />{each.names.map((name, at) => <th key={each.items[at]} scope="col">{name}</th>)}</tr></thead>
          <tbody>{each.rows.map(row => <tr key={row.aspect} className="book-conf__row" data-aspect={row.aspect}>
            <th scope="row">{aspectLabel(row.aspect)}</th>
            {row.cells.map((cell, at) => <td key={at} data-head={each.names[at]}>{cell}</td>)}
          </tr>)}</tbody>
        </table>
      </article>)}
    </div>
  );
});
