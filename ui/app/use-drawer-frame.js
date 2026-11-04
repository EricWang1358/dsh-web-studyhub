import { useLayoutEffect } from 'react';

/* The box the navigation drawer opens in (ui/app/AppSidebar.jsx): StudyHub's own page, never the whole host window. The drawer is the shared
   Dialog, which the browser lifts into the top layer and places against the viewport; inside DSH the viewport is the whole DSH window, so a
   drawer at `left: 0` covered DSH's own sidebar. While the drawer is out, the app root's box is written on the root as custom properties
   (they inherit into the dialog, which stays a DOM child of the root) and ui/app/nav-drawer.css places the drawer inside it. */

const FRAME = ['--nav-frame-left', '--nav-frame-top', '--nav-frame-width', '--nav-frame-height'];

/** The root's box in viewport pixels, as the four custom properties. */
export function frameOf(rect) {
  return { '--nav-frame-left': `${rect.left}px`, '--nav-frame-top': `${rect.top}px`, '--nav-frame-width': `${rect.width}px`, '--nav-frame-height': `${rect.height}px` };
}

/** While `open`, keep `rootRef.current`'s box on it as --nav-frame-*; removed again on close. */
export function useDrawerFrame(rootRef, open) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!open || !root || typeof root.getBoundingClientRect !== 'function') return undefined;
    const write = () => { for (const [name, value] of Object.entries(frameOf(root.getBoundingClientRect()))) root.style.setProperty(name, value); };
    write();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(write) : null;
    observer?.observe(root);
    window.addEventListener('resize', write);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', write);
      for (const name of FRAME) root.style.removeProperty(name);
    };
  }, [rootRef, open]);
}
