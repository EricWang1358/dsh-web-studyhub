import React from 'react';
import BookFile from './BookFile.jsx';

/* One part of a knowledge point's text (复习全书, ui/book/PointBody.jsx): a paragraph or more of Markdown, cut after the paragraph that holds the words of an AI
   block, the block drawn right there (as the book did before 逐节读), the words dashed in the paragraph before it (ui/book/point-parts.js pointView `weave`).
   A part no block is about is one file, as it is. */

/** name: the part ('explain', 'mine', …); text; view (pointView); className; citeText: the whole file its 角标 are numbered in; prefix: words in front of the first
    paragraph (the 考情 label); renderBlock(item); onAnchored(key, ids): which blocks have their words marked once drawn. */
export default function PointText({ name, text, view, node, handlers, className, citeText, prefix = '', renderBlock, onAnchored }) {
  const pieces = view.weave.get(name);
  const file = (piece, key, anchors, first) => <BookFile key={key} text={first ? `${prefix}${piece}` : piece} citeText={citeText} hid={node.hid} handlers={handlers} className={className}
    anchors={anchors} onAnchored={ids => onAnchored(key, ids)} />;
  if (!pieces) return file(text, name, view.anchors.get(name), true);
  let drawn = false;
  return pieces.map((piece, at) => {
    if (piece.item) return renderBlock(piece.item);
    const first = !drawn;
    drawn = true;
    return file(piece.text, `${name}-${at}`, piece.anchors, first);
  });
}
