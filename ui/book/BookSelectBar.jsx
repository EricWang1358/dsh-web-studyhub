import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import useRangeAnchor from '../document-preview/translation/useRangeAnchor.js';
import { columnBounds, selectedWords, selectionBox, selectionPoint, toolbarStays } from './ask-visibility.js';
import { HandOffButton } from '../hand-off/HandOff.jsx';

/* The selection toolbar of the review book (docs/review-book.md "Ask AI"): words selected in a point, by mouse, keyboard or touch (it listens to
   `selectionchange`, so a Shift+arrow selection and a long press count, in 翻看 too), show 「弄懂」「写一段…」「发给主会话」 above the selection's first line,
   so every selected word stays in sight (below its last line when there is no room; placed by ui/document-preview/translation/useRangeAnchor.js, zoom-correct,
   following the scroll), within the reading column (its edges line up with the text). 弄懂 is a secondary button: the page keeps its one primary. The words
   sent never carry the 角标 digits. The first Tab after a selection moves into it (once: the next Tab goes on through the page); Escape hides it. */

/** host: the page element it is placed in; scrollerRef; hidden: the 问 AI panel is open; model: modelReadiness; onExplain({ heading, words }),
    onWrite({ heading, words, range }), onSend({ heading, words }). */
export default function BookSelectBar({ host, scrollerRef, hidden = false, model, onExplain, onWrite, onSend }) {
  const [picked, setPicked] = useState(null);
  const bar = useRef(null), rangeRef = useRef(null), columnRef = useRef(null);
  // Placed against one box over the selection's lines (ask-visibility.js selectionBox), within the reading column of the point it is in.
  const boxRef = useRef({ getClientRects: () => { const box = selectionBox(rangeRef.current?.getClientRects()); return box ? [box] : []; } });
  const boundsRef = useMemo(() => ({ get current() {
    const area = scrollerRef?.current;
    if (!area) return null;
    return { ...area, getBoundingClientRect: () => columnBounds(area.getBoundingClientRect(), columnRef.current?.isConnected ? columnRef.current.getBoundingClientRect() : null) };
  } }), [scrollerRef]);
  useEffect(() => {
    // armed: a new selection's first Tab goes into the toolbar (from the page or its reading column), only once.
    let timer = 0, down = false, armed = false, last = '';
    const read = () => {
      const selection = window.getSelection?.(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const point = range && !selection.isCollapsed ? selectionPoint(range) : null, words = point ? selectedWords(range) : '';
      if (!point || words.length < 2) {
        if (!toolbarStays({ focusInside: !!bar.current?.contains(document.activeElement) })) { setPicked(null); armed = false; last = ''; }
        return;
      }
      const key = `${point.dataset.bookPoint}|${words}`;
      if (key !== last) { armed = true; last = key; }
      columnRef.current = point.closest('.book-read, .book-flip') || point;
      rangeRef.current = range.cloneRange();
      setPicked({ heading: point.dataset.bookPoint, words: words.slice(0, 600) });
    };
    // While the pointer is down (a drag), the toolbar waits for the end of it; a keyboard or a touch selection settles after a short pause.
    const later = ms => { clearTimeout(timer); timer = setTimeout(read, ms); };
    const onChange = () => { if (!down) later(150); };
    const onDown = event => { if (!bar.current?.contains(event.target)) down = true; };
    const onUp = () => { if (down) { down = false; later(10); } };
    const onKey = event => {
      if (!bar.current || event.defaultPrevented) return;
      if (event.key === 'Escape') { setPicked(null); return; }
      // From a new selection, the first Tab goes into the toolbar (its buttons are reached by keyboard too); once only, and only from the page itself or the
      // reading column the words are in, so the keyboard is never held in a loop.
      const active = document.activeElement, from = !active || active === document.body || !!columnRef.current?.contains(active);
      const typing = event.target?.closest?.('input, textarea, [contenteditable="true"]');
      if (event.key === 'Tab' && !event.shiftKey && armed && from && !typing && !bar.current.contains(active)) { armed = false; event.preventDefault(); bar.current.querySelector('button')?.focus(); }
    };
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const shown = !!picked && !hidden;
  useRangeAnchor({ elementRef: bar, host, rangeRef: boxRef, scrollerRef: boundsRef, active: shown, trigger: picked ? `${picked.heading}|${picked.words}` : '', placement: 'top-start', gap: 6, margin: 0, hideAway: true });
  if (!shown) return null;
  const done = then => () => { const now = picked; setPicked(null); then(now); };
  return (
    // A press on the toolbar keeps the selection (the words stay highlighted while the learner chooses).
    <div className="book-select" ref={bar} role="toolbar" aria-label={ui('选中的文字')} onMouseDown={event => event.preventDefault()}>
      <Tooltip layer content={model?.ready ? ui('用你设置的模型讲这几句，约 1 分钟；写好后收成一行，放在这段后面。') : ui('先配置模型才能弄懂；发给主会话不需要模型。')} anchorClassName="book-select__tip">
        <Button size="sm" variant="secondary" icon="sparkle" data-book-select="explain" onClick={done(now => (model?.ready ? onExplain(now) : onWrite({ ...now, range: rangeRef.current })))}>{ui('弄懂')}</Button>
      </Tooltip>
      <Button size="sm" variant="quiet" data-book-select="write" onClick={done(now => onWrite({ ...now, range: rangeRef.current }))}>{ui('写一段…')}</Button>
      <HandOffButton shape="quiet" anchorClassName="book-select__tip" data-book-select="chat" onClick={done(onSend)} />
    </div>
  );
}
