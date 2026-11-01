import React, { memo, useContext } from 'react';
import { ui } from '../i18n.js';
import { Button, Icon } from '../components/index.js';
import BookFile, { headingAnchor } from './BookFile.jsx';
import BookSuggestion from './BookSuggestion.jsx';
import PointBody from './PointBody.jsx';
import { pointSummary } from './point-parts.js';
import { BookReadContext } from './reading.js';
import { AskRow } from './BookAsk.jsx';

/* One chapter of the review book (a top node of the 总纲, or 未归位) in 整章滚动. Only an open chapter renders its files (I8: a big book stays light); a closed
   one is its heading. Inside an open chapter each knowledge point is folded to its title and one line (its takeaway) except the one being read; an open
   point shows its body (ui/book/PointBody.jsx). Headings carry their stable id (`book-<id>`): the targets of the 目录 and of the way back after practice. */

export { headingAnchor, PointBody };

/** A section or a knowledge point under a chapter. */
function BookNode({ node, course, handlers }) {
  const read = useContext(BookReadContext);
  const Heading = `h${Math.min(6, node.depth + 1)}`;
  // In 整章滚动 a point opens and folds from its heading (without the page's reading context every point is open).
  const foldable = node.leaf && read?.mode === 'scroll', open = !foldable || read.expanded.has(node.hid);
  const title = <><span className="book-node__number">{node.number}</span> {node.title}</>;
  const heading = <Heading id={`book-${node.hid}`} className="book-node__heading" data-book-heading={node.hid} tabIndex={-1}>
    {foldable ? <Button variant="quiet" wrap className="book-node__toggle" aria-expanded={open} onClick={() => read.expand(node.hid, !open)}>
      <Icon name="caret" size={14} className="book-node__caret" />{title}</Button> : title}
  </Heading>;
  return (
    <div className="book-node" data-depth={Math.min(4, node.depth)} data-book-folded={open ? undefined : 'true'}>
      {/* An open point has 问 AI at the right of its title, as in 逐节读. */}
      {node.leaf && open && handlers.ask ? <AskRow onAsk={element => handlers.ask(node, element)}>{heading}</AskRow> : heading}
      {!open ? <p className="book-node__summary">{pointSummary(node.gen) || ui('展开读这一节')}</p>
        : node.leaf ? <PointBody node={node} course={course} handlers={handlers} level={Math.min(6, node.depth + 2)} />
          : node.children.map(child => <BookNode key={child.hid} node={child} course={course} handlers={handlers} />)}
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
      {open && (node.hid === 'unplaced' ? <UnplacedBody node={node} handlers={handlers} />
        : node.leaf ? <PointBody node={node} course={course} handlers={handlers} level={3} /> : node.children.map(child => <BookNode key={child.hid} node={child} course={course} handlers={handlers} />))}
    </section>
  );
});

/** 未归位: the text whose point is gone, and its file's suggestions. */
export function UnplacedBody({ node, handlers }) {
  return <>
    {handlers.place && handlers.unplacedSections?.length > 0 && <ul className="book-unplaced" aria-label={ui('放回到知识点')}>
      {handlers.unplacedSections.map(section => <li key={section.id} className="book-unplaced__section" data-unplaced-section="">
        <span className="book-unplaced__title">{section.title || ui('开头的文字')}</span>
        <Button variant="link" size="sm" onClick={() => handlers.place(section)}>{ui('放回…')}</Button>
      </li>)}
    </ul>}
    <BookFile text={node.text} hid="unplaced" handlers={handlers} className="book-file book-file--mine" />
    {handlers.files?.[node.file]?.suggestions?.length > 0 && <BookSuggestion meta={handlers.files[node.file]} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.file, action, id)} />}
  </>;
}
