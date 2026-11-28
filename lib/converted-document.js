/* Converted documents (WP28): the output of a PDF-to-Markdown/JSON converter
   read as ONE paged document. Pure and synchronous (no I/O, no host), so the
   import hub and the backend share it.

   Supported shapes, each from the converter's own documentation:
   - Markdown with `<!-- page: N -->` markers (StudyHub's generic format; also
     what a script or an editor can add to any converter's Markdown);
   - Marker `--paginate_output` Markdown: a `{N}` + 48 dashes line starts page N
     (0-based);
   - MinerU content_list.json: v1 is a flat list whose items carry a 0-based
     `page_idx`; v2 is a list of pages, each a list of blocks;
   - Docling JSON (DoclingDocument): body tree in reading order, `prov[].page_no`
     is 1-based;
   - PaddleOCR JSON / JSONL (PP-StructureV3 / PaddleOCR-VL cloud API, web export,
     or per-page `parsing_res_list`): `layoutParsingResults` (wrapped in `result`
     or bare, single JSON or JSONL) or `parsing_res_list` page objects.
   Result: { converter, inputFormat, title, totalPages, pages: [{ page, text,
   chapter }], skippedPages, outline: [{ level, title, page, chapterTitle? }], chapters:
   [{ index, title, level, startPage, endPage }], warnings }. `chapter` is the
   index into `chapters` (-1: front matter before the first chapter). A
   converter that writes every heading at one level (MinerU: every title is
   `text_level: 1`) has its levels read from the titles' numbering
   (lib/heading-levels.js), so its chapters are its chapters, not its pages.
   Lines that repeat on a large share of the pages (a running header, an
   advertisement, the page numbers: lib/repeated-lines.js) are left out of the
   pages; a page that lost some carries them (`repeated`, to put back) and
   `repeated` ({ count, lines: [{ text, pages }] }) says what went, unless
   `keepRepeated`. */
import { inferHeadings } from './heading-levels.js';
import { dropRepeatedLines } from './repeated-lines.js';
import { isCodeComment } from './code-comment.js';

export class ConvertedDocumentError extends Error {
  constructor(code, message) { super(message); this.name = 'ConvertedDocumentError'; this.code = code; }
}

const PAGE_MARKER = /<!--\s*page\s*[:=]?\s*(\d+)\s*-->/gi;
const MARKER_LINE = /^\{(\d+)\}-{20,}[ \t]*$/gm;
const BOM = /^﻿/;

const clean = value => String(value ?? '').replace(/\r\n?/g, '\n');
const stemOf = filename => String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function parseJson(text) {
  const trimmed = String(text).replace(BOM, '').trimStart();
  if (trimmed[0] !== '[' && trimmed[0] !== '{') return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function isPaddleBlock(item) {
  return isObject(item) && typeof item.block_label === 'string' && (typeof item.block_content === 'string' || typeof item.text === 'string');
}

function isPaddleLayoutEntry(item) {
  return isObject(item) && (typeof item.markdown === 'string' || typeof item.markdown?.text === 'string'
    || Array.isArray(item.prunedResult?.parsing_res_list) || Array.isArray(item.parsing_res_list));
}

function paddleLayoutResults(value) {
  if (!isObject(value)) return null;
  const list = Array.isArray(value.layoutParsingResults) ? value.layoutParsingResults
    : Array.isArray(value.result?.layoutParsingResults) ? value.result.layoutParsingResults : null;
  if (!list) return null;
  return list.length === 0 || list.some(isPaddleLayoutEntry) ? list : null;
}

function paddlePageTarget(value) {
  if (!isObject(value)) return null;
  const target = isObject(value.res) && Array.isArray(value.res.parsing_res_list) ? value.res : value;
  if (!Array.isArray(target.parsing_res_list)) return null;
  return target.parsing_res_list.some(isPaddleBlock) || 'page_index' in target || 'input_path' in target ? target : null;
}

function isPaddleJsonValue(value) {
  if (paddleLayoutResults(value) !== null || paddlePageTarget(value) !== null) return true;
  return Array.isArray(value) && value.length > 0 && value.every(item => paddleLayoutResults(item) !== null || paddlePageTarget(item) !== null);
}

function parsePaddleJsonLines(text) {
  const trimmed = String(text ?? '').replace(BOM, '').trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('\n')) return null;
  const rows = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (rows.length < 2 || rows.some(line => !line.startsWith('{') || !line.endsWith('}'))) return null;
  const parsed = [];
  for (const line of rows) {
    let item;
    try { item = JSON.parse(line); } catch { return null; }
    if (!isPaddleJsonValue(item)) return null;
    parsed.push(item);
  }
  return parsed;
}

function jsonKind(value) {
  if (Array.isArray(value)) {
    if (value.some(item => isObject(item) && 'page_idx' in item && 'type' in item)) return 'mineru-content-list';
    if (value.length && value.every(Array.isArray) && value.some(page => page.some(block => isObject(block) && 'type' in block))) return 'mineru-content-list-v2';
    if (isPaddleJsonValue(value)) return 'paddleocr-json';
    return null;
  }
  if (isObject(value) && (value.schema_name === 'DoclingDocument' || (Array.isArray(value.texts) && isObject(value.body)))) return 'docling-json';
  if (isPaddleJsonValue(value)) return 'paddleocr-json';
  return null;
}

const countMatches = (text, pattern) => { pattern.lastIndex = 0; return [...String(text).matchAll(pattern)].length; };

/** 'page-markers' | 'marker-paginated' | 'mineru-content-list' | 'mineru-content-list-v2' | 'docling-json' | 'paddleocr-json' | null. */
export function detectConvertedFormat(input) {
  const text = String(input ?? '');
  const json = parseJson(text);
  if (json !== undefined) return jsonKind(json);
  if (parsePaddleJsonLines(text)) return 'paddleocr-json';
  if (countMatches(text, PAGE_MARKER)) return 'page-markers';
  if (countMatches(text, MARKER_LINE)) return 'marker-paginated';
  return null;
}

/** Whether a text file is a converter's JSON/JSONL output (MinerU, Docling or PaddleOCR) rather than a question deck. */
export function looksLikeConvertedJson(input) {
  const json = parseJson(input);
  if (json !== undefined) return jsonKind(json) !== null;
  return parsePaddleJsonLines(input) !== null;
}

/* ---------- text helpers ---------- */

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = value => String(value).replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => ENTITIES[entity]);
const stripTags = value => decode(String(value).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function markdownTable(rows) {
  const width = Math.max(0, ...rows.map(row => row.length));
  if (!width) return '';
  const line = row => `| ${Array.from({ length: width }, (_, index) => cell(row[index] ?? '')).join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

/** An HTML table (MinerU writes tables as HTML) as a Markdown table; other markup as plain text. */
export function htmlTableToMarkdown(html) {
  const rows = [...String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(item => stripTags(item[1])));
  const filled = rows.filter(row => row.some(Boolean));
  return filled.length ? markdownTable(filled) : stripTags(html);
}

/** Page text of a Markdown converter: images and layout noise out, HTML tables readable. Also counts stripped image tags. */
function cleanMarkdownWithMeta(text) {
  let imageCount = 0;
  const cleaned = clean(text)
    .replace(/<\/?(?:html|body)\b[^>]*>/gi, '')
    .replace(/<table\b[\s\S]*?<\/table>/gi, table => `\n${htmlTableToMarkdown(table)}\n`)
    .replace(/^[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*$/gm, () => { imageCount += 1; return ''; })
    .replace(/<img\b[^>]*>/gi, () => { imageCount += 1; return ''; })
    .replace(/<div\b[^>]*>\s*<\/div>/gi, '')
    .replace(/<div\b[^>]*style\s*=\s*["'][^"']*text-align\s*:[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, '$1')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, imageCount };
}

const withImageMeta = (entry, imageCount) => (imageCount > 0 ? { ...entry, hasImages: true, imageCount } : entry);

function outlineOf(pages) {
  // bodies: whether text follows each heading before the next one (contents written as headings have none).
  const outline = [], bodies = [];
  const followed = () => { if (bodies.length) bodies[bodies.length - 1] = true; };
  for (const { page, text } of pages) {
    let fenced = false, at = 0;
    for (const line of text.split('\n')) {
      const start = at; at += line.length + 1;
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; followed(); continue; }
      const heading = !fenced && /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
      if (heading && heading[2].trim() && !isCodeComment(text, start, start + line.length)) { outline.push({ level: heading[1].length, title: heading[2].trim(), page }); bodies.push(false); }
      else if (line.trim()) followed();
    }
  }
  // Every heading at one level says nothing of the structure: the numbering of the titles does (null: none, the levels stay). They count from that level.
  // A heading that opens a chapter under another name ("10 收入与支出", or a bare "17" before its title) carries that name (`chapterTitle`).
  const inferred = new Set(outline.map(entry => entry.level)).size === 1 ? inferHeadings(outline.map(entry => entry.title), { places: bodies.map(body => ({ body })) }) : null;
  return inferred ? outline.map((entry, at) => ({ ...entry, level: Math.min(6, outline[0].level + inferred.levels[at] - 1),
    ...(inferred.names.has(at) ? { chapterTitle: inferred.names.get(at) } : {}) })) : outline;
}

/* ---------- chapters ---------- */

/**
 * Chapters from a heading outline: the shallowest heading level that splits the
 * book (two or more headings), so a lone book title does not count. A chapter
 * runs to the page before the next one starts; two chapters that begin on the
 * same page share it (the later one owns it).
 */
export function chaptersFromOutline(outline, totalPages) {
  const entries = Array.isArray(outline) ? outline : [];
  const levels = [...new Set(entries.map(entry => entry.level))].sort((a, b) => a - b);
  const level = levels.find(candidate => entries.filter(entry => entry.level === candidate).length >= 2);
  if (level === undefined) return [];
  const chosen = entries.filter(entry => entry.level === level).sort((a, b) => a.page - b.page);
  return chosen.map((entry, index) => {
    const next = chosen[index + 1];
    const endPage = next ? (next.page > entry.page ? next.page - 1 : entry.page) : Math.max(entry.page, Number(totalPages) || entry.page);
    return { index, title: entry.chapterTitle ?? entry.title, level, startPage: entry.page, endPage };
  });
}

/** The heading outline and the chapters of a converted book's pages ([{ page, text }] in page order): the one rule an import and a later read share. */
export function chaptersOfPages(pages, totalPages) {
  const outline = outlineOf(pages);
  return { outline, chapters: chaptersFromOutline(outline, totalPages) };
}

/** Index of the chapter a page falls in, -1 for front matter before the first chapter. */
export function chapterIndexForPage(chapters, page) {
  let found = -1;
  for (const chapter of chapters) if (chapter.startPage <= page) found = chapter.index; else break;
  return found;
}

/* ---------- Markdown with page markers ---------- */

function splitMarked(text, pattern, toPage) {
  const parts = [];
  let preamble = '', last = 0, page = null;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (page === null) preamble = text.slice(0, match.index);
    else parts.push({ page, text: text.slice(last, match.index) });
    page = toPage(Number(match[1]));
    last = match.index + match[0].length;
  }
  if (page !== null) parts.push({ page, text: text.slice(last) });
  return { preamble, parts };
}

function markedPages(text, kind) {
  let zeroBased = false;
  if (kind === 'marker-paginated') {
    const numbers = [...text.matchAll(MARKER_LINE)].map(match => Number(match[1]));
    zeroBased = Math.min(...numbers) === 0;
  }
  const pattern = kind === 'marker-paginated' ? MARKER_LINE : PAGE_MARKER;
  const { preamble, parts } = splitMarked(text, pattern, number => (zeroBased ? number + 1 : number));
  const merged = new Map();
  for (const part of parts) merged.set(part.page, `${merged.has(part.page) ? `${merged.get(part.page)}\n\n` : ''}${part.text}`);
  const first = parts[0]?.page;
  if (first !== undefined && preamble.trim()) merged.set(first, `${preamble}\n\n${merged.get(first)}`);
  const total = Math.max(0, ...merged.keys());
  return {
    pages: [...merged].map(([page, body]) => {
      const { text: cleaned, imageCount } = cleanMarkdownWithMeta(body);
      return withImageMeta({ page, text: cleaned }, imageCount);
    }).sort((a, b) => a.page - b.page),
    total,
  };
}

/* ---------- MinerU ---------- */

const MINERU_DROP = /^(?:header|footer|page_number|aside_text|page_aside_text|discarded)$/;
const lines = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => String(item).trim()).filter(Boolean);

/** What one content_list block contributes to a page, or null when it reaches no page (a running head, an empty block). */
export function mineruBlock(item) {
  const type = String(item.type || '');
  if (MINERU_DROP.test(type)) return null;
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (type === 'equation') {
    const body = text.replace(/^\$\$|\$\$$/g, '').trim();
    return body ? { text: `$$\n${body}\n$$` } : null;
  }
  if (type === 'table') {
    const parts = [...lines(item.table_caption), item.table_body ? htmlTableToMarkdown(item.table_body) : text, ...lines(item.table_footnote)].filter(Boolean);
    return parts.length ? { text: parts.join('\n') } : null;
  }
  if (type === 'image') {
    const caption = [...lines(item.image_caption), ...lines(item.image_footnote)].join(' ');
    return caption ? { text: caption } : null;
  }
  if (type === 'code') return item.code_body ? { text: `\`\`\`\n${String(item.code_body).trim()}\n\`\`\`` } : null;
  if (type === 'list') {
    const items = lines(item.list_items);
    return items.length ? { text: items.map(entry => `- ${entry}`).join('\n') } : null;
  }
  if (!text) return null;
  const level = Number(item.text_level) || (type === 'title' ? 1 : 0);
  return level >= 1 ? { text: `${'#'.repeat(Math.min(6, level))} ${text}` } : { text };
}

function mineruV1(items) {
  const byPage = new Map(), imagesByPage = new Map();
  let total = 0;
  for (const item of items) {
    if (!isObject(item)) continue;
    const index = Number(item.page_idx);
    if (!Number.isInteger(index) || index < 0) continue;
    const page = index + 1;
    total = Math.max(total, page);
    if (String(item.type || '') === 'image') imagesByPage.set(page, (imagesByPage.get(page) || 0) + 1);
    const block = mineruBlock(item);
    if (block) byPage.set(page, [...(byPage.get(page) || []), block.text]);
  }
  return {
    pages: [...byPage].map(([page, blocks]) => withImageMeta({ page, text: blocks.join('\n\n') }, imagesByPage.get(page) || 0)).sort((a, b) => a.page - b.page),
    total,
  };
}

const V2_SKIP_KEYS = new Set(['bbox', 'type', 'id', 'path', 'img_path', 'image_source', 'source', 'sub_type', 'level', 'angle', 'index', 'score', 'cell_type']);
function gather(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const inline = value.length > 0 && value.every(entry => isObject(entry) && /^(?:text|equation_inline|span)$/.test(String(entry.type)));
    return value.map(gather).filter(Boolean).join(inline ? '' : '\n');
  }
  if (isObject(value)) return Object.keys(value).filter(key => !V2_SKIP_KEYS.has(key)).map(key => gather(value[key])).filter(Boolean).join('\n');
  return '';
}

const isV2ImageBlock = (block, type) => /^(?:image|figure)$/i.test(type)
  || Boolean(block.img_path || block.image_source || (isObject(block.content) && (block.content.img_path || block.content.image_source)));

function mineruV2(pages) {
  const result = [];
  pages.forEach((blocks, index) => {
    const out = [];
    let imageCount = 0;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!isObject(block)) continue;
      const type = String(block.type || '');
      if (/header|footer|page_number|page_aside/.test(type)) continue;
      if (isV2ImageBlock(block, type)) imageCount += 1;
      const body = isObject(block.content) && typeof block.content.html === 'string' ? htmlTableToMarkdown(block.content.html) : gather(block.content ?? block).trim();
      if (!body) continue;
      const level = Number(block.content?.level ?? block.level) || 1;
      out.push(/^(?:title|heading)/.test(type) ? `${'#'.repeat(Math.min(6, level))} ${body.replace(/\n+/g, ' ')}` : body);
    }
    if (out.length) result.push(withImageMeta({ page: index + 1, text: out.join('\n\n') }, imageCount));
  });
  return { pages: result, total: pages.length };
}

/* ---------- Docling ---------- */

const DOCLING_DROP = /^(?:page_header|page_footer|footnote_marker)$/;

function doclingTable(table) {
  const data = table?.data || {};
  const rows = Number(data.num_rows) || 0, cols = Number(data.num_cols) || 0;
  if (!rows || !cols || !Array.isArray(data.table_cells)) return '';
  const grid = Array.from({ length: rows }, () => Array(cols).fill(''));
  for (const entry of data.table_cells) {
    const row = Number(entry.start_row_offset_idx), col = Number(entry.start_col_offset_idx);
    if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row][col] = String(entry.text ?? '');
  }
  return markdownTable(grid);
}

function doclingBlock(item, kind) {
  const label = String(item.label || '');
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (kind === 'table') return { text: doclingTable(item) };
  if (kind === 'picture' || DOCLING_DROP.test(label) || !text) return null;
  if (label === 'title') return { text: `# ${text}` };
  if (label === 'section_header') return { text: `${'#'.repeat(Math.min(6, (Number(item.level) || 1) + 1))} ${text}` };
  if (label === 'list_item') return { text: `${/^\d+[.)]$/.test(String(item.marker || '')) ? item.marker : '-'} ${text}`, list: true };
  if (label === 'code') return { text: `\`\`\`\n${text}\n\`\`\`` };
  if (label === 'formula') return { text: `$$\n${text}\n$$` };
  return { text };
}

function docling(doc) {
  const resolve = ref => {
    const path = typeof ref?.$ref === 'string' ? ref.$ref.replace(/^#\//, '').split('/') : null;
    if (!path) return null;
    let value = doc;
    for (const part of path) value = value?.[part];
    return isObject(value) ? { item: value, kind: path[0] === 'tables' ? 'table' : path[0] === 'pictures' ? 'picture' : 'text' } : null;
  };
  const byPage = new Map(), imagesByPage = new Map(), seen = new Set();
  let page = 1, total = 0;
  const emit = (item, kind) => {
    const prov = Array.isArray(item.prov) ? item.prov.find(entry => Number.isInteger(entry?.page_no)) : null;
    if (prov) page = prov.page_no;
    total = Math.max(total, page);
    if (kind === 'picture' || String(item.label || '') === 'picture') {
      imagesByPage.set(page, (imagesByPage.get(page) || 0) + 1);
      return;
    }
    const block = doclingBlock(item, kind);
    if (block?.text) byPage.set(page, [...(byPage.get(page) || []), block]);
  };
  const visit = ref => {
    const found = resolve(ref);
    if (!found || seen.has(found.item)) return;
    seen.add(found.item);
    if (!/^(?:list|ordered_list|chapter|section|sheet|slide|form_area|key_value_area|comment_section|inline|picture_area)$/.test(String(found.item.label || '')) || found.kind !== 'text') emit(found.item, found.kind);
    for (const child of Array.isArray(found.item.children) ? found.item.children : []) visit(child);
  };
  const roots = Array.isArray(doc.body?.children) ? doc.body.children : [];
  if (roots.length) roots.forEach(visit);
  else {
    (doc.texts || []).forEach(item => emit(item, 'text'));
    (doc.tables || []).forEach(item => emit(item, 'table'));
    (doc.pictures || []).forEach(item => emit(item, 'picture'));
  }
  const declared = isObject(doc.pages) ? Math.max(0, ...Object.keys(doc.pages).map(Number).filter(Number.isFinite)) : Array.isArray(doc.pages) ? doc.pages.length : 0;
  const pages = [...byPage].map(([number, blocks]) => withImageMeta({ page: number, text: blocks.reduce((out, block, index) => {
    const separator = index === 0 ? '' : block.list && blocks[index - 1].list ? '\n' : '\n\n';
    return out + separator + block.text;
  }, '') }, imagesByPage.get(number) || 0)).sort((a, b) => a.page - b.page);
  return { pages, total: Math.max(total, declared) };
}

/* ---------- PaddleOCR ---------- */

const PADDLE_DROP = /^(?:header|footer|number|page_number|aside_text|header_image|footer_image|seal|formula_number)$/;
const PADDLE_IMAGE = /^(?:image|figure|chart|picture)$/;

function paddleBlock(item) {
  if (!isObject(item)) return { text: null, imageCount: 0 };
  const label = String(item.block_label || '').toLowerCase();
  if (PADDLE_DROP.test(label)) return { text: null, imageCount: 0 };
  const isImage = PADDLE_IMAGE.test(label);
  const raw = typeof item.block_content === 'string' ? item.block_content : typeof item.text === 'string' ? item.text : '';
  const body = clean(raw).trim();
  if (!body) return { text: null, imageCount: isImage ? 1 : 0 };
  if (label === 'formula' || label === 'display_formula' || label === 'equation') {
    const inner = body.replace(/^\$\$|\$\$$/g, '').trim();
    return { text: inner ? `$$\n${inner}\n$$` : null, imageCount: 0 };
  }
  if (label === 'algorithm' || label === 'code') return { text: /^```/.test(body) ? body : `\`\`\`\n${body}\n\`\`\``, imageCount: 0 };
  if (label === 'doc_title' || label === 'title') {
    const cleaned = cleanMarkdownWithMeta(body);
    const title = cleaned.text.replace(/\n+/g, ' ').trim();
    return { text: title ? (/^#{1,6}[ \t]+/.test(title) ? title : `# ${title}`) : null, imageCount: isImage ? Math.max(1, cleaned.imageCount) : cleaned.imageCount };
  }
  if (label === 'paragraph_title' || label === 'section_title') {
    const cleaned = cleanMarkdownWithMeta(body);
    const title = cleaned.text.replace(/\n+/g, ' ').trim();
    return { text: title ? (/^#{1,6}[ \t]+/.test(title) ? title : `## ${title}`) : null, imageCount: isImage ? Math.max(1, cleaned.imageCount) : cleaned.imageCount };
  }
  const cleaned = cleanMarkdownWithMeta(body);
  return { text: cleaned.text || null, imageCount: isImage ? Math.max(1, cleaned.imageCount) : cleaned.imageCount };
}

function paddleBlocksResult(blocks) {
  const parts = [];
  let imageCount = 0;
  for (const item of Array.isArray(blocks) ? blocks : []) {
    const parsed = paddleBlock(item);
    imageCount += parsed.imageCount;
    if (parsed.text) parts.push(parsed.text);
  }
  return { text: parts.join('\n\n'), imageCount };
}

function paddleocr(root) {
  const byPage = new Map(), imagesByPage = new Map();
  const state = { seq: 0, declared: 0 };
  const addPage = (rawIndex, text, imageCount = 0) => {
    const page = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex + 1 : ++state.seq;
    state.seq = Math.max(state.seq, page);
    if (imageCount > 0) imagesByPage.set(page, (imagesByPage.get(page) || 0) + imageCount);
    if (text) byPage.set(page, byPage.has(page) ? `${byPage.get(page)}\n\n${text}` : text);
  };
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const layout = paddleLayoutResults(value);
    if (layout) {
      const numPages = Number(value.result?.dataInfo?.numPages ?? value.dataInfo?.numPages) || 0;
      if (numPages > 0) state.declared = Math.max(state.declared, numPages);
      for (const entry of layout) {
        if (!isObject(entry)) continue;
        const rawIndex = Number.isInteger(entry.page_index) ? entry.page_index : entry.prunedResult?.page_index;
        const mdRaw = typeof entry.markdown === 'string' ? entry.markdown : typeof entry.markdown?.text === 'string' ? entry.markdown.text : null;
        const blocks = Array.isArray(entry.prunedResult?.parsing_res_list) ? entry.prunedResult.parsing_res_list
          : Array.isArray(entry.parsing_res_list) ? entry.parsing_res_list : null;
        const md = mdRaw !== null ? cleanMarkdownWithMeta(mdRaw) : null;
        const fromBlocks = blocks ? paddleBlocksResult(blocks) : null;
        const text = md && md.text ? md.text : (fromBlocks?.text || '');
        const imageCount = Math.max(md?.imageCount || 0, fromBlocks?.imageCount || 0);
        addPage(rawIndex, text, imageCount);
      }
      return;
    }
    const target = paddlePageTarget(value);
    if (target) {
      const fromBlocks = paddleBlocksResult(target.parsing_res_list);
      addPage(target.page_index, fromBlocks.text, fromBlocks.imageCount);
    }
  };
  visit(root);
  const pages = [...byPage].map(([page, text]) => withImageMeta({ page, text }, imagesByPage.get(page) || 0)).sort((a, b) => a.page - b.page);
  return { pages, total: Math.max(state.declared, state.seq, ...byPage.keys()) };
}

/* ---------- entry ---------- */

/** The warning about pages with no text. */
export const noTextWarning = pages => `Pages ${pages.length > 12 ? `${pages.slice(0, 12).join(', ')} …` : pages.join(', ')} have no text in the converted output (pictures or blank pages) and were skipped.`;

const NOT_CONVERTED = '这个文件不是 MinerU / Docling / PaddleOCR 的转换结果，也没有分页标记（<!-- page: N -->）。请先用转换工具处理 PDF，或见「大教材」说明。';

/**
 * Read converter output (Markdown or JSON text). Throws ConvertedDocumentError
 * (code 'not-converted' | 'no-text') when it is not readable converter output.
 * `filename` only names the document when the converter gave no title; `keepRepeated` keeps the lines repeated on many pages.
 */
export function parseConvertedDocument(input, { filename = '', keepRepeated = false } = {}) {
  const text = String(input ?? '').replace(BOM, '');
  const json = parseJson(text);
  const jsonLines = json === undefined ? parsePaddleJsonLines(text) : null;
  const kind = json !== undefined ? jsonKind(json) : jsonLines ? 'paddleocr-json' : detectConvertedFormat(text);
  if (!kind) throw new ConvertedDocumentError('not-converted', NOT_CONVERTED);
  let converter, extracted;
  if (kind === 'mineru-content-list') { converter = 'mineru'; extracted = mineruV1(json); }
  else if (kind === 'mineru-content-list-v2') { converter = 'mineru'; extracted = mineruV2(json); }
  else if (kind === 'docling-json') { converter = 'docling'; extracted = docling(json); }
  else if (kind === 'paddleocr-json') { converter = 'paddleocr'; extracted = paddleocr(jsonLines ?? json); }
  else { converter = kind === 'marker-paginated' ? 'marker' : 'generic'; extracted = markedPages(clean(text), kind); }
  const found = extracted.pages.filter(page => page.text.trim());
  if (!found.length) throw new ConvertedDocumentError('no-text', '转换结果里没有可用的文字（可能全是图片）。请换用带文字识别（OCR）的转换设置后重试。');
  const repeated = keepRepeated ? null : dropRepeatedLines(found), present = repeated ? repeated.pages : found;
  const totalPages = Math.max(extracted.total, ...present.map(page => page.page));
  const skippedPages = [];
  for (let page = 1; page <= totalPages; page++) if (!present.some(entry => entry.page === page)) skippedPages.push(page);
  const { outline, chapters } = chaptersOfPages(present, totalPages);
  const pages = present.map(page => ({ ...page, chapter: chapterIndexForPage(chapters, page.page) }));
  const imagePages = [...new Set(pages.filter(page => page.hasImages).map(page => page.page))].sort((a, b) => a - b);
  const tops = outline.filter(entry => entry.level === Math.min(...outline.map(item => item.level)));
  const named = kind === 'docling-json' && typeof json.name === 'string' && json.name.trim() ? json.name.trim() : '';
  const title = named || (tops.length === 1 && tops[0].title.length <= 120 ? tops[0].title : '') || stemOf(filename) || 'document';
  return { converter, inputFormat: kind, title, totalPages, pages, skippedPages, imagePages, outline, chapters,
    ...(repeated?.count ? { repeated: { count: repeated.count, lines: repeated.lines } } : {}),
    warnings: skippedPages.length ? [noTextWarning(skippedPages)] : [] };
}
