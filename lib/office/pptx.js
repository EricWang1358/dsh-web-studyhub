import { OfficeFileError } from './zip.js';
import { parseXml, elements, element, attr, canonicalTag, isRelationshipType, textContent } from './xml.js';
import { formatOmml } from './omml.js';
import { markdownTable } from './markdown.js';

/* PowerPoint (.pptx) to one text page per slide, in presentation order
   (ppt/presentation.xml sldIdLst resolved through its relationships, never by
   file name). Each slide becomes "## 第 N 页 · <title>" followed by its text
   frames, OMML equations (as LaTeX), and tables in document order and its
   speaker notes under "备注：". Pictures, charts and SmartArt are not read. */

const invalid = () => new OfficeFileError('invalid', 'Office file is damaged or not a valid PPTX file');

/** Resolve a relationship target against the directory of the part that owns it. */
export function resolveTarget(directory, target) {
  const parts = String(target).startsWith('/') ? [] : directory.split('/').filter(Boolean);
  for (const segment of String(target).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop(); else parts.push(segment);
  }
  return parts.join('/');
}

function relationships(zip, part) {
  const directory = part.slice(0, part.lastIndexOf('/') + 1);
  const rels = `${directory}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
  const map = new Map();
  if (!zip.has(rels)) return map;
  for (const rel of elements(parseXml(zip.text(rels)), 'Relationship'))
    if (attr(rel, 'TargetMode') !== 'External') map.set(attr(rel, 'Id'), { type: attr(rel, 'Type'), target: resolveTarget(directory, attr(rel, 'Target') || '') });
  return map;
}

const TITLE = new Set(['title', 'ctrTitle']);
const BODY = new Set(['body', 'obj']);
const SKIP = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg', 'pic', 'chart', 'media', 'clipArt', 'dgm', 'tbl']);
const VISUAL_ORDER = ['image', 'chart', 'smartart'];
const VISUAL_PLACEHOLDER = { pic: 'image', clipArt: 'image', chart: 'chart', dgm: 'smartart' };

function placeholder(shape) {
  const ph = element(element(element(shape, 'p:nvSpPr'), 'p:nvPr'), 'p:ph');
  if (!ph) return null;
  const type = attr(ph, 'type');
  return { type: type ?? (attr(ph, 'idx') !== undefined ? 'body' : 'obj') };
}

function runs(paragraph) {
  let out = '';
  for (const child of elements(paragraph)) {
    const tag = canonicalTag(child);
    if (tag === 'a:r') out += textContent(element(child, 'a:t'));
    else if (tag === 'a:br') out += '\n';
    else if (tag === 'a:fld' && !/^(?:slidenum|datetime)/i.test(attr(child, 'type') || '')) out += textContent(element(child, 'a:t'));
    else if (tag === 'm:oMath') out += formatOmml(child, { display: false });
    else if (tag === 'm:oMathPara') out += formatOmml(child, { display: true });
    else if (tag === 'a14:m') out += runs(child);
    else if (tag === 'mc:AlternateContent') {
      const choice = element(child, 'mc:Choice');
      const picked = choice ? runs(choice) : '';
      if (picked.trim()) out += picked;
      else {
        const fallback = element(child, 'mc:Fallback');
        if (fallback) out += runs(fallback);
      }
    }
  }
  return out;
}

/** Lines of a text body; defaultBullet applies to paragraphs that do not choose a bullet themselves. */
function textLines(body, { defaultBullet }) {
  const lines = [], counters = [];
  for (const paragraph of elements(body, 'a:p')) {
    const text = runs(paragraph).replace(/[ \t]*\n[ \t]*/g, '\n').trim();
    const properties = element(paragraph, 'a:pPr'), level = Math.min(8, Math.max(0, Number(attr(properties, 'lvl')) || 0));
    if (!text) { counters.length = 0; continue; }
    const style = element(properties, 'a:buNone') ? 'none' : element(properties, 'a:buAutoNum') ? 'num' : element(properties, 'a:buChar') ? 'char' : defaultBullet ? 'char' : 'none';
    counters.length = level + 1;
    const start = Number(attr(element(properties, 'a:buAutoNum'), 'startAt')) || 1;
    if (style === 'num') counters[level] = (counters[level] ?? start - 1) + 1;
    else counters[level] = undefined;
    const marker = style === 'num' ? `${counters[level]}. ` : style === 'char' ? '- ' : '';
    const indent = marker ? '  '.repeat(level) : '';
    lines.push(`${indent}${marker}${text.replace(/\n/g, `\n${indent}${' '.repeat(marker.length)}`)}`);
  }
  return lines;
}

/** Every non-empty paragraph of a text body on one line. */
const oneLine = body => elements(body, 'a:p').map(paragraph => runs(paragraph).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join(' ');

function table(frame) {
  const tbl = element(element(element(frame, 'a:graphic'), 'a:graphicData'), 'a:tbl');
  if (!tbl) return '';
  const rows = elements(tbl, 'a:tr').map(row => elements(row, 'a:tc').map(cell => oneLine(element(cell, 'a:txBody'))));
  return markdownTable(rows);
}

function graphicFrameVisual(frame) {
  const graphicData = element(element(frame, 'a:graphic'), 'a:graphicData');
  if (!graphicData) return null;
  const uri = String(attr(graphicData, 'uri') || '');
  if (/\/chart(?:ex)?$/i.test(uri)) return 'chart';
  if (/\/diagram$/i.test(uri)) return 'smartart';
  const children = elements(graphicData);
  if (children.some(child => child.local === 'chart')) return 'chart';
  if (children.some(child => child.local === 'relIds')) return 'smartart';
  return null;
}

/** Walk a shape tree in document order, collecting titles, body blocks, and omitted visual kinds. */
function collect(container, out) {
  for (const child of elements(container)) {
    switch (canonicalTag(child)) {
      case 'p:sp': {
        const ph = placeholder(child), body = element(child, 'p:txBody');
        if (ph && Object.hasOwn(VISUAL_PLACEHOLDER, ph.type)) { out.visuals.add(VISUAL_PLACEHOLDER[ph.type]); break; }
        if (!body || (ph && SKIP.has(ph.type))) break;
        if (ph && TITLE.has(ph.type)) { out.titles.push(oneLine(body)); break; }
        const lines = textLines(body, { defaultBullet: !!ph && BODY.has(ph.type) });
        if (lines.length) out.blocks.push(lines.join('\n'));
        break;
      }
      case 'p:pic': out.visuals.add('image'); break;
      case 'p:graphicFrame': {
        const markdown = table(child);
        if (markdown) { out.blocks.push(markdown); break; }
        const visual = graphicFrameVisual(child);
        if (visual) out.visuals.add(visual);
        break;
      }
      case 'p:grpSp': collect(child, out); break;
      case 'mc:AlternateContent': {
        const choice = element(child, 'mc:Choice');
        const fromChoice = choice ? collect(choice, { titles: [], blocks: [], visuals: new Set() }) : { titles: [], blocks: [], visuals: new Set() };
        if (fromChoice.titles.length || fromChoice.blocks.length) {
          out.titles.push(...fromChoice.titles);
          out.blocks.push(...fromChoice.blocks);
          for (const kind of fromChoice.visuals) out.visuals.add(kind);
        } else {
          const fallback = element(child, 'mc:Fallback');
          const fromFallback = fallback ? collect(fallback, { titles: [], blocks: [], visuals: new Set() }) : { titles: [], blocks: [], visuals: new Set() };
          if (fromFallback.titles.length || fromFallback.blocks.length) {
            out.titles.push(...fromFallback.titles);
            out.blocks.push(...fromFallback.blocks);
            for (const kind of fromFallback.visuals) out.visuals.add(kind);
          } else {
            for (const kind of fromChoice.visuals) out.visuals.add(kind);
            for (const kind of fromFallback.visuals) out.visuals.add(kind);
          }
        }
        break;
      }
      default: break;
    }
  }
  return out;
}

function notesOf(zip, rels) {
  const rel = [...rels.values()].find(item => isRelationshipType(item.type, 'notesSlide'));
  if (!rel || !zip.has(rel.target)) return '';
  const tree = element(element(parseXml(zip.text(rel.target)), 'p:cSld'), 'p:spTree');
  const lines = [];
  for (const shape of elements(tree, 'p:sp')) {
    const ph = placeholder(shape);
    if (ph?.type !== 'body') continue;
    lines.push(...textLines(element(shape, 'p:txBody'), { defaultBullet: false }));
  }
  return lines.join('\n');
}

/**
 * Slides of a .pptx package (a reader from readZip) in presentation order:
 * [{ number, text }] where text is '' for a slide without any text.
 */
export function extractPptx(zip) {
  const presentation = zip.text('ppt/presentation.xml');
  if (presentation === null) throw invalid();
  const list = element(parseXml(presentation), 'p:sldIdLst');
  const slides = elements(list, 'p:sldId');
  if (!list || !slides.length) throw invalid();
  const rels = relationships(zip, 'ppt/presentation.xml');
  const result = [];
  slides.forEach((entry, index) => {
    const rel = rels.get(attr(entry, 'r:id'));
    if (!rel || !isRelationshipType(rel.type, 'slide') || !zip.has(rel.target)) throw invalid();
    const root = parseXml(zip.text(rel.target));
    const { titles, blocks, visuals } = collect(element(element(root, 'p:cSld'), 'p:spTree'), { titles: [], blocks: [], visuals: new Set() });
    const notes = notesOf(zip, relationships(zip, rel.target));
    const number = index + 1, title = titles.filter(Boolean).join(' ');
    const parts = [...blocks, ...(notes ? [`备注：\n${notes}`] : [])];
    const omittedVisuals = VISUAL_ORDER.filter(kind => visuals.has(kind));
    result.push({
      number,
      text: title || parts.length ? [`## 第 ${number} 页${title ? ` · ${title}` : ''}`, ...parts].join('\n\n') : '',
      ...(omittedVisuals.length ? { omittedVisuals } : {}),
    });
  });
  return result;
}
