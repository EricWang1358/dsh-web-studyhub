/* global document, window */
/** Inspect visible content and the actual page scroller. Hidden measurement copies can have offscreen boxes. */
export function viewportOverflow(page, scope) {
  return page.evaluate(selector => {
    const width = window.innerWidth;
    const wide = [...document.querySelectorAll(selector)].filter(element => {
      if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > width + 1;
    }).map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
    const scroller = document.querySelector('.study-app');
    const doc = Math.max(document.documentElement.scrollWidth - width, scroller ? scroller.scrollWidth - scroller.clientWidth : 0);
    return { doc, wide };
  }, scope);
}
