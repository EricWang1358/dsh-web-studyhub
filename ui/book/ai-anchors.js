import { useLayoutEffect } from 'react';
import { ui } from '../i18n.js';
import { anchorSegments } from '../../lib/course-book-ai-anchor.js';

/* The dashed words of an AI block (复习全书 M4): after a paragraph of the book is drawn, the words each block is about get a dashed underline (a span, so it
   can be focused and pressed), found in the rendered text (lib/course-book-ai-anchor.js). A click goes to the block, a click on the block's 关于：「…」 comes
   back. Nothing here writes to the book; words that are not found, or sit in a link, a button or a formula, stay as they were. The caller draws the
   paragraph again (a new React key) whenever its words or its anchors change, so the spans are only ever put on fresh text. */

const SKIP = '.md-cite, .katex, .katex-mathml, script, style';
const LIVE = 'a, button, code, input, textarea, select, [role="button"]';
const FLASH_MS = 1800;

const wordsOf = id => [...document.querySelectorAll('.book-ai-anchor')].filter(span => span.dataset.aiIds.split(' ').includes(id));
const blockOf = id => [...document.querySelectorAll('[data-ai-block]')].find(element => element.dataset.aiBlock === id) || null;

/** Mark the words of `anchors` ([{ id, quote }]) inside `root`. -> { found: [ids marked], undo() } (undo puts the text back as it was). */
export function wrapAnchors(root, anchors) {
  const undo = [], found = new Set();
  if (!root || !anchors?.length) return { found: [], undo: () => {} };
  const doc = root.ownerDocument, walker = doc.createTreeWalker(root, 4), nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest(SKIP)) nodes.push(node);
  const pieces = [];
  for (const group of anchorSegments(nodes.map(node => node.data), anchors)) {
    const usable = group.pieces.filter(piece => !nodes[piece.index].parentElement?.closest(LIVE));
    usable.forEach((piece, at) => pieces.push({ ...piece, ids: group.ids.join(' '), first: at === 0 }));
    if (usable.length) group.ids.forEach(id => found.add(id));
  }
  // Last piece first, so the text before it keeps its offsets; the node React drew stays where it is and keeps the text before the words.
  pieces.sort((a, b) => b.index - a.index || b.from - a.from);
  const cuts = new Map();
  for (const piece of pieces) {
    const node = nodes[piece.index];
    if (!cuts.has(node)) cuts.set(node, { orig: node.data, end: node.data.length, made: [] });
    const cut = cuts.get(node), span = doc.createElement('span');
    span.className = 'book-ai-anchor';
    span.dataset.aiIds = piece.ids;
    if (piece.first) { span.tabIndex = 0; span.setAttribute('role', 'button'); span.setAttribute('aria-label', ui('查看 AI 解释')); }
    span.textContent = cut.orig.slice(piece.from, piece.to);
    node.data = cut.orig.slice(0, piece.from);
    node.after(span);
    cut.made.push(span);
    if (piece.to < cut.end) { const rest = doc.createTextNode(cut.orig.slice(piece.to, cut.end)); span.after(rest); cut.made.push(rest); }
    cut.end = piece.from;
  }
  for (const [node, cut] of cuts) {
    const kept = node.data;
    undo.push(() => { if (node.data === kept) { cut.made.forEach(made => made.remove()); node.data = cut.orig; } });
  }
  return { found: [...found], undo: () => undo.forEach(run => run()) };
}

/** A block's words in a paragraph: the dashed words of `rootRef`, a press (or Enter / Space) opens the block (`onOpen(id)`); `onFound(ids)` says which blocks
    have their words marked. `signature` changes whenever the words or the anchors do. */
export function useAiAnchors(rootRef, anchors, signature, { onOpen, onFound }) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !anchors.length) { onFound?.([]); return undefined; }
    let marked = { found: [], undo: () => {} };
    try { marked = wrapAnchors(root, anchors); } catch { marked = { found: [], undo: () => {} }; }
    onFound?.(marked.found);
    const open = event => {
      const span = event.target?.closest?.('.book-ai-anchor');
      if (!span || !root.contains(span) || event.target.closest('a, button')) return;
      if (event.type === 'keydown') { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); }
      else if (window.getSelection?.()?.toString()) return;
      onOpen?.(span.dataset.aiIds.split(' ')[0]);
    };
    root.addEventListener('click', open);
    root.addEventListener('keydown', open);
    return () => { root.removeEventListener('click', open); root.removeEventListener('keydown', open); marked.undo(); };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A short highlight on `elements` (data-ai-flash, drawn by book.css). */
export function flash(elements) {
  elements.forEach(element => element.setAttribute('data-ai-flash', ''));
  setTimeout(() => elements.forEach(element => element.removeAttribute('data-ai-flash')), FLASH_MS);
}

/** From the dashed words to their block: scrolled to, flashed, its toggle focused. Run after the block was opened (the page draws it first). */
export function showBlock(id) {
  const block = blockOf(id);
  if (!block) return false;
  block.scrollIntoView({ block: 'center' });
  flash([block]);
  block.querySelector('.book-ai__toggle')?.focus({ preventScroll: true });
  return true;
}

/** From a block's 关于：「…」 back to its dashed words. False when the words are not marked (the paragraph changed). */
export function showWords(id) {
  const spans = wordsOf(id);
  if (!spans.length) return false;
  spans[0].scrollIntoView({ block: 'center' });
  flash(spans);
  spans[0].focus({ preventScroll: true });
  return true;
}
