/* global document, getComputedStyle */
/* The layout audit of the MinerU UI, run inside the page by scripts/qa/mineru-shots.mjs through Playwright's `evaluate`.
   It reads the real computed layout (getBoundingClientRect), not a screenshot:
   - overlap: no two blocks of a card may cover each other (a block is not an ancestor/descendant of the other);
   - gap: no vertical gap larger than `maxGap` px between neighbouring blocks that share a column (a stretched grid row, an
     empty element with a min-height, ... all show up as one big gap);
   - spill: no block may stick out of its card, to the sides or at the bottom;
   - balance: the cards of one row are reported with their heights (equal heights are fine, the content must not be stretched).
   The function is serialised into the page, so it must not use anything from this module's scope. */

/** @param {{ scopes?: string[], maxGap?: number, tolerance?: number }} [options] @returns {{ problems: string[], cards: object[] }} */
export function layoutAudit({ scopes = ['.audio-provider-card', '.mineru-route-panel', '.pdf-history'], maxGap = 48, tolerance = 2 } = {}) {
  const problems = [], cards = [];
  const label = element => {
    const own = [...element.classList].filter(name => !/^is-/.test(name)).slice(0, 2).join('.');
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28);
    return `${element.tagName.toLowerCase()}${own ? `.${own}` : ''}${text ? ` "${text}"` : ''}`;
  };
  const visible = element => {
    // What sits inside a closed <details> (other than its summary) is not shown, whatever boxes the browser keeps for it.
    const closed = element.closest('details:not([open])');
    if (closed && closed !== element && !element.closest('summary')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !element.classList.contains('sh-visually-hidden');
  };
  // A block: anything laid out as a box of its own (not inline text styling), so a flex/grid item counts, a <strong> does not.
  const isBlock = element => {
    const style = getComputedStyle(element);
    return !['inline', 'contents'].includes(style.display) || element.parentElement && /flex|grid/.test(getComputedStyle(element.parentElement).display);
  };
  const blocksIn = card => [...card.querySelectorAll('*')].filter(element => !element.closest('svg') && element.tagName !== 'SVG' && visible(element) && isBlock(element) && !['OPTION', 'LEGEND'].includes(element.tagName));
  const overlapOf = (a, b) => ({ dx: Math.min(a.right, b.right) - Math.max(a.left, b.left), dy: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) });

  for (const card of document.querySelectorAll(scopes.join(','))) {
    if (!visible(card)) continue;
    const box = card.getBoundingClientRect();
    cards.push({ name: label(card), top: Math.round(box.top), height: Math.round(box.height), width: Math.round(box.width) });
    const blocks = blocksIn(card);
    // 1. overlap: only the innermost pair is reported (when two boxes overlap, so do the boxes around them)
    const crossings = [];
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const [a, b] = [blocks[i], blocks[j]];
      if (a.contains(b) || b.contains(a)) continue;
      const { dx, dy } = overlapOf(a.getBoundingClientRect(), b.getBoundingClientRect());
      if (dx > tolerance && dy > tolerance) crossings.push({ a, b, dy });
    }
    const within = (inner, outer) => outer.contains(inner);
    for (const { a, b, dy } of crossings)
      if (!crossings.some(other => other.a !== a || other.b !== b ? (within(other.a, a) && within(other.b, b) || within(other.a, b) && within(other.b, a)) : false)) problems.push(`overlap ${Math.round(dy)}px: ${label(a)}  x  ${label(b)}`);
    // 2. spill out of the card
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      if (rect.right > box.right + tolerance || rect.left < box.left - tolerance || rect.bottom > box.bottom + tolerance) problems.push(`spills out of ${label(card)}: ${label(block)} (${Math.round(rect.bottom - box.bottom)}px below, ${Math.round(rect.right - box.right)}px right)`);
    }
    // 3a. stretched blocks: a block much taller than what is inside it (a grid row stretched to its neighbour's height, an empty
    //     element with a min-height, ...) shows as a blank band even when no two blocks are apart.
    for (const block of blocks) {
      if (['INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'CANVAS', 'PROGRESS', 'HR'].includes(block.tagName)) continue;
      const range = document.createRange();
      range.selectNodeContents(block);
      const inner = range.getBoundingClientRect(), outer = block.getBoundingClientRect(), style = getComputedStyle(block);
      const padding = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
      const slack = outer.height - (inner.height || 0) - padding;
      if (slack > maxGap) problems.push(`blank band ${Math.round(slack)}px (> ${maxGap}) inside ${label(block)}: the block is ${Math.round(outer.height)}px tall, its content ${Math.round(inner.height || 0)}px`);
    }
    // 3b. gaps between neighbours that share a column (the card itself and every block with two or more block children)
    for (const parent of [card, ...blocks]) {
      const kids = [...parent.children].filter(child => visible(child) && isBlock(child) && getComputedStyle(child).position !== 'absolute')
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      for (let i = 1; i < kids.length; i++) {
        const [above, below] = [kids[i - 1].getBoundingClientRect(), kids[i].getBoundingClientRect()];
        const sharesColumn = Math.min(above.right, below.right) - Math.max(above.left, below.left) > tolerance;
        const gap = below.top - above.bottom;
        if (sharesColumn && gap > maxGap) problems.push(`gap ${Math.round(gap)}px (> ${maxGap}) in ${label(parent)}: between ${label(kids[i - 1])} and ${label(kids[i])}`);
      }
    }
  }
  // 4. balance: report the cards that sit side by side
  const rows = new Map();
  for (const card of cards) rows.set(card.top, [...(rows.get(card.top) || []), card]);
  for (const row of rows.values()) if (row.length > 1 && new Set(row.map(card => card.height)).size > 1) problems.push(`unequal card heights in one row: ${row.map(card => `${card.name}=${card.height}px`).join(' | ')}`);
  return { problems, cards };
}
