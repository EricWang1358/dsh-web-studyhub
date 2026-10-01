import { OfficeFileError } from './zip.js';
import { parseXml, elements, element, attr, textContent } from './xml.js';
import { letters, markdownTable, roman } from './markdown.js';

/* Word (.docx) to Markdown-ish text. Headings, paragraphs, lists, tables,
   line breaks and footnotes/endnotes are kept; pictures, text boxes, headers,
   footers and comments are not read. Everything is derived from
   word/document.xml plus styles.xml, numbering.xml, footnotes.xml and
   endnotes.xml; nothing is executed or fetched. */

const val = node => attr(node, 'w:val');
const optionalPart = (zip, name) => zip.has(name) ? parseXml(zip.text(name)) : null;

function readStyles(root) {
  const styles = new Map();
  for (const style of elements(root, 'w:style')) {
    const id = attr(style, 'w:styleId');
    if (!id) continue;
    const properties = element(style, 'w:pPr'), numbering = element(properties, 'w:numPr');
    styles.set(id, { id, name: String(val(element(style, 'w:name')) ?? ''), basedOn: val(element(style, 'w:basedOn')),
      outline: val(element(properties, 'w:outlineLvl')), numId: val(element(numbering, 'w:numId')), ilvl: val(element(numbering, 'w:ilvl')) });
  }
  return styles;
}

function readNumbering(root) {
  const abstracts = new Map(), nums = new Map();
  for (const abstract of elements(root, 'w:abstractNum')) {
    const levels = new Map();
    for (const level of elements(abstract, 'w:lvl'))
      levels.set(Number(attr(level, 'w:ilvl')) || 0, { format: val(element(level, 'w:numFmt')) ?? 'decimal', start: Number(val(element(level, 'w:start'))) || 1 });
    abstracts.set(attr(abstract, 'w:abstractNumId'), levels);
  }
  for (const num of elements(root, 'w:num')) nums.set(attr(num, 'w:numId'), abstracts.get(val(element(num, 'w:abstractNumId'))) ?? null);
  return nums;
}

const headingFromName = (name = '', id = '') => {
  const value = String(name || id).trim().toLowerCase();
  if (value === 'title') return 1;
  const match = /^(?:heading|标题)\s*([1-9])$/.exec(value);
  return match ? Math.min(6, Number(match[1])) : 0;
};

class Reader {
  constructor(zip) {
    this.styles = zip.has('word/styles.xml') ? readStyles(parseXml(zip.text('word/styles.xml'))) : new Map();
    this.numbering = zip.has('word/numbering.xml') ? readNumbering(parseXml(zip.text('word/numbering.xml'))) : new Map();
    this.counters = new Map();
    this.refs = { footnote: new Map(), endnote: new Map() };
  }

  /** The style and the styles it is based on, nearest first. */
  chain(id) {
    const chain = [];
    for (let style = this.styles.get(id); style && chain.length < 12; style = this.styles.get(style.basedOn)) chain.push(style);
    return chain;
  }

  run(run) {
    let out = '';
    for (const child of elements(run)) {
      switch (child.name) {
        case 'w:t': {
          const value = textContent(child);
          out += attr(child, 'xml:space') === 'preserve' ? value : value.trim();
          break;
        }
        case 'w:tab': case 'w:ptab': out += '\t'; break;
        case 'w:br': case 'w:cr': out += '\n'; break;
        case 'w:noBreakHyphen': out += '-'; break;
        case 'w:footnoteReference': out += this.marker('footnote', attr(child, 'w:id')); break;
        case 'w:endnoteReference': out += this.marker('endnote', attr(child, 'w:id')); break;
        default: break; // drawings, pictures, objects, symbols, deleted text, field codes
      }
    }
    return out;
  }

  marker(kind, id) {
    const refs = this.refs[kind];
    if (!refs.has(id)) refs.set(id, refs.size + 1);
    return `[^${kind === 'endnote' ? 'e' : ''}${refs.get(id)}]`;
  }

  inline(node) {
    let out = '';
    for (const child of elements(node)) {
      if (child.name === 'w:r') out += this.run(child);
      else if (['w:hyperlink', 'w:ins', 'w:smartTag', 'w:fldSimple', 'w:customXml', 'w:sdt', 'w:sdtContent', 'w:moveTo'].includes(child.name)) out += this.inline(child);
    }
    return out;
  }

  paragraphText(paragraph) {
    return this.inline(paragraph).replace(/[ \t]*\n[ \t]*/g, '\n').trim();
  }

  /** { kind: 'skip'|'heading'|'list'|'text', text, level?, key? } for a w:p. */
  paragraph(paragraph) {
    const text = this.paragraphText(paragraph);
    if (!text) return { kind: 'skip' };
    const properties = element(paragraph, 'w:pPr'), id = val(element(properties, 'w:pStyle'));
    const chain = this.chain(id);
    if (chain.some(style => /^toc(?:\s*\d+|\s*heading)$/i.test(style.name.trim()))) return { kind: 'skip' };
    const direct = val(element(properties, 'w:outlineLvl'));
    let level = direct !== undefined && Number(direct) < 9 ? Math.min(6, Number(direct) + 1) : 0;
    if (!level) for (const style of chain) {
      level = headingFromName(style.name, style.id) || (style.outline !== undefined && Number(style.outline) < 9 ? Math.min(6, Number(style.outline) + 1) : 0);
      if (level) break;
    }
    if (!level && id) level = headingFromName('', id);
    if (level) return { kind: 'heading', text: `${'#'.repeat(level)} ${text.replace(/\n+/g, ' ')}` };
    const numPr = element(properties, 'w:numPr');
    let numId = val(element(numPr, 'w:numId')), ilvl = val(element(numPr, 'w:ilvl'));
    if (numId === undefined) for (const style of chain) if (style.numId !== undefined) { numId = style.numId; ilvl ??= style.ilvl; break; }
    if (numId === undefined || numId === '0') return { kind: 'text', text };
    return this.listItem(numId, Number(ilvl) || 0, text);
  }

  listItem(numId, ilvl, text) {
    const levels = this.numbering.get(numId), definition = levels?.get(ilvl);
    const counters = this.counters.get(numId) ?? [];
    this.counters.set(numId, counters);
    counters.length = ilvl + 1;
    counters[ilvl] = (counters[ilvl] ?? (definition?.start ?? 1) - 1) + 1;
    for (let index = 0; index < ilvl; index++) counters[index] ??= levels?.get(index)?.start ?? 1;
    const format = definition?.format ?? 'bullet', n = counters[ilvl];
    const marker = format === 'none' ? '' : format === 'bullet' ? '- '
      : /alpha|letter/i.test(format) && !/chinese/i.test(format) ? `${letters(n)}. `
        : /roman/i.test(format) ? `${roman(n)}. ` : `${n}. `;
    if (!marker) return { kind: 'text', text };
    const indent = '  '.repeat(ilvl);
    return { kind: 'list', key: numId, text: `${indent}${marker}${text.replace(/\n/g, `\n${indent}${' '.repeat(marker.length)}`)}` };
  }

  cellText(cell) {
    const parts = [];
    for (const child of elements(cell)) {
      if (child.name === 'w:p') { const text = this.paragraphText(child); if (text) parts.push(text.replace(/\n+/g, ' ')); }
      else if (child.name === 'w:tbl') parts.push(...this.tableRows(child).flat().filter(Boolean));
    }
    return parts.join(' ');
  }

  tableRows(table) {
    const rows = [];
    for (const row of elements(table, 'w:tr')) {
      const cells = [];
      for (const cell of elements(row, 'w:tc')) {
        const properties = element(cell, 'w:tcPr'), merge = element(properties, 'w:vMerge');
        const text = merge && val(merge) !== 'restart' ? '' : this.cellText(cell);
        cells.push(text);
        for (let extra = (Number(val(element(properties, 'w:gridSpan'))) || 1) - 1; extra > 0; extra--) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  blocks(container, out = []) {
    for (const child of elements(container)) {
      if (child.name === 'w:p') out.push(this.paragraph(child));
      else if (child.name === 'w:tbl') out.push({ kind: 'table', text: markdownTable(this.tableRows(child)) });
      else if (child.name === 'w:sdt') this.blocks(element(child, 'w:sdtContent'), out);
      else if (child.name === 'w:sdtContent' || child.name === 'w:customXml') this.blocks(child, out);
    }
    return out;
  }
}

function noteText(reader, root, tag, id) {
  for (const note of elements(root, tag)) {
    if (attr(note, 'w:id') !== id || attr(note, 'w:type')) continue;
    return elements(note, 'w:p').map(paragraph => reader.paragraphText(paragraph).replace(/\n+/g, ' ')).filter(Boolean).join(' ');
  }
  return '';
}

/** Markdown-ish text of a .docx package (a reader from readZip). */
export function extractDocx(zip) {
  const documentXml = zip.text('word/document.xml');
  if (documentXml === null) throw new OfficeFileError('invalid', 'Office file is damaged or not a valid DOCX file');
  const body = element(parseXml(documentXml), 'w:body');
  if (!body) throw new OfficeFileError('invalid', 'Office file is damaged or not a valid DOCX file');
  const reader = new Reader(zip);
  const parts = [];
  let previous = null;
  for (const block of reader.blocks(body)) {
    if (block.kind === 'skip' || !block.text) continue;
    const joined = previous && previous.kind === 'list' && block.kind === 'list' && previous.key === block.key ? '\n' : '\n\n';
    parts.push(parts.length ? joined : '', block.text);
    previous = block;
  }
  const notes = [['footnote', '脚注', 'word/footnotes.xml', 'w:footnote', ''], ['endnote', '尾注', 'word/endnotes.xml', 'w:endnote', 'e']];
  for (const [kind, heading, part, tag, prefix] of notes) {
    const refs = [...reader.refs[kind]];
    if (!refs.length) continue;
    const root = optionalPart(zip, part);
    if (!root) continue;
    const lines = refs.map(([id, number]) => [number, noteText(reader, root, tag, id)]).filter(([, text]) => text).map(([number, text]) => `[^${prefix}${number}]: ${text}`);
    if (lines.length) parts.push('\n\n', `## ${heading}`, '\n\n', lines.join('\n'));
  }
  return { text: parts.join('').trim(), warnings: [] };
}
