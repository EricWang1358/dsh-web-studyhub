import React from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import PointBody from './PointBody.jsx';
import { UnplacedBody } from './BookChapter.jsx';
import { AskRow } from './BookAsk.jsx';

/* 逐节读 (复习全书, docs/review-book.md "Reading a point"): ONE knowledge point of the book, under its chapter and section path, with 上一个知识点 /
   下一个知识点 below it (with the neighbour's title; on the first point the first card is off). Where it is in the book and ‹ › are the book bar's (ui/book/BookBar.jsx); the ← / → keys do the
   same (ui/book/reading.js useStepKeys). The 目录 marks it. The printed code (H7) is not beside the heading: the 目录 shows it on hover and 复制编号 copies it.
   「✦ 问 AI」 sits at the right of the title (ui/book/BookAsk.jsx). */

const neighbour = step => (step ? `${step.node.number ? `${step.node.number} ` : ''}${step.node.title}` : '');

/** steps (ui/book/reading.js bookSteps), at: the index shown, onGo(index), course, handlers (ui/book/BookPage.jsx). */
export default function BookStep({ steps, at, onGo, course, handlers }) {
  const step = steps[at];
  if (!step) return null;
  const prev = steps[at - 1], next = steps[at + 1], node = step.node;
  return (
    <article className="book-step" data-book-step={step.hid} aria-labelledby={`book-${step.hid}`}>
      {step.path.length > 0 && <ol className="book-step__path" aria-label={ui('所在章节')}>
        {step.path.map(item => <li key={item.hid} className="book-step__crumb"><span className="book-node__number">{item.number}</span> {item.title}</li>)}
      </ol>}
      <AskRow onAsk={step.hid !== 'unplaced' && handlers.ask ? element => handlers.ask(node, element) : null}>
        <h2 id={`book-${step.hid}`} className="book-step__heading" data-book-heading={step.hid} tabIndex={-1}>
          {node.number && <span className="book-node__number">{node.number}</span>} {node.title}
        </h2>
      </AskRow>
      {step.hid === 'unplaced' ? <UnplacedBody node={node} handlers={handlers} /> : <PointBody node={node} course={course} handlers={handlers} level={3} />}
      {/* Named like the bar's ‹ › (知识点), one word for the unit the learner steps through. */}
      <nav className="book-step__nav" aria-label={ui('上一个与下一个知识点')}>
        <Button variant="secondary" wrap className="book-step__prev" disabled={!prev} onClick={() => onGo(at - 1)}>
          <span className="book-step__dir">{ui('上一个知识点')}</span>{prev && <span className="book-step__title">{neighbour(prev)}</span>}</Button>
        <Button variant="secondary" wrap className="book-step__next" disabled={!next} onClick={() => onGo(at + 1)}>
          <span className="book-step__dir">{ui('下一个知识点')}</span>{next && <span className="book-step__title">{neighbour(next)}</span>}</Button>
      </nav>
    </article>
  );
}
