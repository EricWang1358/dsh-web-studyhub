import React, { useContext, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Disclosure } from '../components/index.js';
import { plainPrompt } from '../shared.js';
import BookQa from './BookQa.jsx';
import BookFile, { resolverOf } from './BookFile.jsx';
import BookSuggestion from './BookSuggestion.jsx';
import PointToolbar from './PointToolbar.jsx';
import PointLayer from './PointLayer.jsx';
import { pointView } from './point-parts.js';
import { AiFoldContext, notWritten } from './ai-fold.js';

/* A knowledge point's body (复习全书; also the folded 讲解 of 翻看, ui/book/BookFlip.jsx), in reading order (docs/review-book.md "Reading a point"): the
   toolbar (练 5 道, 本节问答, 整理), the one-sentence takeaway, the story (讲解, 例子), 要点清单 and 补充 folded, the learner's layer (notes, AI blocks, Q&A),
   the point's questions, and 出处 behind one quiet chip. Nothing is left out of the file: the parts are only shown in another order. */

/** How many of a point's questions show before 还有 N 道. */
const FIRST = 5;

/** The point's questions as they are now (never stored in a file), folded under 本节的题 (N) (练 5 道 is in the toolbar): the first few as links, 还有 N 道
    for the rest; none: nothing (the toolbar says 暂无题). */
function PointQuestions({ node, handlers }) {
  const [all, setAll] = useState(false);
  if (!node.questionTotal) return null;
  const shown = all ? node.questions : node.questions.slice(0, FIRST);
  return (
    <Disclosure className="book-questions" summary={uiFormat('本节的题 ({0})', [node.questionTotal])}>
      <ul className="book-questions__list">
        {shown.map(item => <li key={`${item.deckId}|${item.cardId}`}>
          <Button variant="link" size="sm" wrap className="book-link" data-book-link="card" onClick={event => handlers.card({ deckId: item.deckId, cardId: item.cardId }, node.hid, event.currentTarget)}>
            {uiFormat('练习：{0}', [plainPrompt(item.prompt)])}</Button>
        </li>)}
      </ul>
      {!all && node.questionTotal > FIRST && <Button variant="link" size="sm" className="book-questions__more" onClick={() => setAll(true)}>{uiFormat('还有 {0} 道', [node.questionTotal - FIRST])}</Button>}
    </Disclosure>
  );
}

/** node, course, handlers (ui/book/BookPage.jsx); `level`: the heading level of the point's own part labels (one under the point's heading). */
export default function PointBody({ node, course, handlers, level = 4 }) {
  const view = useMemo(() => pointView(node), [node]);
  const resolve = useMemo(() => resolverOf(handlers, node.hid), [handlers, node.hid]);
  const aiFold = useContext(AiFoldContext);
  // Which blocks have their words marked (each text says so once drawn).
  const [marked, setMarked] = useState({});
  const [cites, setCites] = useState(false);
  const onAnchored = (name, ids) => setMarked(current => (String(current[name]) === String(ids) ? current : { ...current, [name]: ids }));
  const anchored = new Set(Object.values(marked).flat());
  const hideOthers = !!aiFold?.mineOnly?.(node.hid), hidable = view.blocks.filter(item => notWritten(item.block)).length;
  const shown = hideOthers ? view.blocks.filter(item => !notWritten(item.block)) : view.blocks;
  const ids = shown.map(item => item.block.id);
  const tidy = aiFold && view.blocks.length ? { ids, hidable, hidden: hideOthers, allFolded: ids.length > 0 && ids.every(id => aiFold.folded(id, view.layerFolded)),
    foldAll: on => aiFold.foldAll(ids, on), mineOnly: on => aiFold.setMineOnly?.(node.hid, on) } : null;
  const Label = `h${Math.min(6, level)}`;
  const file = (part, className = 'book-file') => <BookFile key={part.name} text={part.text} citeText={node.gen} hid={node.hid} handlers={handlers} className={className}
    anchors={view.anchors.get(part.name)} onAnchored={found => onAnchored(part.name, found)} />;
  const folded = part => part && <Disclosure key={part.name} className="book-point__fold" data-book-part={part.name}
    summary={part.name === 'points' ? ui('要点清单') : part.label}>{file(part)}</Disclosure>;
  return (
    <div className="book-point" data-book-point={node.hid}>
      <PointToolbar node={node} course={course} handlers={handlers} tidy={tidy} />
      {handlers.qaOpen(node.hid) && <BookQa course={course} nodeKey={node.key} onCard={ref => handlers.card(ref, node.hid)} onSource={handlers.source} onBookChanged={handlers.reload} />}
      {node.bridge?.in && <p className="book-point__bridge">{node.bridge.in}</p>}
      {view.story.map(part => (part.name === 'takeaway'
        ? <div key="takeaway" className="book-point__takeaway"><p className="book-point__eyebrow">{ui('一句话')}</p>{file(part, 'book-file book-point__gist')}</div>
        : part.name === 'exam' ? <div key="exam" className="book-point__exam">{file({ ...part, text: `**${part.label}** ${part.text}` })}</div>
          : part.label ? <section key={part.name} className="book-point__part"><Label className="book-point__label">{part.label}</Label>{file(part)}</section>
            : file(part)))}
      {folded(view.points)}
      {folded(view.extra)}
      {node.bridge?.out && <p className="book-point__bridge">{node.bridge.out}</p>}
      <BookSuggestion meta={handlers.files?.[node.files?.gen]} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.gen, action, id)} />
      <PointLayer node={node} view={view} handlers={handlers} resolve={resolve} aiFold={aiFold} shown={shown} hidden={hideOthers ? hidable : 0}
        onShowAll={() => aiFold?.setMineOnly?.(node.hid, false)} anchored={anchored} onAnchored={onAnchored} layerFolded={view.layerFolded} />
      <PointQuestions node={node} handlers={handlers} />
      {view.citeCount > 0 && <div className="book-point__cites">
        <Button variant="quiet" size="sm" icon="external" className="book-point__cites-toggle" aria-expanded={cites} onClick={() => setCites(value => !value)}>
          {uiFormat('出处 {0}', [view.citeCount])}</Button>
        {cites && file({ name: 'cites', text: view.cites }, 'book-file book-point__cite-list')}
      </div>}
    </div>
  );
}
