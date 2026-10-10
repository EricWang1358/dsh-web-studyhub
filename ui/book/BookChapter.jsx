import React, { memo, useCallback, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Icon } from '../components/index.js';
import { plainPrompt } from '../shared.js';
import Markdown from '../Markdown.jsx';
import BookQa from './BookQa.jsx';
import { bookResolver } from './BookLinks.jsx';
import BookSuggestion from './BookSuggestion.jsx';
import { citesOf } from './model.js';
import { withoutQaMarkers } from '../../lib/course-book-qa-text.js';
import { aiBlocks, weaveBlocks, withoutAiBlocks } from '../../lib/course-book-ai-text.js';
import BookAiBlock from './BookAiBlock.jsx';
import { codeOf, plainTerms, withoutNoprintMarkers } from '../../lib/course-book-lookup.js';

/* One chapter of the review book (a top node of the 总纲, or 未归位). Only an open chapter renders its files (I8: a big book stays light); a closed one is its
   heading. A knowledge point shows its generated file, its questions (live), the learner's file, its Q&A file (M3) and 本节问答 when its link is open; the
   AI blocks of its own file (弄懂 / 加一段, M4) sit right after the paragraph they are about, under the heading, or at the end marked 原位置已变.
   Headings carry their stable id (`book-<id>`): the outline's from the manifest, a typed one from its `<!-- sh:id … -->` (Markdown's headingAnchor);
   they are the targets of the 目录 and of the way back after practice. */

/** How many of a point's questions show before 还有 N 道. */
const FIRST = 5;

/** A typed heading's id from its `<!-- sh:id … -->`: on the element (book-<id>, the 目录's and the way back's target), the marker off the text. */
const ID_SUFFIX = /\s*<!-- sh:id (\S+) -->\s*$/;
export const headingAnchor = text => {
  const match = ID_SUFFIX.exec(text);
  return match ? { text: text.slice(0, match.index), props: { id: `book-${match[1]}`, 'data-book-heading': match[1], tabIndex: -1 } } : null;
};

const resolverOf = (handlers, hid) => bookResolver({ gone: handlers.gone, onCard: (ref, element) => handlers.card(ref, hid, element),
  onPractice: (heading, n, element) => handlers.practice(heading, n, hid, element), onQa: handlers.toggleQa, qaOpen: handlers.qaOpen, onSource: handlers.source });

/** One file (or a part of one) as Markdown, its links drawn by the book and its 角标 opening the reader at the 出处 of the same file (`citeText`: the whole file). */
function BookFile({ text, citeText = text, hid, handlers, className }) {
  const cites = useMemo(() => citesOf(citeText), [citeText]);
  const resolve = useMemo(() => resolverOf(handlers, hid), [handlers, hid]);
  const onCite = useCallback(n => { const cite = cites.get(n); if (cite) handlers.source(cite.sourceId, cite.quote); }, [cites, handlers]);
  // A Q&A block's marker lines are the book's, not the reader's (the heading ids stay: headingAnchor reads them); so are the noprint markers (M6: only
  // the export leaves that text out) and the brackets of a [[term]].
  const shown = useMemo(() => plainTerms(withoutNoprintMarkers(withoutQaMarkers(text))), [text]);
  return <Markdown className={className} text={shown} resolveLink={resolve} onCite={onCite} headingAnchor={headingAnchor} />;
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

/** A knowledge point's body (also the folded 讲解 of 翻看, ui/book/BookFlip.jsx). */
export function PointBody({ node, course, handlers }) {
  // The own file's AI blocks woven in after their paragraphs (lib/course-book-ai-text.js); the generated file's part comes before the questions, the own after.
  const woven = useMemo(() => weaveBlocks([{ name: 'gen', text: node.gen || '' }, { name: 'mine', text: withoutAiBlocks(node.mine) }], aiBlocks(node.mine)), [node.gen, node.mine]);
  const resolve = useMemo(() => resolverOf(handlers, node.hid), [handlers, node.hid]);
  const genParts = [], mineParts = [];
  let inMine = false;
  for (const part of woven.parts) { if (part.name === 'mine') inMine = true; (inMine ? mineParts : genParts).push(part); }
  const show = (part, at) => (part.block
    ? <BookAiBlock key={part.block.id} item={part} resolveLink={resolve} busy={handlers.busy} onAction={(action, block) => handlers.aiAction?.(node, action, block)}
      onFollow={(block, question) => handlers.aiFollow?.(node, block, question)} />
    : <BookFile key={`${part.name}-${at}`} text={part.text} citeText={part.name === 'gen' ? node.gen : node.mine} hid={node.hid} handlers={handlers}
      className={part.name === 'gen' ? 'book-file' : 'book-file book-file--mine'} />);
  return (
    <div className="book-point" data-book-point={node.hid}>
      {handlers.addHere && <Button variant="link" size="sm" icon="sparkle" className="book-point__add" onClick={event => handlers.addHere(node, event.currentTarget)}>{ui('在这里加一段')}</Button>}
      {woven.top.map(show)}
      {genParts.map(show)}
      <BookSuggestion meta={handlers.files?.[node.files?.gen]} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.gen, action, id)} />
      <PointQuestions node={node} handlers={handlers} />
      {mineParts.map(show)}
      {woven.lost.map(show)}
      {handlers.files?.[node.files?.mine]?.suggestions?.length > 0 && <BookSuggestion meta={handlers.files[node.files.mine]} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.mine, action, id)} />}
      {node.qa && <BookFile text={node.qa} hid={node.hid} handlers={handlers} className="book-file book-file--mine" />}
      {node.files?.qa && handlers.files?.[node.files.qa]?.suggestions?.length > 0 && <BookSuggestion meta={handlers.files[node.files.qa]} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.qa, action, id)} />}
      {handlers.qaOpen(node.hid) && <BookQa course={course} nodeKey={node.key} onCard={ref => handlers.card(ref, node.hid)} onSource={handlers.source} onBookChanged={handlers.reload} />}
    </div>
  );
}

function BookNode({ node, course, handlers }) {
  const Heading = `h${Math.min(6, node.depth + 1)}`;
  return (
    <div className="book-node" data-depth={Math.min(4, node.depth)}>
      <Heading id={`book-${node.hid}`} className="book-node__heading" data-book-heading={node.hid} tabIndex={-1}>
        <span className="book-node__number">{node.number}</span> {node.title} <span className="book-node__code">{codeOf(node.hid)}</span>
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
        {/* The stable code the printed book carries in its margin (M6). */}
        <span className="book-node__code">{codeOf(node.hid)}</span>
      </h2>
      {open && (node.hid === 'unplaced' ? <><BookFile text={node.text} hid="unplaced" handlers={handlers} className="book-file book-file--mine" />
        {handlers.files?.[node.file]?.suggestions?.length > 0 && <BookSuggestion meta={handlers.files[node.file]} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.file, action, id)} />}</>
        : node.leaf ? <PointBody node={node} course={course} handlers={handlers} /> : node.children.map(child => <BookNode key={child.hid} node={child} course={course} handlers={handlers} />))}
    </section>
  );
});
