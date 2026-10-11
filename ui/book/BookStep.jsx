import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, IconButton } from '../components/index.js';
import PointBody from './PointBody.jsx';
import { UnplacedBody } from './BookChapter.jsx';
import { codeOf } from '../../lib/course-book-lookup.js';

/* 逐节读 (复习全书, docs/review-book.md "Reading modes"): ONE knowledge point of the book, under its chapter and section path, with 上一节 / 下一节 above
   (compact) and below it (with the neighbour's title); the ← / → keys do the same (ui/book/reading.js useStepKeys). The 目录 marks it. */

const neighbour = step => (step ? `${step.node.number ? `${step.node.number} ` : ''}${step.node.title}` : '');

/** steps (ui/book/reading.js bookSteps), at: the index shown, onGo(index), course, handlers (ui/book/BookPage.jsx). */
export default function BookStep({ steps, at, onGo, course, handlers }) {
  const step = steps[at];
  if (!step) return null;
  const prev = steps[at - 1], next = steps[at + 1], node = step.node;
  return (
    <article className="book-step" data-book-step={step.hid} aria-labelledby={`book-${step.hid}`}>
      <div className="book-step__top">
        {step.path.length > 0 && <ol className="book-step__path" aria-label={ui('所在章节')}>
          {step.path.map(item => <li key={item.hid} className="book-step__crumb"><span className="book-node__number">{item.number}</span> {item.title}</li>)}
        </ol>}
        <div className="book-step__jump">
          <span className="book-step__count">{uiFormat('第 {0} / {1} 节', [at + 1, steps.length])}</span>
          <IconButton icon="chevron" size="sm" className="book-step__back" label={ui('上一节')} disabled={!prev} onClick={() => onGo(at - 1)} />
          <IconButton icon="chevron" size="sm" label={ui('下一节')} disabled={!next} onClick={() => onGo(at + 1)} />
        </div>
      </div>
      <h2 id={`book-${step.hid}`} className="book-step__heading" data-book-heading={step.hid} tabIndex={-1}>
        {node.number && <span className="book-node__number">{node.number}</span>} {node.title} <span className="book-node__code">{codeOf(step.hid)}</span>
      </h2>
      {step.hid === 'unplaced' ? <UnplacedBody node={node} handlers={handlers} /> : <PointBody node={node} course={course} handlers={handlers} level={3} />}
      <nav className="book-step__nav" aria-label={ui('上一节与下一节')}>
        <Button variant="secondary" wrap className="book-step__prev" disabled={!prev} onClick={() => onGo(at - 1)}>
          <span className="book-step__dir">{ui('上一节')}</span>{prev && <span className="book-step__title">{neighbour(prev)}</span>}</Button>
        <Button variant="secondary" wrap className="book-step__next" disabled={!next} onClick={() => onGo(at + 1)}>
          <span className="book-step__dir">{ui('下一节')}</span>{next && <span className="book-step__title">{neighbour(next)}</span>}</Button>
      </nav>
    </article>
  );
}
