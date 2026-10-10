import React, { memo, useCallback, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Icon } from '../components/index.js';
import { plainPrompt } from '../shared.js';
import Markdown from '../Markdown.jsx';
import BookQa from './BookQa.jsx';
import { bookResolver } from './BookLinks.jsx';
import { citesOf } from './model.js';

/* One chapter of the review book (a top node of the 总纲, or 未归位). Only an open chapter renders its files (I8: a big book stays light); a closed one is its
   heading. A knowledge point shows its generated file, then the learner's (both read only in M1), the 出题 entry when it has no question, and 本节问答 when
   its link is open. Headings carry their stable id (`book-<hid>`), the targets of the 目录 and of the way back after practice. */

/** How many of a point's questions show before 还有 N 道. */
const FIRST = 5;

/** One file as Markdown, its links drawn by the book and its 角标 opening the reader at the 出处 of the same file. */
function BookFile({ text, hid, handlers, className }) {
  const cites = useMemo(() => citesOf(text), [text]);
  const resolve = useMemo(() => bookResolver({ gone: handlers.gone, onCard: ref => handlers.card(ref, hid), onPractice: (heading, n) => handlers.practice(heading, n, hid),
    onQa: handlers.toggleQa, qaOpen: handlers.qaOpen, onSource: handlers.source }), [handlers, hid]);
  const onCite = useCallback(n => { const cite = cites.get(n); if (cite) handlers.source(cite.sourceId, cite.quote); }, [cites, handlers]);
  return <Markdown className={className} text={text} resolveLink={resolve} onCite={onCite} />;
}

/** The point's questions as they are now (never stored in a file): the first few as links, 还有 N 道 for the rest; none: 这一节还没有题。 and 出题. */
function PointQuestions({ node, handlers }) {
  const [all, setAll] = useState(false);
  if (!node.questionTotal) return (
    <>
      <p className="book-questions__none">{ui('这一节还没有题。')}</p>
      {handlers.create && <Button size="sm" variant="secondary" icon="sparkle" className="book-node__create" onClick={handlers.create}>{ui('出题')}</Button>}
    </>
  );
  const shown = all ? node.questions : node.questions.slice(0, FIRST);
  return (
    <div className="book-questions">
      <p className="book-questions__head">{ui('本节的题')}</p>
      <ul className="book-questions__list">
        {shown.map(item => <li key={`${item.deckId}|${item.cardId}`}>
          <Button variant="link" size="sm" wrap className="book-link" data-book-link="card" onClick={() => handlers.card({ deckId: item.deckId, cardId: item.cardId }, node.hid)}>
            {uiFormat('练习：{0}', [plainPrompt(item.prompt)])}</Button>
        </li>)}
      </ul>
      {!all && node.questionTotal > FIRST && <Button variant="link" size="sm" className="book-questions__more" onClick={() => setAll(true)}>{uiFormat('还有 {0} 道', [node.questionTotal - FIRST])}</Button>}
    </div>
  );
}

function PointBody({ node, course, handlers }) {
  return (
    <>
      {node.gen && <BookFile text={node.gen} hid={node.hid} handlers={handlers} className="book-file" />}
      <PointQuestions node={node} handlers={handlers} />
      {node.mine && <BookFile text={node.mine} hid={node.hid} handlers={handlers} className="book-file book-file--mine" />}
      {handlers.qaOpen(node.hid) && <BookQa course={course} nodeKey={node.key} onCard={ref => handlers.card(ref, node.hid)} onSource={handlers.source} />}
    </>
  );
}

function BookNode({ node, course, handlers }) {
  const Heading = `h${Math.min(6, node.depth + 1)}`;
  return (
    <div className="book-node" data-depth={Math.min(4, node.depth)}>
      <Heading id={`book-${node.hid}`} className="book-node__heading" data-book-heading={node.hid} tabIndex={-1}>
        <span className="book-node__number">{node.number}</span> {node.title}
      </Heading>
      {node.leaf ? <PointBody node={node} course={course} handlers={handlers} /> : node.children.map(child => <BookNode key={child.hid} node={child} course={course} handlers={handlers} />)}
    </div>
  );
}

/** node: a top node of course.book.open's tree, or { hid: 'unplaced', title, text } for 未归位; open, onToggle(open); handlers: ui/book/BookPage.jsx. */
export default memo(function BookChapter({ node, open, onToggle, course, handlers }) {
  return (
    <section className="book-chapter" data-chapter={node.hid} aria-labelledby={`book-${node.hid}`}>
      <h2 id={`book-${node.hid}`} className="book-chapter__heading" data-book-heading={node.hid} tabIndex={-1}>
        <Button variant="quiet" wrap className="book-chapter__toggle" aria-expanded={open} onClick={() => onToggle(!open)}>
          <Icon name="caret" size={14} className="book-chapter__caret" />
          {node.number && <span className="book-node__number">{node.number}</span>} {node.title}
        </Button>
      </h2>
      {open && (node.hid === 'unplaced' ? <BookFile text={node.text} hid="unplaced" handlers={handlers} className="book-file book-file--mine" />
        : node.leaf ? <PointBody node={node} course={course} handlers={handlers} /> : node.children.map(child => <BookNode key={child.hid} node={child} course={course} handlers={handlers} />))}
    </section>
  );
});
