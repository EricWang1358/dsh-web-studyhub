import React, { Fragment, memo } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, Tooltip } from '../components/index.js';
import { codeOf } from '../../lib/course-book-lookup.js';
import { fillParts, templateParts } from './exam-kit-model.js';
import css from './book-kit.css';

/* 答题模板 of the review book (#710 S4): the exam answer kit the build made from the sample papers (lib/course-book-exam-kit.js examKitView), in two parts.
   按题型的答题模板: a card per question type T01…, what it really tests, its trigger words, the template with its [slots] marked, the fill of each past question
   (paper and number; the question's own words in a Tooltip) and the points it tests. 题干信号矩阵: a row per type, trigger words → what is tested → template →
   points → past papers. A point code opens the book there; a template code goes to its card. Generated, never edited here. */

function Code({ hid, onGo }) {
  return <Button variant="link" size="sm" className="book-kit__code" data-book-code={hid} onClick={() => onGo(hid)}>{codeOf(hid)}</Button>;
}
const Codes = ({ hids, onGo }) => hids.map(hid => <Code key={hid} hid={hid} onGo={onGo} />);

function Template({ text }) {
  return <p className="book-kit__template">{templateParts(text).map((part, at) => (part.slot ? <mark key={at} className="book-kit__slot">{part.text}</mark>
    : <Fragment key={at}>{part.text}</Fragment>))}</p>;
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

function Card({ type, onGo }) {
  return (
    <article className="book-kit__type" id={`book-kit-${type.code}`} data-kit-type={type.code}>
      <h3 className="book-kit__label"><span className="book-kit__tcode">{type.code}</span> {type.name}</h3>
      {type.asks && <p className="book-kit__asks">{type.asks}</p>}
      {type.signals.length > 0 && <p className="book-kit__muted">{uiFormat('题干信号：{0}', [type.signals.join(' · ')])}</p>}
      <Template text={type.template} />
      {type.fills.length > 0 && <>
        <h4 className="book-kit__head">{ui('每道真题的填法')}</h4>
        <ul className="book-kit__fills">{type.fills.map(fill => <Fill key={fill.ref} fill={fill} />)}</ul>
      </>}
      {type.hids.length > 0 && <p className="book-kit__where">{ui('知识点')} <Codes hids={type.hids} onGo={onGo} /></p>}
    </article>
  );
}

/** The card of `code` in the middle of the dialog. */
const jump = code => document.getElementById(`book-kit-${code}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

/** A cell of the matrix: its content in one box, so on a narrow screen the column's name (data-head, drawn by book-kit.css) stands beside it. Empty: nothing. */
const Cell = ({ head, children }) => <td data-head={head}>{children ? <span className="book-kit__cell">{children}</span> : null}</td>;

/** One row per type; on a narrow screen each row is a small block of name-value lines. */
function Matrix({ types, onGo }) {
  const heads = [ui('题干原词'), ui('考查本质与切入点'), ui('模板'), ui('知识点'), ui('真题')];
  return (
    <div className="book-kit__scroll">
      <table className="book-kit__matrix">
        <thead><tr>{heads.map(head => <th key={head} scope="col">{head}</th>)}</tr></thead>
        <tbody>{types.map(type => <tr key={type.code} className="book-kit__row">
          <Cell head={heads[0]}>{type.signals.join(' · ')}</Cell>
          <Cell head={heads[1]}>{type.asks}</Cell>
          <Cell head={heads[2]}><Button variant="link" size="sm" className="book-kit__code" data-kit-jump={type.code} onClick={() => jump(type.code)}>{type.code}</Button></Cell>
          <Cell head={heads[3]}>{type.hids.length > 0 && <Codes hids={type.hids} onGo={onGo} />}</Cell>
          <Cell head={heads[4]}>{type.anchors.join(' · ')}</Cell>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

/** kit: course.book.open's `examKit`; onGo(hid) opens the book at that point. */
export default memo(function BookExamKit({ kit, onGo }) {
  useInjectCss(css, 'study-book-kit');
  return (
    <div className="book-kit">
      <p className="book-kit__muted">{ui('由样卷题目整理：每种题型一个答题模板，和每道真题怎么填。知识点代码打开讲它的那一节。')}</p>
      <section className="book-kit__part" aria-labelledby="book-kit-types">
        <h2 id="book-kit-types" className="book-kit__title">{ui('按题型的答题模板')}</h2>
        {kit.types.map(type => <Card key={type.code} type={type} onGo={onGo} />)}
      </section>
      <section className="book-kit__part" aria-labelledby="book-kit-matrix">
        <h2 id="book-kit-matrix" className="book-kit__title">{ui('题干信号矩阵')}</h2>
        <Matrix types={kit.types} onGo={onGo} />
      </section>
    </div>
  );
});
