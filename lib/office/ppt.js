import { OfficeFileError } from './zip.js';

/* Legacy PowerPoint 97–2003 (.ppt, [MS-PPT]) to one text page per slide, in the
   same shape as the .pptx reader: "## 第 N 页 · <title>", the text of the slide's
   shapes in drawing order, then the speaker notes under "备注：".

   The "PowerPoint Document" stream is a tree of records (8-byte header: version
   and instance, type, length). The live version of each object is found the way
   PowerPoint finds it: "Current User" points at the last UserEditAtom, the chain
   of edits gives the persist directory (object id -> stream offset), and the
   DocumentContainer's slide list (SlideListWithText) gives the slides in
   presentation order. Placeholder text is stored in that list and referenced from
   the drawing (OutlineTextRefAtom); text boxes keep theirs in the drawing
   (OfficeArtClientTextbox). Indent levels, pictures, charts and embedded objects
   are not read. */

const RT = Object.freeze({
  Document: 0x03e8, Slide: 0x03ee, SlideAtom: 0x03ef, Notes: 0x03f0, NotesAtom: 0x03f1, Drawing: 0x040c,
  SlidePersistAtom: 0x03f3, SlideListWithText: 0x0ff0, UserEditAtom: 0x0ff5, CurrentUserAtom: 0x0ff6,
  PersistDirectoryAtom: 0x1772, OutlineTextRefAtom: 0x0f9e, TextHeaderAtom: 0x0f9f, TextCharsAtom: 0x0fa0, TextBytesAtom: 0x0fa8,
  SpContainer: 0xf004, ClientData: 0xf011, ClientTextbox: 0xf00d, PlaceholderAtom: 0x0bc3,
});
// TextHeaderAtom.textType
const TEXT = Object.freeze({ title: 0, body: 1, notes: 2, other: 4, centerBody: 5, centerTitle: 6, halfBody: 7, quarterBody: 8 });
const TITLES = new Set([TEXT.title, TEXT.centerTitle]);
const BULLETED = new Set([TEXT.body, TEXT.halfBody, TEXT.quarterBody]);
const NOTE_TEXT = new Set([TEXT.body, TEXT.notes]);
// PlaceholderAtom.placementId: date, slide number, footer, header (master items repeated on slides and notes pages).
const SKIP_PLACEHOLDERS = new Set([0x07, 0x08, 0x09, 0x0a]);
const ENCRYPTED_TOKEN = 0xf3d1c4df;
const MAX_DEPTH = 64, MAX_EDITS = 10_000;

const invalid = detail => new OfficeFileError('invalid', `Office file is damaged or not a valid PPT file (${detail})`);
const encrypted = () => new OfficeFileError('encrypted', 'Office file is password-protected or in an old format');

function header(stream, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 8 > stream.length) throw invalid('record out of range');
  const verInstance = stream.readUInt16LE(offset), length = stream.readUInt32LE(offset + 4);
  const start = offset + 8, end = start + length;
  if (end > stream.length) throw invalid('record longer than the stream');
  return { version: verInstance & 0x0f, instance: verInstance >>> 4, type: stream.readUInt16LE(offset + 2), start, end };
}

function children(stream, record) {
  const out = [];
  if (record.version !== 0x0f) return out;
  for (let offset = record.start; offset + 8 <= record.end;) {
    const child = header(stream, offset);
    if (child.end > record.end) throw invalid('record overruns its container');
    out.push(child);
    offset = child.end;
  }
  return out;
}

const child = (stream, record, type, instance) => children(stream, record).find(item => item.type === type && (instance === undefined || item.instance === instance));

/** Text of a TextCharsAtom (UTF-16) or TextBytesAtom (the low byte of each UTF-16 unit). */
function atomText(stream, record) {
  const data = stream.subarray(record.start, record.end);
  const raw = record.type === RT.TextCharsAtom ? data.subarray(0, data.length & ~1).toString('utf16le') : data.toString('latin1');
  // \r ends a paragraph, \v is a line break inside one; other control characters are field and object markers.
  return raw.replace(/\r\n?/g, '\r').replace(/[\0-\x08\x0c\x0e-\x1f￼]/g, '');
}

const isText = record => record.type === RT.TextCharsAtom || record.type === RT.TextBytesAtom;

/**
 * The texts of one SlideListWithText container, keyed by the persist id of the
 * slide they belong to: Map<persistIdRef, { slideId, texts: [{ type, text }] }>,
 * in list order.
 */
function slideList(stream, list) {
  const slides = new Map();
  let current = null, type = TEXT.other;
  for (const record of list ? children(stream, list) : []) {
    if (record.type === RT.SlidePersistAtom) {
      if (record.end - record.start < 16) throw invalid('short SlidePersistAtom');
      current = { persistId: stream.readUInt32LE(record.start), slideId: stream.readUInt32LE(record.start + 12), texts: [] };
      slides.set(current.persistId, current);
    } else if (record.type === RT.TextHeaderAtom && record.end - record.start >= 4) type = stream.readUInt32LE(record.start);
    else if (isText(record) && current) current.texts.push({ type, text: atomText(stream, record) });
  }
  return slides;
}

/** Text blocks of a slide or notes drawing in drawing order: [{ type, text }]. */
function drawingTexts(stream, container, listed) {
  const out = [], used = new Set();
  const drawing = child(stream, container, RT.Drawing);
  const shape = (record, depth) => {
    if (depth > MAX_DEPTH) throw invalid('drawing nested too deeply');
    if (record.type === RT.SpContainer) {
      const parts = children(stream, record);
      const data = parts.find(part => part.type === RT.ClientData);
      const placeholder = data && child(stream, data, RT.PlaceholderAtom);
      if (placeholder && placeholder.end - placeholder.start >= 5 && SKIP_PLACEHOLDERS.has(stream[placeholder.start + 4])) return;
      for (const part of parts) {
        if (part.type === RT.ClientTextbox) {
          let type = TEXT.other;
          for (const item of children(stream, part)) {
            if (item.type === RT.TextHeaderAtom && item.end - item.start >= 4) type = stream.readUInt32LE(item.start);
            else if (isText(item)) out.push({ type, text: atomText(stream, item) });
            else if (item.type === RT.OutlineTextRefAtom && item.end - item.start >= 4) {
              const index = stream.readInt32LE(item.start);
              if (listed?.[index] && !used.has(index)) { used.add(index); out.push(listed[index]); }
            }
          }
        } else shape(part, depth + 1);
      }
      return;
    }
    for (const part of children(stream, record)) shape(part, depth + 1);
  };
  if (drawing) shape(drawing, 0);
  // Placeholder text the drawing does not reference (some writers leave the reference out).
  (listed || []).forEach((item, index) => { if (!used.has(index)) out.push(item); });
  return out;
}

const paragraphs = text => text.split('\r').map(line => line.replace(/[ \t]*\v[ \t]*/g, '\n').trim()).filter(Boolean);

function block({ type, text }) {
  const bullet = BULLETED.has(type) ? '- ' : '';
  return paragraphs(text).map(line => `${bullet}${line.replace(/\n/g, `\n${' '.repeat(bullet.length)}`)}`).join('\n');
}

/** One edit's persist entries, added under the ones a newer edit already set. */
function readEdit(stream, offset, directory) {
  const edit = header(stream, offset);
  if (edit.type !== RT.UserEditAtom || edit.end - edit.start < 28) throw invalid('missing UserEditAtom');
  if (edit.end - edit.start >= 32 && stream.readUInt32LE(edit.start + 28) !== 0) throw encrypted();
  const persist = header(stream, stream.readUInt32LE(edit.start + 12));
  if (persist.type !== RT.PersistDirectoryAtom) throw invalid('missing PersistDirectoryAtom');
  const entries = [];
  for (let at = persist.start; at + 4 <= persist.end;) {
    const info = stream.readUInt32LE(at), first = info & 0xfffff, count = info >>> 20;
    at += 4;
    if (at + count * 4 > persist.end) throw invalid('persist directory overruns its atom');
    for (let index = 0; index < count; index++, at += 4) entries.push([first + index, stream.readUInt32LE(at)]);
  }
  for (const [id, at] of entries) if (!directory.has(id)) directory.set(id, at);
  return { documentId: stream.readUInt32LE(edit.start + 16), previous: stream.readUInt32LE(edit.start + 8) };
}

/**
 * Persist directory (object id -> offset) of the live edit, newest edit first.
 * The newest edit must be readable; an older one that is broken or loops back
 * ends the chain there (PowerPoint keeps whole objects in every edit, so the
 * newest ones are what the slides need).
 */
function persistDirectory(stream, firstEdit) {
  const directory = new Map(), seen = new Set([firstEdit]);
  const { documentId, previous } = readEdit(stream, firstEdit, directory);
  for (let offset = previous; offset !== 0 && !seen.has(offset) && seen.size < MAX_EDITS;) {
    seen.add(offset);
    try { offset = readEdit(stream, offset, directory).previous; }
    catch (error) { if (error.code === 'encrypted') throw error; break; }
  }
  return { directory, documentId };
}

/** The last UserEditAtom: from "Current User", or, when that is missing or stale, the last one in the stream. */
function lastEdit(stream, currentUser) {
  if (currentUser && currentUser.length >= 20) {
    const atom = header(currentUser, 0);
    if (atom.type === RT.CurrentUserAtom && atom.end - atom.start >= 12) {
      if (currentUser.readUInt32LE(atom.start + 4) === ENCRYPTED_TOKEN) throw encrypted();
      const offset = currentUser.readUInt32LE(atom.start + 8);
      if (offset + 8 <= stream.length && stream.readUInt16LE(offset + 2) === RT.UserEditAtom) return offset;
    }
  }
  let found = -1;
  for (let offset = 0; offset + 8 <= stream.length;) {
    const record = header(stream, offset);
    if (record.type === RT.UserEditAtom) found = offset;
    offset = record.end;
  }
  if (found < 0) throw invalid('no UserEditAtom');
  return found;
}

/**
 * Slides of a .ppt (a reader from readCompoundFile) in presentation order:
 * [{ number, text }] where text is '' for a slide without any text.
 */
export function extractPpt(cfb) {
  const stream = cfb.read('PowerPoint Document');
  if (!stream) throw invalid('no PowerPoint Document stream');
  if (cfb.has('EncryptedSummary')) throw encrypted();
  const { directory, documentId } = persistDirectory(stream, lastEdit(stream, cfb.read('Current User')));
  const objectAt = (id, type) => {
    if (!directory.has(id)) return null;
    const record = header(stream, directory.get(id));
    return record.type === type ? record : null;
  };
  const document = objectAt(documentId, RT.Document);
  if (!document) throw invalid('missing DocumentContainer');
  const slides = slideList(stream, child(stream, document, RT.SlideListWithText, 0));
  const notesById = new Map([...slideList(stream, child(stream, document, RT.SlideListWithText, 2)).values()].map(item => [item.slideId, item]));

  const result = [];
  let number = 0;
  for (const entry of slides.values()) {
    const slide = objectAt(entry.persistId, RT.Slide);
    if (!slide) continue;
    number += 1;
    const texts = drawingTexts(stream, slide, entry.texts);
    const title = texts.filter(item => TITLES.has(item.type)).map(item => paragraphs(item.text).join(' ').replace(/\s*\n\s*/g, ' ')).filter(Boolean).join(' ');
    const blocks = texts.filter(item => !TITLES.has(item.type) && item.text.trim() !== '*').map(block).filter(Boolean);
    let notes = '';
    const atom = child(stream, slide, RT.SlideAtom);
    if (atom && atom.end - atom.start >= 20) {
      const listed = notesById.get(stream.readUInt32LE(atom.start + 16));
      const container = listed && objectAt(listed.persistId, RT.Notes);
      if (container) notes = drawingTexts(stream, container, listed.texts).filter(item => NOTE_TEXT.has(item.type))
        .map(item => paragraphs(item.text).join('\n')).filter(Boolean).join('\n');
    }
    const parts = [...blocks, ...(notes ? [`备注：\n${notes}`] : [])];
    result.push({ number, text: title || parts.length ? [`## 第 ${number} 页${title ? ` · ${title}` : ''}`, ...parts].join('\n\n') : '' });
  }
  return result;
}
