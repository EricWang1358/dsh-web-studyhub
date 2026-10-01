import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { parse } from 'parse5';
import { extractPdf, MAX_PDF_BYTES } from '../../documents.js';

const FORMAT = { '.pdf': 'pdf', '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.txt': 'txt' };
const MIME = { pdf: 'application/pdf', md: 'text/markdown', html: 'text/html', txt: 'text/plain' };
const markdown = new MarkdownIt({ html: false, breaks: false });
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'aside', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'table', 'ul', 'ol', 'dl', 'dt', 'dd', 'header', 'footer', 'figure', 'figcaption']);
const OMIT = new Set(['head', 'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas']);
const ATTACHMENT = /^attachments\/materials\/([a-f0-9]{64})\.(pdf|md|html|txt)$/;

export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const textRevision = text => bytesHash(Buffer.from(String(text), 'utf8'));

export function formatFor(input) {
  const value = input.format === 'markdown' ? 'md' : input.format;
  const format = value || FORMAT[extname(input.filename || input.path || '').toLowerCase()];
  if (!Object.hasOwn(MIME, format)) throw new Error('Supported document formats: PDF, Markdown, HTML, TXT');
  return format;
}

export async function documentBytes(input) {
  if (!!input.path === (input.dataBase64 !== undefined)) throw new Error('Provide exactly one document path or dataBase64');
  let bytes;
  if (input.path) {
    if (!isAbsolute(input.path)) throw new Error('Document path must be absolute');
    const file = await open(input.path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_PDF_BYTES) throw new Error('Document must be a file of at most 8 MB');
      const chunks = []; let offset = 0;
      while (offset <= MAX_PDF_BYTES) {
        const buffer = Buffer.alloc(Math.min(65536, MAX_PDF_BYTES + 1 - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      bytes = Buffer.concat(chunks, offset);
    } finally { await file.close(); }
  } else {
    const encoded = input.dataBase64;
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw new Error('Invalid document dataBase64 or document exceeds 8 MB');
    bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('Invalid document dataBase64');
  }
  if (bytes.length > MAX_PDF_BYTES) throw new Error('Document exceeds 8 MB');
  return bytes;
}

/** Parse rendered content; markup, attributes and executable content are never evidence. */
export function visibleHtmlText(html) {
  const output = [];
  const visit = node => {
    const attrs = Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]));
    if (OMIT.has(node.tagName) || Object.hasOwn(attrs, 'hidden') || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/i.test(attrs.style || '')) return;
    if (node.nodeName === '#text') { output.push(node.value); return; }
    if (node.tagName === 'br') { output.push('\n'); return; }
    if (BLOCKS.has(node.tagName)) output.push('\n');
    for (const child of node.childNodes || []) visit(child);
    if (node.tagName === 'td' || node.tagName === 'th') output.push('\t');
    else if (BLOCKS.has(node.tagName)) output.push('\n');
  };
  visit(parse(html));
  return output.join('').replace(/\n[ \t]*\n+/g, '\n').trim();
}

export async function projectDocument(bytes, { format, filename, pages }) {
  if (format === 'pdf') {
    try { return await extractPdf({ dataBase64: bytes.toString('base64'), filename, ...(pages !== undefined ? { pages } : {}) }); }
    catch (error) {
      if (!/均未提取到足够文字/.test(error.message)) throw error;
      return { sources: [], warnings: [error.message], projectionUnavailable: true };
    }
  }
  let original;
  try { original = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Text documents must use UTF-8 encoding'); }
  const text = format === 'md' ? visibleHtmlText(markdown.render(original)) : format === 'html' ? visibleHtmlText(original) : original;
  if (text.length > 600000) throw new Error('Extracted text exceeds 600,000 characters');
  return { sources: text.trim() ? [{ text }] : [], warnings: text.trim() ? [] : ['No selectable text is available in this document.'], projectionUnavailable: !text.trim() };
}

export function attachmentPath(root, attachment) {
  if (!attachment || !ATTACHMENT.test(attachment.path || '') || !attachment.path.includes(attachment.hash)) throw new Error('Invalid material attachment reference');
  return join(root, attachment.path);
}

export async function retainOriginal(root, bytes, format) {
  const hash = bytesHash(bytes);
  const attachment = { path: `attachments/materials/${hash}.${format}`, hash, bytes: bytes.length, format };
  const file = attachmentPath(root, attachment);
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (bytesHash(await readFile(file)) !== hash) throw new Error('The retained original has changed; restore the original attachment before continuing');
  }
  return attachment;
}

export async function originalAvailable(root, attachment) {
  if (!attachment) return false;
  try {
    const bytes = await documentBytes({ path: attachmentPath(root, attachment) });
    return bytes.length === attachment.bytes && bytesHash(bytes) === attachment.hash;
  }
  catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code) || /at most 8 MB|exceeds 8 MB/.test(error.message)) return false;
    throw error;
  }
}

export async function exportAttachments(root, documents) {
  const attachments = new Map();
  for (const document of documents || []) for (const version of document.versions || [])
    if (version.attachment) attachments.set(version.attachment.path, version.attachment);
  return Promise.all([...attachments.values()].map(async attachment => {
    const bytes = await documentBytes({ path: attachmentPath(root, attachment) });
    if (bytesHash(bytes) !== attachment.hash || bytes.length !== attachment.bytes) throw new Error('Cannot export a changed material original');
    return { ...attachment, dataBase64: bytes.toString('base64') };
  }));
}

export async function importAttachments(root, records) {
  if (!Array.isArray(records)) throw new Error('Invalid original attachment backup');
  const verified = await Promise.all(records.map(async record => {
    attachmentPath(root, record);
    const format = formatFor(record), bytes = await documentBytes({ dataBase64: record.dataBase64 });
    if (bytesHash(bytes) !== record.hash || bytes.length !== record.bytes || !record.path.endsWith(`.${format}`)) throw new Error('Original attachment backup hash or size mismatch');
    return { bytes, format };
  }));
  for (const { bytes, format } of verified) await retainOriginal(root, bytes, format);
  return { restored: verified.length };
}

export function filenameFor(input, format) { return basename(input.filename || input.path || `document.${format}`); }
export const mimeFor = format => MIME[format];
