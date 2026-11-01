import React, { useContext, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Disclosure, Tooltip } from '../components/index.js';
import { fillGapsTip } from '../outline/words.js';
import { plainPrompt } from '../shared.js';
import BookQa from './BookQa.jsx';
import BookFile, { resolverOf } from './BookFile.jsx';
import BookSuggestion from './BookSuggestion.jsx';
import BookAiBlock from './BookAiBlock.jsx';
import BookAiLine from './BookAiLine.jsx';
import PointToolbar from './PointToolbar.jsx';
import PointLayer from './PointLayer.jsx';
import PointText from './PointText.jsx';
import { foldsByDefault, pointView } from './point-parts.js';
import { linesOf } from './ai-lines.js';
import { AiFoldContext, BookAiContext } from './ai-fold.js';

/* A knowledge point's body (复习全书; also the folded 讲解 of 翻看, ui/book/BookFlip.jsx), in reading order (docs/review-book.md "Reading a point"): the
   one-sentence takeaway (type, no box), the story (讲解, 例子) with the AI blocks about words right after their paragraphs, 要点清单 and 补充 folded, the
   learner's layer (我的: notes, AI blocks for the whole point, Q&A), the point's questions, 出处 behind one quiet chip, and last the row of its actions
   (练 5 道, 本节问答 with its panel under it; 问 AI is at the title). The line an AI task or a deletion leaves stands where its block is or will be
   (ui/book/ai-lines.js). Nothing is left out of the file: the parts are only shown in another order. */

/** How many of a point's questions show before 还有 N 道. */
const FIRST = 5;
const NO_LINES = [];

/** The point's questions as they are now (never stored in a file), folded under 本节的题 (N) (练 5 道 is in the toolbar): the first few as links, 还有 N 道
    for the rest; none: nothing (the 总纲 says 还没出题). */
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
  // The lines AI tasks and deletions leave in this point (ui/book/ai-lines.js), placed like the blocks they stand for.
  const allLines = useContext(BookAiContext);
  const lines = allLines ? linesOf(allLines, node.hid) : NO_LINES, linesKey = lines.map(line => `${line.key}:${line.kind}:${line.id}:${line.faded ? 1 : 0}`).join('|');
  const view = useMemo(() => pointView(node, lines), [node, linesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolve = useMemo(() => resolverOf(handlers, node.hid), [handlers, node.hid]);
  const aiFold = useContext(AiFoldContext);
  // Which blocks have their words marked (each text says so once drawn).
  const [marked, setMarked] = useState({});
  const [cites, setCites] = useState(false);
  const onAnchored = (key, ids) => setMarked(current => (String(current[key]) === String(ids) ? current : { ...current, [key]: ids }));
  // A text that is no longer drawn (its block is deleted, or its words changed and the block became lost) never reports again: only a block that still has its
  // words in the point counts as anchored.
  const homed = new Set(view.blocks.filter(item => item.part !== null).map(item => item.block.id));
  const anchored = new Set(Object.values(marked).flat().filter(id => homed.has(id)));
  const Label = `h${Math.min(6, level)}`;
  // A block is open unless it is long and not kept, or the learner folded it; the learner's own fold or open wins (ui/book/ai-fold.js). A block that just landed
  // in a line's place is folded (it stands as high as the line did).
  const isFolded = item => view.landed.has(item.block.id) || !!aiFold?.folded(item.block.id, foldsByDefault(item.block));
  const renderBlock = item => (item.block.line
    ? <BookAiLine key={item.block.id} line={item.block.line} onCancel={handlers.aiCancel} onRetry={handlers.aiRetry} onDismiss={handlers.aiDismiss} onUndo={handlers.aiUndo}
      onForget={handlers.aiForget} />
    : <BookAiBlock key={item.block.id} item={item} resolveLink={resolve} busy={handlers.busy} onAction={(action, block) => handlers.aiAction?.(node, action, block)}
      onFollow={(block, question) => handlers.aiFollow?.(node, block, question)} folded={isFolded(item)} onFold={aiFold?.fold}
      anchored={anchored.has(item.block.id)} onWords={handlers.aiWords} repeat={view.repeats.has(item.block.id)} rewriting={view.rewriting.get(item.block.id) ?? null}
      onCancel={handlers.aiCancel} />);
  const text = (part, props = {}) => <PointText key={part.name} name={part.name} text={part.text} view={view} node={node} handlers={handlers} citeText={node.gen} renderBlock={renderBlock}
    onAnchored={onAnchored} className="book-file" {...props} />;
  // 要点清单 and 补充 are folded: the blocks about their words sit right under the fold, and a press on the dashed words opens it.
  const folded = part => part && <React.Fragment key={part.name}>
    <Disclosure className="book-point__fold" data-book-part={part.name} summary={part.name === 'points' ? ui('要点清单') : part.label}>
      <BookFile text={part.text} citeText={node.gen} hid={node.hid} handlers={handlers} className="book-file" anchors={view.anchors.get(part.name)} onAnchored={ids => onAnchored(part.name, ids)} />
    </Disclosure>
    {view.blocks.filter(item => item.part === part.name).map(renderBlock)}
  </React.Fragment>;
  return (
    <div className="book-point" data-book-point={node.hid}>
      {node.movedFrom && <p className="book-point__bridge" data-moved-from="">{uiFormat('来自原知识点「{0}」', [node.movedFrom])}</p>}
      {node.bridge?.in && <p className="book-point__bridge">{node.bridge.in}</p>}
      {view.story.map(part => (part.name === 'takeaway'
        ? text(part, { className: 'book-file book-point__gist' })
        : part.name === 'exam' ? <div key="exam" className="book-point__exam">{text(part, { prefix: `**${part.label}** ` })}</div>
          : part.label ? <section key={part.name} className="book-point__part" data-book-part={part.name}><Label className="book-point__label">{part.label}</Label>{text(part)}</section>
            : text(part)))}
      {folded(view.points)}
      {folded(view.extra)}
      {node.bridge?.out && <p className="book-point__bridge">{node.bridge.out}</p>}
      {node.short && handlers.fillGaps && <p className="book-point__short"><Tooltip content={fillGapsTip()}>
        <Button variant="link" size="sm" icon="sparkle" lock={handlers.busy} onClick={() => handlers.fillGaps(node)}>{ui('补漏')}</Button></Tooltip></p>}
      <BookSuggestion meta={handlers.files?.[node.files?.gen]} busy={handlers.busy} onChoose={(action, id) => handlers.choose(node.files.gen, action, id)} />
      <PointLayer node={node} view={view} handlers={handlers} aiFold={aiFold} isFolded={isFolded} renderBlock={renderBlock} onAnchored={onAnchored} />
      <PointQuestions node={node} handlers={handlers} />
      {/* The point's actions close it, so the reading starts right under its heading (S2 turns this row into the point's end); 出处 is the first of them, its
          list opens under the row. */}
      <PointToolbar node={node} course={course} handlers={handlers} cites={view.citeCount > 0 ? <Button variant="quiet" size="sm" icon="external"
        className="book-point__cites-toggle" aria-expanded={cites} onClick={() => setCites(value => !value)}>{uiFormat('出处 {0}', [view.citeCount])}</Button> : null} />
      {cites && view.citeCount > 0 && <BookFile text={view.cites} citeText={node.gen} hid={node.hid} handlers={handlers} className="book-file book-point__cite-list" />}
      {handlers.qaOpen(node.hid) && <BookQa course={course} nodeKey={node.key} onCard={ref => handlers.card(ref, node.hid)} onSource={handlers.source} onBookChanged={handlers.reload} />}
    </div>
  );
}
