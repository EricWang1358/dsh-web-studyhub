import { readZip } from './office/zip.js';

/* Reading MinerU's result archive and putting the pieces of a book back together (cloud conversion).
   The target is the one format the importer already reads, MinerU's content_list (lib/converted-document.js):
   the flat v1 list whose items carry a 0-based `page_idx`, or the v2 list of pages. Each piece counts its pages from 0;
   merging moves them to their place in the book. Images are not kept: StudyHub imports the text and the captions only
   (the importer drops the pictures), so only their names are prefixed per piece, to stay unique in the merged list. */

export class MineruResultError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'MineruResultError'; this.code = code; Object.assign(this, extra); }
}

const MB = 1024 * 1024;
const V1 = /(?:^|\/)(?:[^/]*_)?content_list\.json$/i;
const V2 = /(?:^|\/)(?:[^/]*_)?content_list_v2\.json$/i;

/**
 * The content list inside a MinerU result archive: { format: 'v1' | 'v2', content, images: [names] }.
 * The flat v1 list (content_list.json or <name>_content_list.json) is preferred over content_list_v2.json.
 */
export function readResultZip(bytes) {
  let zip;
  try { zip = readZip(bytes, { maxEntryBytes: 512 * MB, maxReadBytes: 1024 * MB, maxTotalBytes: 4096 * MB, maxEntries: 200_000 }); }
  catch { throw new MineruResultError('bad-archive', 'MinerU 返回的解析结果打不开（压缩包不完整）。请重试这一段。'); }
  const names = zip.names();
  const pick = pattern => names.filter(name => pattern.test(name)).sort((a, b) => a.length - b.length)[0];
  const v1 = pick(V1), v2 = v1 ? undefined : pick(V2), name = v1 ?? v2;
  if (!name) throw new MineruResultError('no-content-list', 'MinerU 的解析结果里没有带页码的文字清单（content_list.json），没法按页保存。请重试这一段。');
  let content;
  try { content = JSON.parse(zip.text(name)); } catch { throw new MineruResultError('bad-content-list', 'MinerU 的解析结果读不出来（content_list.json 不是有效的 JSON）。请重试这一段。'); }
  if (!Array.isArray(content)) throw new MineruResultError('bad-content-list', 'MinerU 的解析结果读不出来（content_list.json 的格式不对）。请重试这一段。');
  return { format: v1 ? 'v1' : 'v2', content, images: names.filter(entry => /(?:^|\/)images\/[^/]+$/i.test(entry)) };
}

const range = (from, to) => (from === to ? `${from}` : `${from}–${to}`);
const prefixImage = (value, prefix) => (typeof value === 'string' && /^images\//i.test(value) ? `${prefix}/${value}` : value);

function prefixDeep(value, prefix) {
  if (Array.isArray(value)) return value.map(entry => prefixDeep(entry, prefix));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = (key === 'img_path' || key === 'path') ? prefixImage(entry, prefix) : prefixDeep(entry, prefix);
    return copy;
  }
  return value;
}

/**
 * One content list of the whole book. chunks: [{ index, startPage, endPage, format, content }] (1-based, inclusive, in the
 * original book); `totalPages` is the page count of the original PDF. Resolves { format, content, pages, warnings }.
 * Throws MineruResultError: missing-chunk (names the pages without a result), bad-plan (overlap), mixed-formats,
 * page-mismatch (a piece reports a page outside its own range).
 */
export function mergeChunkResults({ totalPages, chunks }) {
  const ordered = [...chunks].sort((a, b) => a.startPage - b.startPage);
  let expected = 1;
  for (const piece of ordered) {
    if (!(piece.endPage >= piece.startPage) || piece.startPage < expected) throw new MineruResultError('bad-plan', `PDF 的分段重叠了（第 ${range(piece.startPage, piece.endPage)} 页），没法合并。`);
    if (piece.startPage > expected) throw new MineruResultError('missing-chunk', `缺少第 ${range(expected, piece.startPage - 1)} 页的解析结果，没法合并成整本书。请重试没完成的分段。`, { pages: range(expected, piece.startPage - 1) });
    expected = piece.endPage + 1;
  }
  if (expected - 1 < totalPages) throw new MineruResultError('missing-chunk', `缺少第 ${range(expected, totalPages)} 页的解析结果，没法合并成整本书。请重试没完成的分段。`, { pages: range(expected, totalPages) });
  if (expected - 1 > totalPages) throw new MineruResultError('bad-plan', `分段超出了这个 PDF 的页数（共 ${totalPages} 页）。`);
  const formats = new Set(ordered.map(piece => piece.format));
  if (formats.size > 1) throw new MineruResultError('mixed-formats', '各段的解析结果格式不一致，没法合并。请重试这本书。');
  const format = ordered[0]?.format ?? 'v1';
  const outOfRange = piece => new MineruResultError('page-mismatch', `第 ${range(piece.startPage, piece.endPage)} 页这一段的解析结果里出现了超出这一段页数的页码，没法合并。请重试这一段。`);
  const warnings = [];

  if (format === 'v2') {
    const pages = Array.from({ length: totalPages }, () => []);
    for (const piece of ordered) {
      const length = piece.endPage - piece.startPage + 1;
      if (!Array.isArray(piece.content) || piece.content.length > length) throw outOfRange(piece);
      piece.content.forEach((page, offset) => { pages[piece.startPage - 1 + offset] = prefixDeep(Array.isArray(page) ? page : [], `c${piece.index + 1}`); });
    }
    return { format, content: pages, pages: totalPages, warnings };
  }

  const items = [];
  let highest = -1;
  for (const piece of ordered) {
    const length = piece.endPage - piece.startPage + 1, offset = piece.startPage - 1, prefix = `c${piece.index + 1}`;
    for (const item of Array.isArray(piece.content) ? piece.content : []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const index = Number(item.page_idx);
      if (!Number.isInteger(index) || index < 0) continue;
      if (index >= length) throw outOfRange(piece);
      const copy = { ...item, page_idx: index + offset };
      if (typeof copy.img_path === 'string') copy.img_path = prefixImage(copy.img_path, prefix);
      items.push(copy);
      highest = Math.max(highest, copy.page_idx);
    }
  }
  // The importer takes a book's length from its highest page_idx. An invisible marker on the last page keeps the original
  // page count when the final pages have no text (a blank page, a full-page picture); the importer drops this block type.
  if (highest < totalPages - 1) items.push({ type: 'discarded', text: '', page_idx: totalPages - 1, studyhub: 'page-count' });
  return { format, content: items, pages: totalPages, warnings };
}
