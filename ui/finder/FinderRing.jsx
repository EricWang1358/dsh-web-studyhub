import React, { useEffect, useRef, useState } from 'react';
import { useInjectCss } from '../shared.js';
import { spotlightBox } from '../tour/geometry.js';
import css from './finder.css';

/** How long the ring stays: it is one look at where the control is, not a state of the page. */
export const RING_MS = 2500;
const FADE_MS = 300;

const sameBox = (a, b) => !a === !b && (!a || ['left', 'top', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) < 0.5));

/**
 * The one-shot ring 「带我去」 draws around the control it landed on (ui/finder/use-finder.js): the tour's spotlight box (ui/tour/geometry.js spotlightBox)
 * and ring, without the shade, drawn for RING_MS and gone at once on any input. The box follows the control while the page settles (a smooth scroll, a fold
 * that opened); `resolve()` gives the element, so a page that redraws it is followed. Opacity and a scale only; with reduced motion it simply appears.
 */
export default function FinderRing({ resolve, onDone }) {
  useInjectCss(css, 'study-finder');
  const layer = useRef(null), done = useRef(onDone);
  done.current = onDone;
  const [box, setBox] = useState(null), [leaving, setLeaving] = useState(false);
  useEffect(() => {
    let frame = 0, alive = true;
    const measure = () => {
      if (!alive) return;
      const view = layer.current?.getBoundingClientRect(), element = resolve();
      const rect = element?.isConnected ? element.getBoundingClientRect() : null;
      const target = view && rect && rect.width > 0 && rect.height > 0 ? { left: rect.left - view.left, top: rect.top - view.top, width: rect.width, height: rect.height } : null;
      const next = view ? spotlightBox(target, { width: view.width, height: view.height }) : null;
      setBox((previous) => (sameBox(previous, next) ? previous : next));
      frame = requestAnimationFrame(measure);
    };
    measure();
    const fade = setTimeout(() => setLeaving(true), RING_MS - FADE_MS), end = setTimeout(() => done.current?.(), RING_MS);
    const stop = (event) => { if (!event.repeat) done.current?.(); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    for (const name of events) document.addEventListener(name, stop, { capture: true, passive: true });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(fade);
      clearTimeout(end);
      for (const name of events) document.removeEventListener(name, stop, { capture: true });
    };
  }, [resolve]);
  return (
    <div ref={layer} className="finder-ring-layer" aria-hidden="true">
      {box && <div className={`finder-ring${leaving ? ' is-leaving' : ''}`} data-finder-ring style={{ transform: `translate(${box.left}px, ${box.top}px)` }}>
        <div className="finder-ring__box" style={{ width: box.width, height: box.height }} />
      </div>}
    </div>
  );
}
