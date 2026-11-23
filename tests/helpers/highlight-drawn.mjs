/* global CSS, getComputedStyle */

/** Whether the custom highlight `name` is drawn: it holds a range, and its ::highlight() rule reaches the element the first range starts in. The registry
 *  alone says a highlight exists, not that the page draws it: each rule also asks for its name on its holder (ui/highlight-gate.js), so a highlight written
 *  around the gate would be registered and invisible. */
export const highlightDrawn = (page, name) => page.evaluate(key => {
  const range = [...(CSS.highlights.get(key) || [])][0];
  if (!range) return false;
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const style = getComputedStyle(node, `::highlight(${key})`);
  return style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.textDecorationLine !== 'none' || style.textShadow !== 'none';
}, name);
