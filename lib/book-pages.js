/* source.pages { sourceId | documentId, from?, to?, offset?, hid?, course? } (docs/review-book-agent.md): a material's text by page number, small enough
   for a chat tool result: at most PAGES_SHOWN pages and PAGES_CHARS characters a call, the rest named in `next` (the same page from an offset when a
   page is longer than that). A document is the 资料 page's (lib/source-groups.js): a PDF's or a slide deck's pages, a recording's parts, a single text
   as page 1. The library's own lists (考点清单, 总纲, the 复习全书 itself) are not material and are refused. Pure: it returns what it showed in `reads`
   ([{ sourceId, from, to }]) for the op to record (lib/book-reading.js), and the result says nothing of them. */
import { groupSourcesByDocument } from './source-groups.js';
import { oneLine } from './book-agent-view.js';

export const PAGES_SHOWN = 4, PAGES_CHARS = 6000, RESULT_CHARS = 7600;
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };

/** The document a call names: by documentId (the 资料 page's id, else its key) or by the id of one of its pages. */
function documentOf(state, args) {
  const items = groupSourcesByDocument(state.sources || [], { documents: state.documents });
  if (typeof args.documentId === 'string' && args.documentId) {
    const item = items.find(entry => entry.documentId === args.documentId || entry.key === args.documentId);
    if (!item) fail('没有这份资料（考点清单、总纲和复习全书本身不是资料） / No material of this documentId (the library\'s own lists and the review book are not material)', 'source-pages-missing');
    return item;
  }
  if (typeof args.sourceId === 'string' && args.sourceId) {
    const item = items.find(entry => entry.sourceIds.includes(args.sourceId));
    if (!item) fail('没有这份资料（考点清单、总纲和复习全书本身不是资料） / No material of this sourceId (the library\'s own lists and the review book are not material)', 'source-pages-missing');
    return item;
  }
  return fail('source.pages needs sourceId or documentId', 'source-pages-target');
}

/** source.pages (see the top of this file) -> { result, reads }. */
export function sourcePages(state, args = {}) {
  const item = documentOf(state, args), byId = new Map((state.sources || []).map(source => [source.id, source]));
  const pages = item.pages.filter(page => typeof byId.get(page.sourceId)?.text === 'string');
  if (!pages.length) fail('这份资料没有可读的文字 / This material has no readable text', 'source-pages-empty');
  const named = typeof args.sourceId === 'string' ? pages.find(page => page.sourceId === args.sourceId) : null;
  const first = pages[0].page, last = pages[pages.length - 1].page;
  const from = Number.isInteger(args.from) ? Math.max(first, args.from) : named ? named.page : first;
  const to = Math.min(Number.isInteger(args.to) ? Math.max(from, args.to) : from + PAGES_SHOWN - 1, from + PAGES_SHOWN - 1);
  const chosen = pages.filter(page => page.page >= from && page.page <= to);
  if (!chosen.length) fail(`这份资料的页码是 ${first}–${last} / This material's pages are ${first}-${last}`, 'source-pages-range');
  const fit = budget => {
    const shown = [], reads = [];
    let left = budget, next = null;
    for (const [at, page] of chosen.entries()) {
      const text = byId.get(page.sourceId).text, start = at === 0 && Number.isInteger(args.offset) ? Math.min(Math.max(0, args.offset), text.length) : 0;
      if (left <= 0) { next = { from: page.page }; break; }
      const part = text.slice(start, start + left);
      shown.push({ page: page.page, sourceId: page.sourceId, chars: text.length, ...(start ? { offset: start } : {}), text: part });
      if (part.length) reads.push({ sourceId: page.sourceId, from: start, to: start + part.length });
      left -= part.length;
      if (start + part.length < text.length) { next = { from: page.page, offset: start + part.length }; break; }
    }
    if (!next && chosen[chosen.length - 1].page < last) next = { from: pages.find(page => page.page > chosen[chosen.length - 1].page).page };
    const result = { documentId: item.documentId || item.key, title: oneLine(item.title, 80), pages: `${first}-${last}`, shown, ...(next ? { next } : { end: true }) };
    return { result, reads };
  };
  // The text is at most PAGES_CHARS; a text full of characters JSON escapes is shown shorter, so the whole result stays under RESULT_CHARS.
  let budget = PAGES_CHARS, done = fit(budget);
  while (JSON.stringify(done.result).length > RESULT_CHARS && budget > 500) { budget = Math.floor(budget * 0.8); done = fit(budget); }
  return done;
}
