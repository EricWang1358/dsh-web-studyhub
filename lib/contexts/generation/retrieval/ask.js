import { narrowSources, retrieveFromPort } from '../../../retrieval.js';

/* One question to the chosen search provider over some pages of the library, mapped to those pages (lib/retrieval.js resolveHits, narrowSources):
   retrieval.preview and retrieval.test ask it, and so does book.search (./book-search.js). No new search code: the provider answers, the mapping
   is the library's own. */

/** The text sent after narrowing (two author chunks). */
export const RETRIEVAL_BUDGET_CHARS = 120_000;
export const RETRIEVE_TIMEOUT_MS = 30_000;

const clip = (value, length) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > length ? `${text.slice(0, length)}…` : text; };

/**
 * Ask `settings`' provider through `port` for `query` within `sources`. Resolves null when no provider is chosen or there is no port, else
 * { provider, query, hits, unresolved, truncated, chars, pages: [{ sourceId, title, page, score, snippet }] in reading order }.
 * `budgetChars`: how much text the pages kept may hold together (the first is always kept).
 */
export async function askPages(port, settings, sources, query, { course, limit, budgetChars = RETRIEVAL_BUDGET_CHARS } = {}) {
  const result = await retrieveFromPort(port, settings, { query, sources, course, limit, signal: AbortSignal.timeout(RETRIEVE_TIMEOUT_MS) });
  if (!result) return null;
  const narrowed = narrowSources(sources, result.passages, { budgetChars });
  const text = new Map(result.passages.map(passage => [passage.sourceId, passage.text]));
  const bySource = new Map(sources.map(source => [source.id, source]));
  return { provider: result.provider, query, hits: result.hits, unresolved: result.unresolved, truncated: narrowed.truncated, chars: narrowed.chars,
    pages: narrowed.pages.map(page => ({ ...page, snippet: clip(text.get(page.sourceId) || bySource.get(page.sourceId)?.text, 160) })) };
}
