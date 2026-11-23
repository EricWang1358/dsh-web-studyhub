/* The custom highlights the page has now, said on the elements their rules start at.

   Every ::highlight(name) rule of the reader, the book and the practice page matches each element under its holder
   (`.reader-page :not(.katex, .katex *)::highlight(name)`: WebKit has no highlight inheritance, and each element keeps its own tokens). For every such
   rule that matches an element the browser resolves one more style for it, whether or not that highlight exists: with the reader's 17 rules, drawing a
   chapter of 800 elements was 14,000 style resolutions (about 200 ms) for highlights that were not there, on every chapter and every source opened
   beside a question. So each rule also asks for its own name in `data-highlights` on its holder, and this module keeps that attribute equal to the
   names the registry holds for that holder. Every write to the registry goes through studyHighlights(), so the two cannot drift
   (tests/highlight-gate.test.mjs holds both halves: the rules and the writers).

   A change of the attribute restyles everything under the holder it is on, so two things keep it still. Each holder lists only the families its own
   rules ask for: a word marked in a question is none of the reader's business, and the chapter beside the question is not restyled for it. And the
   writes of one turn are brought to the holders once, after them: a layer that is painted again takes all its names out and puts them back, which
   leaves the attribute as it was and writes nothing. */

export const HIGHLIGHT_GATE = 'data-highlights';
/** The elements a gated ::highlight() rule starts at, each with the families of names its rules ask for (`study-find` is study-find and study-find-*).
 *  A holder is drawn before the highlights inside it are registered, so the write that registers them marks it. */
export const HIGHLIGHT_HOLDERS = Object.freeze({
  '.reader-page': ['study-find', 'study-link', 'study-mark'],
  '.book-page': ['study-find'],
  '.review-body': ['study-term'],
});
/** Highlights whose rule is not gated, so no holder lists them. The quote a source is opened at: nearly every material opened beside a question has one,
 *  so its rule is always on under the viewer and marking a quote restyles nothing. */
export const UNGATED_HIGHLIGHTS = { 'study-source-quote': '.study-document-viewer' };

export const highlightsSupported = () => typeof window !== 'undefined' && !!window.CSS?.highlights && typeof window.Highlight === 'function';

const inFamily = (name, families) => families.some(family => name === family || name.startsWith(`${family}-`));
/** The registry's names of these families as the attribute lists them: sorted, one space apart. */
export const gateValue = (registry, families) => [...registry.keys()].filter(name => inFamily(name, families)).sort().join(' ');

/** Write on every holder of `doc` the names the registry has for it (only where they changed: an attribute written again restyles what is under it). */
export function syncHighlightGate(registry = highlightsSupported() ? window.CSS.highlights : null, doc = typeof document === 'undefined' ? null : document) {
  if (!registry || !doc) return;
  for (const [selector, families] of Object.entries(HIGHLIGHT_HOLDERS)) {
    const value = gateValue(registry, families);
    for (const holder of doc.querySelectorAll(selector)) {
      if ((holder.getAttribute(HIGHLIGHT_GATE) || '') === value) continue;
      if (value) holder.setAttribute(HIGHLIGHT_GATE, value);
      else holder.removeAttribute(HIGHLIGHT_GATE);
    }
  }
}

const waiting = new WeakSet();
/** A registry whose sets and deletes bring the holders in step: once for all the writes of a turn, before the browser draws (a microtask). */
export function gatedRegistry(registry, doc, defer = queueMicrotask) {
  const later = () => {
    if (waiting.has(registry)) return;
    waiting.add(registry);
    defer(() => { waiting.delete(registry); syncHighlightGate(registry, doc); });
  };
  return {
    set(name, highlight) { registry.set(name, highlight); later(); },
    delete(name) { const had = registry.delete(name); later(); return had; },
    get: name => registry.get(name),
    has: name => registry.has(name),
  };
}

/** The page's highlight registry, gated; null where the browser has no custom highlights. The only way the panel writes a highlight. */
export const studyHighlights = () => (highlightsSupported() ? gatedRegistry(window.CSS.highlights) : null);
