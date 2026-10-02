import { openPdfDocument } from '../../documents.js';
import { pageText } from '../../pdf-text.js';
import { projectDocument } from './files.js';
import { normalizedRanges } from './positions.js';

/* Is this file the document the stored text came from? Decided without a model: extract the same text the importer
   would, fold whitespace the way citations are matched (a CJK hard line break must not count as a difference), and
   compare. The stored text is only ever read. */

/** A page or section matches when at least this share of its text is the same. */
export const PAGE_MATCH = 0.9;
/** A file is accepted without a confirmation when its page count matches and this share of the checked pages match. */
export const ACCEPT_SHARE = 0.9;
/** At most this many pages are compared; a longer book is sampled evenly (always including its first and last page). */
export const MAX_CHECKED = 120;
const REPORTED = 20;

/** Text as it is compared: width and case folded, every run of whitespace removed (what the citation matcher ignores). */
export const compareText = text => normalizedRanges(String(text ?? '').normalize('NFKC').toLowerCase()).value.replaceAll(' ', '');

function bigrams(text) {
  const counts = new Map();
  for (let index = 0; index + 1 < text.length; index++) { const key = text.slice(index, index + 2); counts.set(key, (counts.get(key) || 0) + 1); }
  return counts;
}

/** Share of equal text, 0..1 (Dice coefficient over character pairs of the folded texts). */
export function textSimilarity(a, b) {
  const left = compareText(a), right = compareText(b);
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const counts = bigrams(left); let shared = 0;
  for (let index = 0; index + 1 < right.length; index++) {
    const key = right.slice(index, index + 2), have = counts.get(key);
    if (have) { shared++; counts.set(key, have - 1); }
  }
  return (2 * shared) / (left.length + right.length - 2);
}

/** Up to `limit` of `items`, evenly spread, keeping the first and the last. */
function sample(items, limit) {
  if (items.length <= limit) return items;
  const picked = new Set();
  for (let index = 0; index < limit; index++) picked.add(Math.round((index * (items.length - 1)) / (limit - 1)));
  return [...picked].map(index => items[index]);
}

const round = value => Math.round(value * 1000) / 1000;
const finish = ({ pages, results }) => {
  const checked = results.length, matched = results.filter(item => item.similarity >= PAGE_MATCH).length;
  const similarity = checked ? round(results.reduce((total, item) => total + item.similarity, 0) / checked) : 0;
  const reasons = [];
  if (!pages.match) reasons.unshift('page-count');
  if (checked && matched / checked < ACCEPT_SHARE) reasons.push('text');
  const accepted = pages.match && !reasons.includes('text');
  return { verdict: accepted ? 'match' : 'mismatch', accepted, pages, checked, matched, similarity,
    mismatchedPages: results.filter(item => item.similarity < PAGE_MATCH).map(item => item.page).slice(0, REPORTED), reasons };
};

/** Pages of the stored text: [{ page, text }] in page order, and the page count the document had when it was imported. */
function storedPages(sources) {
  const paged = sources.filter(source => source.document?.page).map(source => ({ page: source.document.page, text: source.text || '' })).sort((a, b) => a.page - b.page);
  const total = Math.max(0, ...sources.map(source => source.document?.totalPages || 0), ...paged.map(item => item.page));
  return { paged, total };
}

async function verifyPdf(bytes, sources) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('The file is not a valid PDF');
  const { paged, total } = storedPages(sources);
  const loading = await openPdfDocument(bytes);
  try {
    const pdf = await loading.promise;
    const pages = { stored: total, supplied: pdf.numPages, match: total === pdf.numPages };
    const results = [];
    for (const stored of sample(paged, MAX_CHECKED)) {
      if (stored.page > pdf.numPages) { results.push({ page: stored.page, similarity: 0 }); continue; }
      const page = await pdf.getPage(stored.page);
      const { text } = pageText((await page.getTextContent()).items, page.getViewport({ scale: 1 }));
      page.cleanup();
      results.push({ page: stored.page, similarity: textSimilarity(stored.text, text) });
    }
    return finish({ pages, results });
  } finally { await loading.destroy(); }
}

async function verifySections(bytes, format, filename, sources) {
  const projection = await projectDocument(bytes, { format, filename });
  const supplied = projection.sources.map(source => source.text), stored = sources.map(source => source.text || '');
  const pages = { stored: stored.length, supplied: supplied.length, match: stored.length === supplied.length };
  const results = pages.match ? stored.map((text, index) => ({ page: index + 1, similarity: textSimilarity(text, supplied[index]) }))
    : [{ page: 1, similarity: textSimilarity(stored.join('\n'), supplied.join('\n')) }];
  return finish({ pages, results });
}

/**
 * Compare the supplied file (its bytes) with the stored text of a document revision.
 * hash: the file's SHA-256; knownHashes: file hashes that are certainly the same document (its retained copy, the hash the
 * revision was made from, the file id a PDF's pages carry). Resolves the report the UI shows.
 */
export async function verifyOriginal({ bytes, hash, format, filename, sources, knownHashes = [] }) {
  const { total } = storedPages(sources);
  if (knownHashes.includes(hash))
    return { verdict: 'identical', accepted: true, pages: { stored: total || sources.length, supplied: total || sources.length, match: true }, checked: 0, matched: 0, similarity: 1, mismatchedPages: [], reasons: [] };
  const report = format === 'pdf' ? await verifyPdf(bytes, sources) : await verifySections(bytes, format, filename, sources);
  return report;
}
