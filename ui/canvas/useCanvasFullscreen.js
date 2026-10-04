import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import canvasCss from './canvas.css';
import { useComponentCss } from '../components/css.js';

/**
 * Ask the browser to make `element` the fullscreen element. Hosts that disallow
 * the Fullscreen API (DSH's plugin pane) refuse or lack it; the answer is then
 * 'popover': the caller expands the element in the top layer instead.
 */
export async function requestCanvasFullscreen(element) {
  if (typeof element?.requestFullscreen === 'function') {
    try { await element.requestFullscreen(); return 'native'; } catch { /* blocked by the host: fall through */ }
  }
  return 'popover';
}

/**
 * Fullscreen for a canvas: the Fullscreen API where the host allows it, else a
 * manual popover that enters the top layer (above any z-index and outside the
 * host's paint containment). Attach `ref` to the canvas element and add
 * `className` to it. `full` is true in either mode, `enter()` / `exit()` /
 * `toggle()` change it, and `onEscape(event)` is for the canvas's keydown: it
 * leaves the expanded mode (and says so by returning true); the browser leaves
 * native fullscreen by itself. Focus goes back to what opened it.
 */
export function useCanvasFullscreen() {
  useComponentCss(canvasCss, 'study-canvas');
  const ref = useRef(null), opener = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [native, setNative] = useState(false);
  useEffect(() => {
    const sync = () => setNative(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!expanded || !el?.showPopover) return undefined;
    el.setAttribute('popover', 'manual');
    el.showPopover();
    return () => { el.hidePopover(); el.removeAttribute('popover'); };
  }, [expanded]);
  useLayoutEffect(() => {
    if (expanded) return undefined;
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    return undefined;
  }, [expanded]);
  const enter = async () => {
    if (document.fullscreenElement === ref.current || expanded) return true;
    opener.current = document.activeElement;
    const how = await requestCanvasFullscreen(ref.current);
    if (how === 'popover') setExpanded(true);
    return true;
  };
  const exit = async () => {
    if (document.fullscreenElement === ref.current) await document.exitFullscreen();
    else setExpanded(false);
  };
  const full = expanded || native;
  return {
    ref, expanded, native, full, enter, exit,
    toggle: () => (full ? exit() : enter()),
    close: () => setExpanded(false),
    className: expanded ? 'canvas-expanded' : '',
    onEscape: event => {
      if (event.key !== 'Escape' || !expanded) return false;
      event.stopPropagation();
      setExpanded(false);
      return true;
    },
  };
}

export default useCanvasFullscreen;
