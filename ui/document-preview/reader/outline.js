/* The reader's outline (目录): where its entries come from, which one is current
   for a scroll position, the neighbours for the previous / next links, and how
   far the reader has read. Entries are { id, level, title, page? }; an element in the
   reading column carries the matching data-outline-id. A page's label ("第 3 页") is
   made when it is drawn, so it follows the interface language. */

/** Entries for the reading sections of text sources; none when there is nothing to navigate. */
export function outlineFromSections(sections) {
  if (sections.length < 2) return [];
  return sections.map(section => ({ id: section.id, level: 1,
    title: section.kind === 'page' ? section.heading : section.title, ...(section.page ? { page: section.page } : {}) }))
    .filter(entry => entry.page || entry.title);
}

const levelOf = node => Number(node.tagName[1]);

/**
 * Entries for the headings (h1–h4) of rendered Markdown or HTML; tags each heading with
 * data-outline-id. Levels are relative to the shallowest heading, so a document that
 * starts at h2 still lists its top headings at level 1.
 */
export function collectHeadings(root, { max = 400 } = {}) {
  if (!root) return [];
  const nodes = [...root.querySelectorAll('h1,h2,h3,h4')].filter(node => !node.closest('[data-study-marker]') && node.textContent.trim());
  const base = nodes.length ? Math.min(...nodes.map(levelOf)) : 1;
  return nodes.slice(0, max).map((node, index) => {
    const id = `h-${index}`;
    node.dataset.outlineId = id;
    return { id, level: levelOf(node) - base + 1, title: node.textContent.trim().replace(/\s+/g, ' ') };
  });
}

/**
 * The current entry: the last one whose top edge has reached `threshold` pixels below the
 * top of the reading area; before the first heading, the first entry.
 * entries: [{ id, top }] in document order.
 */
export function pickActive(entries, threshold = 24) {
  let active = entries[0]?.id ?? null;
  for (const entry of entries) {
    if (entry.top <= threshold) active = entry.id;
    else break;
  }
  return active;
}

export function neighbours(items, id) {
  const index = items.findIndex(item => item.id === id);
  return { previous: index > 0 ? items[index - 1] : null, next: index >= 0 && index < items.length - 1 ? items[index + 1] : null };
}

/** 0..1 for how far a scroll area has been scrolled; 0 when it all fits. */
export function readingProgress({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 } = {}) {
  const range = scrollHeight - clientHeight;
  return range > 0 ? Math.min(1, Math.max(0, scrollTop / range)) : 0;
}
