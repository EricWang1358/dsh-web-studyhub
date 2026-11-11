import React, { useLayoutEffect, useRef, useState } from 'react';
import MathText from '../../MathText.jsx';
import { ui } from '../../i18n.js';
import { computePlacement } from '../../components/index.js';

/* The 词解 of a passage, shown while the pointer is on its wavy line (usePassageLinkLayer's cardOf / onCard): the term and the kept answer,
   under the passage (over it when there is no room). Hidden until hovered, never a title= on the text. A click on the line opens the whole
   批注 in the learning panel, where it can be asked further or deleted. */
export default function ExplainCard({ shown }) {
  const panel = useRef(null), [at, setAt] = useState(null);
  useLayoutEffect(() => {
    if (!shown || !panel.current) { setAt(null); return; }
    const size = panel.current.getBoundingClientRect();
    const placed = computePlacement({ anchor: shown.rect, size, placement: 'bottom-start', flip: true, gap: 6, margin: 8,
      bounds: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } });
    setAt({ left: placed.left, top: placed.top });
  }, [shown]);
  if (!shown?.card) return null;
  // The answer marks its terms as [[term]] for the learning panel's chips; here they read as plain words.
  const { term } = shown.card, answer = String(shown.card.answer || '').replace(/\[\[([^\]]+)\]\]/g, '$1');
  return <div ref={panel} className="reader-explain" role="tooltip" style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: 'hidden' }}>
    <p className="reader-explain__term"><span className="reader-explain__tag">{ui('词解')}</span>{term}</p>
    <div className="reader-explain__answer"><MathText text={answer} /></div>
    <small className="reader-explain__hint">{ui('点一下划线处，在学习面板里追问或删除。')}</small>
  </div>;
}
