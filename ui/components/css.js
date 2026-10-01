import { useInsertionEffect } from 'react';

/* Inject the component stylesheet once per document. useInsertionEffect runs
   before layout effects, so a Dialog that calls showModal() in its layout
   effect is already styled on its first frame. In the standalone preview the
   CSS is bundled into app.css instead and `css` is not a string. */
export function useComponentCss(css, marker = 'study-components') {
  useInsertionEffect(() => {
    if (typeof css !== 'string' || typeof document === 'undefined') return;
    let element = document.head.querySelector(`style[data-${marker}]`);
    if (element?.textContent === css) return;
    if (!element) {
      element = document.createElement('style');
      element.setAttribute(`data-${marker}`, '');
      document.head.appendChild(element);
    }
    element.textContent = css;
  }, [css, marker]);
}

export const cx = (...names) => names.filter(Boolean).join(' ');
