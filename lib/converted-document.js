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
     is 1-based.
   Result: { converter, inputFormat, title, totalPages, pages: [{ page, text,
   chapter }], skippedPages, outline: [{ level, title, page }], chapters:
   [{ index, title, level, startPage, endPage }], warnings }. `chapter` is the
   index into `chapters` (-1: front matter before the first chapter). */

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

function jsonKind(value) {
  if (Array.isArray(value)) {
    if (value.some(item => isObject(item) && 'page_idx' in item && 'type' in item)) return 'mineru-content-list';
    if (value.length && value.every(Array.isArray) && value.some(page => page.some(block => isObject(block) && 'type' in block))) return 'mineru-content-list-v2';
    return null;
  }
  if (isObject(value) && (value.schema_name === 'DoclingDocument' || (Array.isArray(value.texts) && isObject(value.body)))) return 'docling-json';
  return null;
}

const countMatches = (text, pattern) => { pattern.lastIndex = 0; return [...String(text).matchAll(pattern)].length; };

/** 'page-markers' | 'marker-paginated' | 'mineru-content-list' | 'mineru-content-list-v2' | 'docling-json' | null. */
export function detectConvertedFormat(input) {
  const text = String(input ?? '');
  const json = parseJson(text);
  if (json !== undefined) return jsonKind(json);
  if (countMatches(text, PAGE_MARKER)) return 'page-markers';
  if (countMatches(text, MARKER_LINE)) return 'marker-paginated';
  return null;
}

/** Whether a text file is a converter's JSON output (MinerU or Docling) rather than a question deck. */
export function looksLikeConvertedJson(input) {
  const json = parseJson(input);
  return json !== undefined && jsonKind(json) !== null;
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

/** Page text of a Markdown converter: images and layout noise out, HTML tables readable. */
function cleanMarkdown(text) {
  return clean(text)
    .replace(/<table\b[\s\S]*?<\/table>/gi, table => `\n${htmlTableToMarkdown(table)}\n`)
    .replace(/^[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*$/gm, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function outlineOf(pages) {
  const outline = [];
  for (const { page, text } of pages) {
    let fenced = false;
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      const heading = !fenced && /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
      if (heading && heading[2].trim()) outline.push({ level: heading[1].length, title: heading[2].trim(), page });
    }
  }
  return outline;
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
    return { index, title: entry.title, level, startPage: entry.page, endPage };
  });
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
  return { pages: [...merged].map(([page, body]) => ({ page, text: cleanMarkdown(body) })).sort((a, b) => a.page - b.page), total };
}

/* ---------- MinerU ---------- */

const MINERU_DROP = /^(?:header|footer|page_number|aside_text|page_aside_text|discarded)$/;
const lines = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => String(item).trim()).filter(Boolean);

function mineruBlock(item) {
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
  const byPage = new Map();
  let total = 0;
  for (const item of items) {
    if (!isObject(item)) continue;
    const index = Number(item.page_idx);
    if (!Number.isInteger(index) || index < 0) continue;
    total = Math.max(total, index + 1);
    const block = mineruBlock(item);
    if (block) byPage.set(index + 1, [...(byPage.get(index + 1) || []), block.text]);
  }
  return { pages: [...byPage].map(([page, blocks]) => ({ page, text: blocks.join('\n\n') })).sort((a, b) => a.page - b.page), total };
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

function mineruV2(pages) {
  const result = [];
  pages.forEach((blocks, index) => {
    const out = [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!isObject(block)) continue;
      const type = String(block.type || '');
      if (/header|footer|page_number|page_aside/.test(type)) continue;
      const body = isObject(block.content) && typeof block.content.html === 'string' ? htmlTableToMarkdown(block.content.html) : gather(block.content ?? block).trim();
      if (!body) continue;
      const level = Number(block.content?.level ?? block.level) || 1;
      out.push(/^(?:title|heading)/.test(type) ? `${'#'.repeat(Math.min(6, level))} ${body.replace(/\n+/g, ' ')}` : body);
    }
    if (out.length) result.push({ page: index + 1, text: out.join('\n\n') });
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
  const byPage = new Map(), seen = new Set();
  let page = 1, total = 0;
  const emit = (item, kind) => {
    const prov = Array.isArray(item.prov) ? item.prov.find(entry => Number.isInteger(entry?.page_no)) : null;
    if (prov) page = prov.page_no;
    total = Math.max(total, page);
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
  }
  const declared = isObject(doc.pages) ? Math.max(0, ...Object.keys(doc.pages).map(Number).filter(Number.isFinite)) : Array.isArray(doc.pages) ? doc.pages.length : 0;
  const pages = [...byPage].map(([number, blocks]) => ({ page: number, text: blocks.reduce((out, block, index) => {
    const separator = index === 0 ? '' : block.list && blocks[index - 1].list ? '\n' : '\n\n';
    return out + separator + block.text;
  }, '') })).sort((a, b) => a.page - b.page);
  return { pages, total: Math.max(total, declared) };
}

/* ---------- entry ---------- */

const NOT_CONVERTED = '这个文件不是 MinerU / Docling 的转换结果，也没有分页标记（<!-- page: N -->）。请先用转换工具处理 PDF，或见「大教材」说明。';

/**
 * Read converter output (Markdown or JSON text). Throws ConvertedDocumentError
 * (code 'not-converted' | 'no-text') when it is not readable converter output.
 * `filename` only names the document when the converter gave no title.
 */
export function parseConvertedDocument(input, { filename = '' } = {}) {
  const text = String(input ?? '').replace(BOM, '');
  const json = parseJson(text);
  const kind = json !== undefined ? jsonKind(json) : detectConvertedFormat(text);
  if (!kind) throw new ConvertedDocumentError('not-converted', json !== undefined ? NOT_CONVERTED : NOT_CONVERTED);
  let converter, extracted;
  if (kind === 'mineru-content-list') { converter = 'mineru'; extracted = mineruV1(json); }
  else if (kind === 'mineru-content-list-v2') { converter = 'mineru'; extracted = mineruV2(json); }
  else if (kind === 'docling-json') { converter = 'docling'; extracted = docling(json); }
  else { converter = kind === 'marker-paginated' ? 'marker' : 'generic'; extracted = markedPages(clean(text), kind); }
  const present = extracted.pages.filter(page => page.text.trim());
  if (!present.length) throw new ConvertedDocumentError('no-text', '转换结果里没有可用的文字（可能全是图片）。请换用带文字识别（OCR）的转换设置后重试。');
  const totalPages = Math.max(extracted.total, ...present.map(page => page.page));
  const skippedPages = [];
  for (let page = 1; page <= totalPages; page++) if (!present.some(entry => entry.page === page)) skippedPages.push(page);
  const outline = outlineOf(present);
  const chapters = chaptersFromOutline(outline, totalPages);
  const pages = present.map(page => ({ ...page, chapter: chapterIndexForPage(chapters, page.page) }));
  const tops = outline.filter(entry => entry.level === Math.min(...outline.map(item => item.level)));
  const named = kind === 'docling-json' && typeof json.name === 'string' && json.name.trim() ? json.name.trim() : '';
  const title = named || (tops.length === 1 && tops[0].title.length <= 120 ? tops[0].title : '') || stemOf(filename) || 'document';
  return { converter, inputFormat: kind, title, totalPages, pages, skippedPages, outline, chapters,
    warnings: skippedPages.length ? [`Pages ${skippedPages.length > 12 ? `${skippedPages.slice(0, 12).join(', ')} …` : skippedPages.join(', ')} have no text in the converted output (pictures or blank pages) and were skipped.`] : [] };
}
