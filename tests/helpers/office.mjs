// Tiny builders for Office test fixtures: a ZIP writer plus minimal .docx / .pptx
// packages generated in memory (no binary fixtures are committed).
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * entries: [{ name, data: string|Buffer, method?: 'stored'|'deflate', flags?, versionNeeded?,
 *            declaredSize?, declaredCompressed?, crc? }]. Returns a Buffer holding a ZIP file.
 * Options: zip64 appends a ZIP64 end-of-central-directory locator; comment is the archive comment.
 */
export function zipFiles(entries, { zip64 = false, comment = '' } = {}) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const stored = (entry.method ?? 'deflate') === 'stored';
    const body = stored ? raw : deflateRawSync(raw);
    const checksum = entry.crc ?? crc32(raw);
    const flags = (entry.flags ?? 0) | 0x0800;
    const uncompressed = entry.declaredSize ?? raw.length, compressed = entry.declaredCompressed ?? body.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(entry.versionNeeded ?? 20, 4); header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(stored ? 0 : 8, 8); header.writeUInt32LE(0, 10); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed, 18); header.writeUInt32LE(uncompressed, 22); header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(entry.versionNeeded ?? 20, 6);
    record.writeUInt16LE(flags, 8); record.writeUInt16LE(stored ? 0 : 8, 10); record.writeUInt32LE(0, 12);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed, 20); record.writeUInt32LE(uncompressed, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22), note = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...local, directory, ...tail, end, note]);
}

export const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** A run of text: <w:r><w:t>…</w:t></w:r> (xml:space preserved). */
export const run = text => `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
/** A paragraph. style is a styleId; list is { numId, ilvl }. */
export const para = (content, { style, list, outline } = {}) => {
  const body = typeof content === 'string' && !content.startsWith('<') ? run(content) : content;
  const props = (style ? `<w:pStyle w:val="${style}"/>` : '') +
    (list ? `<w:numPr><w:ilvl w:val="${list.ilvl ?? 0}"/><w:numId w:val="${list.numId}"/></w:numPr>` : '') +
    (outline !== undefined ? `<w:outlineLvl w:val="${outline}"/>` : '');
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${body}</w:p>`;
};
export const cell = (content, { span, vMerge } = {}) => `<w:tc><w:tcPr>${span ? `<w:gridSpan w:val="${span}"/>` : ''}${vMerge === undefined ? '' : vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>'}</w:tcPr>${
  Array.isArray(content) ? content.join('') : para(content)}</w:tc>`;
export const row = cells => `<w:tr>${cells.join('')}</w:tr>`;
export const table = rows => `<w:tbl><w:tblPr/><w:tblGrid/>${rows.join('')}</w:tbl>`;

export const STYLES = `${XML}<w:styles ${W}>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>
<w:style w:type="paragraph" w:styleId="Chapter"><w:name w:val="Chapter Heading"/><w:basedOn w:val="Heading1"/></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
</w:styles>`;

export const NUMBERING = `${XML}<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

export const footnotesXml = (notes, tag = 'footnote') => `${XML}<w:${tag}s ${W}>
<w:${tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}>
<w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>
${notes.map(([id, text]) => `<w:${tag} w:id="${id}"><w:p><w:r><w:footnoteRef/></w:r>${run(` ${text}`)}</w:p></w:${tag}>`).join('\n')}
</w:${tag}s>`;

export const coreXml = title => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title></cp:coreProperties>`;

/** Build a .docx. body is the inner XML of <w:body>; extra maps part names to XML. */
export function docxFile(body, { styles = STYLES, numbering = NUMBERING, footnotes, endnotes, title, extra = {}, method } = {}) {
  const entries = [
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: 'word/document.xml', data: `${XML}<w:document ${W}><w:body>${body}</w:body></w:document>` },
    ...(styles ? [{ name: 'word/styles.xml', data: styles }] : []),
    ...(numbering ? [{ name: 'word/numbering.xml', data: numbering }] : []),
    ...(footnotes ? [{ name: 'word/footnotes.xml', data: footnotesXml(footnotes) }] : []),
    ...(endnotes ? [{ name: 'word/endnotes.xml', data: footnotesXml(endnotes, 'endnote') }] : []),
    ...(title ? [{ name: 'docProps/core.xml', data: coreXml(title) }] : []),
    ...Object.entries(extra).map(([name, data]) => ({ name, data })),
  ].map(entry => ({ ...entry, method }));
  return zipFiles(entries);
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A DrawingML paragraph: { text, lvl, bullet: 'char'|'num'|'none' }. */
export const apara = (text, { lvl, bullet } = {}) => {
  const props = (lvl ? ` lvl="${lvl}"` : '');
  const inner = bullet === 'char' ? '<a:buChar char="•"/>' : bullet === 'num' ? '<a:buAutoNum type="arabicPeriod"/>' : bullet === 'none' ? '<a:buNone/>' : '';
  const runs = String(text).split('\n').map(part => `<a:r><a:t>${escapeXml(part)}</a:t></a:r>`).join('<a:br/>');
  return `<a:p><a:pPr${props}>${inner}</a:pPr>${runs}</a:p>`;
};
/** A shape: ph is the placeholder type (title, body, subTitle) or undefined for a text box. */
export const shape = (paragraphs, { ph, id = 2 } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr${ph ? '' : ' txBox="1"'}/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs.join('')}</p:txBody></p:sp>`;
export const picture = () => '<p:pic><p:nvPicPr><p:cNvPr id="9" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>';
export const slideTable = rows => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData><a:tbl><a:tblPr/><a:tblGrid/>${
  rows.map(cells => `<a:tr h="1">${cells.map(c => typeof c === 'string' ? `<a:tc><a:txBody><a:bodyPr/>${apara(c)}</a:txBody></a:tc>`
    : `<a:tc${c.span ? ` gridSpan="${c.span}"` : ''}${c.hMerge ? ' hMerge="1"' : ''}${c.vMerge ? ' vMerge="1"' : ''}${c.rowSpan ? ` rowSpan="${c.rowSpan}"` : ''}><a:txBody><a:bodyPr/>${apara(c.text ?? '')}</a:txBody></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
export const group = inner => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`;

/**
 * Build a .pptx. slides: [{ shapes: string[], notes?: string, file?: string, hidden? }]. `order` lists indexes
 * (into slides) in presentation order, so file names can disagree with the order. Slide files are slideN.xml
 * by position in `slides` unless `file` is given.
 */
export function pptxFile(slides, { order, title, method, extra = {} } = {}) {
  const sequence = order || slides.map((_, index) => index);
  const entries = [{ name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` }];
  const rels = [], ids = [];
  slides.forEach((slide, index) => {
    const file = slide.file || `slide${index + 1}.xml`;
    entries.push({ name: `ppt/slides/${file}`, data: `${XML}<p:sld ${P}${slide.hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${slide.shapes.join('')}</p:spTree></p:cSld></p:sld>` });
    const slideRels = [];
    if (slide.notes !== undefined) {
      const notesFile = `notesSlide${index + 1}.xml`;
      entries.push({ name: `ppt/notesSlides/${notesFile}`, data: `${XML}<p:notes ${P}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${
        shape([apara('')], { ph: 'sldImg', id: 2 })}${shape(String(slide.notes).split('\n\n').map(text => apara(text)), { ph: 'body', id: 3 })}${shape([apara(String(index + 1))], { ph: 'sldNum', id: 4 })}</p:spTree></p:cSld></p:notes>` });
      slideRels.push(`<Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/${notesFile}"/>`);
    }
    slideRels.push(`<Relationship Id="rId9" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`);
    entries.push({ name: `ppt/slides/_rels/${file}.rels`, data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels.join('')}</Relationships>` });
    rels.push(`<Relationship Id="rId${index + 10}" Type="${REL}/slide" Target="slides/${file}"/>`);
  });
  for (const index of sequence) ids.push(`<p:sldId id="${256 + index}" r:id="rId${index + 10}"/>`);
  rels.push(`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`);
  entries.push({ name: 'ppt/presentation.xml', data: `${XML}<p:presentation ${P}><p:sldMasterIdLst/><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>` });
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` });
  if (title) entries.push({ name: 'docProps/core.xml', data: coreXml(title) });
  for (const [name, data] of Object.entries(extra)) entries.push({ name, data });
  return zipFiles(entries.map(entry => ({ ...entry, method })));
}
