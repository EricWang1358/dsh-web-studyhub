import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppearance, useAppearanceAttrs } from '../use-appearance.js';
import { SCIENCE_DEFAULTS, SCIENCE_KEY, normalizeScienceSettings } from '../science-settings.js';
import { usePersistentState } from '../storage.js';

/* The shell's own preferences and its root element: the appearance (one store shared with every open panel and tab),
   the science preferences, the sidebar collapse and the narrow-window rule. Each persisted preference is one
   usePersistentState line (ui-consistency #115). */

export const SIDEBAR_KEY = 'study-sidebar';
export const EN_KEY = 'study-en';
export const AUTOPILOT_KEY = 'study-autopilot';

/** Stored as readable words, as they always were: 'collapsed' | 'open', '1' | '0', 'on' | 'off'. */
export const flag = (on, off) => ({ parse: (raw) => raw === on, serialize: (value) => (value ? on : off) });
const sidebarCodec = flag('collapsed', 'open');
const scienceCodec = { parse: (raw) => normalizeScienceSettings(JSON.parse(raw)), serialize: (value) => JSON.stringify(normalizeScienceSettings(value)) };
const NARROW_WIDTH = 720;

/** rootRef and attachRoot: the loading screen renders .study-app without a mount effect, so the width observer hangs on a callback ref. */
export function useAppShell() {
  /* The appearance (theme, size, typeface, motion) is one store shared with every open panel and tab. 'auto' follows the OS (inside DSH,
     the host's appearance) live; the resolved values are always stamped on the root, so every view, and the editors, switch together. */
  const [appearance, updateAppearance, resetAppearance] = useAppearance();
  const appearanceAttrs = useAppearanceAttrs(appearance);
  const theme = appearance.theme, resolvedTheme = appearanceAttrs['data-theme'], motion = appearanceAttrs['data-motion'];
  const setTheme = useCallback((value) => updateAppearance({ theme: value }), [updateAppearance]);
  const [sciencePrefs, setSciencePrefs] = usePersistentState(SCIENCE_KEY, () => ({ ...SCIENCE_DEFAULTS }), scienceCodec);
  /* Sidebar collapse. The manual choice is persisted; a narrow workspace forces the icon rail regardless of the stored preference. */
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState(SIDEBAR_KEY, false, sidebarCodec);
  const [narrowWindow, setNarrowWindow] = useState(false);
  const rootRef = useRef(null), narrowObserver = useRef(null);
  const attachRoot = useCallback((node) => {
    rootRef.current = node;
    narrowObserver.current?.disconnect();
    narrowObserver.current = null;
    // Measured as the node attaches, before the first paint: the observer's first answer comes after it, and the open sidebar was drawn for one frame
    // and then folded into the rail, moving the whole page 128 px (found by the journey at 420 px).
    if (node && typeof node.getBoundingClientRect === 'function') setNarrowWindow(node.getBoundingClientRect().width <= NARROW_WIDTH);
    if (node && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(([entry]) => setNarrowWindow(entry.contentRect.width <= NARROW_WIDTH));
      observer.observe(node);
      narrowObserver.current = observer;
    }
  }, []);
  useEffect(() => () => narrowObserver.current?.disconnect(), []);
  return { appearance, updateAppearance, resetAppearance, appearanceAttrs, theme, resolvedTheme, motion, setTheme, sciencePrefs, setSciencePrefs,
    sidebarCollapsed, setSidebarCollapsed, sidebarNarrow: sidebarCollapsed || narrowWindow, rootRef, attachRoot };
}
