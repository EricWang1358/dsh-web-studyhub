/* The focus after an arrival (#1679). The page the learner goes to may not be there yet: it loads its code, or reads its first data, before it has a
   heading. find() gives the element to focus, or nothing yet; focus(element) takes it there. The wait ends once that is done, after a while, or as soon
   as the focus is put somewhere else (by the learner, or by the page itself, which then keeps it). Returns what cancels the wait. */
export const ARRIVAL_WAIT_MS = 8000;

export function focusOnArrival(root, find, focus, { timeoutMs = ARRIVAL_WAIT_MS } = {}) {
  let observer = null, timer = 0;
  const stop = () => { observer?.disconnect(); observer = null; clearTimeout(timer); };
  const frame = requestAnimationFrame(() => {
    const target = find();
    if (target) { focus(target); return; }
    if (!root || typeof MutationObserver !== 'function') return;
    const doc = root.ownerDocument, held = doc.activeElement;
    observer = new MutationObserver(() => {
      const now = doc.activeElement;
      if (now && now !== held && now !== doc.body) { stop(); return; }
      const found = find();
      if (found) { stop(); focus(found); }
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
    timer = setTimeout(stop, timeoutMs);
  });
  return () => { cancelAnimationFrame(frame); stop(); };
}
