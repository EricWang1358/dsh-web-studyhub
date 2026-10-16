import React from 'react';
import { ui } from '../i18n.js';
import PointBody from './PointBody.jsx';
import { UnplacedBody } from './BookChapter.jsx';

/* 逐节读 (复习全书, docs/review-book.md "Reading a point"): ONE knowledge point of the book, under its chapter and section path. It ends in its one end button
   (ui/book/PointEnd.jsx, inside the point); where it is and ‹ › are the book bar's (ui/book/BookBar.jsx), and the ← / → keys do the same (ui/book/reading.js
   useStepKeys), all by one order (ui/book/route.js). The 目录 marks it. The printed code (H7) is not beside the heading: the 目录 shows it on hover and 复制编号
   copies it. */

/** steps (ui/book/reading.js bookSteps), at: the index shown, course, handlers (ui/book/BookPage.jsx). */
export default function BookStep({ steps, at, course, handlers }) {
  const step = steps[at];
  if (!step) return null;
  const node = step.node;
  return (
    <article className="book-step" data-book-step={step.hid} aria-labelledby={`book-${step.hid}`}>
      {step.path.length > 0 && <ol className="book-step__path" aria-label={ui('所在章节')}>
        {step.path.map(item => <li key={item.hid} className="book-step__crumb"><span className="book-node__number">{item.number}</span> {item.title}</li>)}
      </ol>}
      <h2 id={`book-${step.hid}`} className="book-step__heading" data-book-heading={step.hid} tabIndex={-1}>
        {node.number && <span className="book-node__number">{node.number}</span>} {node.title}
      </h2>
      {step.hid === 'unplaced' ? <UnplacedBody node={node} handlers={handlers} /> : <PointBody node={node} course={course} handlers={handlers} level={3} />}
    </article>
  );
}
