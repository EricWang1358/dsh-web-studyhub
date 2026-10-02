import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { MAX_OFFICE_BYTES, megabytes } from '../../office/limits.js';
import { attachmentPath, bytesHash, formatFor } from './files.js';

/* Originals that are attached to a document that only kept its text (WP "补全原文件").
   Two ways to hold one: a COPY in the library (version.attachment, exactly like a retained original) or a REFERENCE
   to the learner's own file (version.external: path, size, mtime, hash). Files are always read in small chunks here;
   only a file that must be parsed (to verify it) or served to the reader is ever held in memory, and never more than
   ORIGINAL_MAX_BYTES. */

/** The largest original that can be attached: it must fit one request when the reader loads it (the Word / PowerPoint limit). */
export const ORIGINAL_MAX_BYTES = MAX_OFFICE_BYTES;
const CHUNK = 256 * 1024;
const tooBig = () => new Error(`Document must be a file of at most ${megabytes(ORIGINAL_MAX_BYTES)} MB`);
const GONE = new Set(['ENOENT', 'ENOTDIR']);
const DENIED = new Set(['EACCES', 'EPERM', 'EBUSY']);
const drain = () => new Writable({ write(_chunk, _encoding, done) { done(); } });

/** SHA-256 of a file, read as a stream of small chunks. onChunk(size) is for tests and progress. */
export async function hashFile(path, { limit = Infinity, onChunk } = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  const counted = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > limit) return done(tooBig());
    hash.update(chunk); onChunk?.(chunk.length); done();
  } });
  await pipeline(createReadStream(path, { highWaterMark: CHUNK }), counted, drain());
  return { hash: hash.digest('hex'), bytes };
}

/** The file's bytes (bounded by `expected`, which is the size recorded when it was attached), verified against its recorded hash. */
export async function readFileChecked(path, { bytes: expected, hash: wanted }) {
  const chunks = []; let size = 0;
  const hash = createHash('sha256');
  const collector = new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > expected) return done(new Error('The original changed while being read'));
    hash.update(chunk); chunks.push(chunk); done();
  } });
  await pipeline(createReadStream(path, { highWaterMark: CHUNK }), collector, drain());
  if (size !== expected || hash.digest('hex') !== wanted) throw new Error('The original changed while being read');
  return Buffer.concat(chunks, size);
}

/**
 * What a path names: an absolute file of the document's own type, no larger than the limit.
 * Throws plain English errors a person can act on.
 */
export async function inspectFile(input, format) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Provide the original file path');
  if (!isAbsolute(input)) throw new Error('Document path must be absolute');
  const path = resolve(input);
  let real, info;
  try { real = await realpath(path); info = await stat(path); }
  catch (error) {
    if (GONE.has(error.code)) throw new Error(`The file was not found: ${path}`);
    if (DENIED.has(error.code)) throw new Error(`The file cannot be read: ${path}`);
    throw error;
  }
  if (!info.isFile() || info.size > ORIGINAL_MAX_BYTES) throw tooBig();
  const own = formatFor({ filename: path });
  if (own !== format) throw new Error(`The file must be the same type as the document (${format}), not ${own}`);
  return { path, realPath: real, bytes: info.size, mtimeMs: info.mtimeMs };
}

/** Bytes that arrived in a request (a file the browser chose), within the same limit. */
export function decodeUpload(encoded) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(ORIGINAL_MAX_BYTES / 3) * 4 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error(`Invalid document dataBase64 or document exceeds ${megabytes(ORIGINAL_MAX_BYTES)} MB`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Invalid document dataBase64');
  return bytes;
}

/** Copy a file into the library as a retained original (same content-addressed place and shape as retainOriginal), streaming. */
export async function copyOriginalFile(root, path, format) {
  const folder = join(root, 'attachments', 'materials');
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `.incoming-${randomUUID()}.tmp`), hash = createHash('sha256');
  let bytes = 0;
  const copier = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > ORIGINAL_MAX_BYTES) return done(tooBig());
    hash.update(chunk); done(null, chunk);
  } });
  try {
    await pipeline(createReadStream(path, { highWaterMark: CHUNK }), copier, createWriteStream(temporary, { flags: 'wx' }));
    const digest = hash.digest('hex');
    const attachment = { path: `attachments/materials/${digest}.${format}`, hash: digest, bytes, format };
    const target = attachmentPath(root, attachment);
    const existing = await stat(target).catch(() => null);
    if (existing) {
      if (existing.size !== bytes || (await hashFile(target)).hash !== digest) throw new Error('The retained original has changed; restore the original attachment before continuing');
    } else await rename(temporary, target);
    return attachment;
  } finally { await rm(temporary, { force: true }); }
}

/** Write bytes that arrived in a request as a retained original of any size within the limit. */
export async function storeOriginalBytes(root, bytes, format) {
  const attachment = { path: `attachments/materials/${bytesHash(bytes)}.${format}`, hash: bytesHash(bytes), bytes: bytes.length, format };
  const target = attachmentPath(root, attachment);
  await mkdir(dirname(target), { recursive: true });
  const existing = await stat(target).catch(() => null);
  if (existing) {
    if (existing.size !== bytes.length || (await hashFile(target)).hash !== attachment.hash) throw new Error('The retained original has changed; restore the original attachment before continuing');
    return attachment;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await pipeline(async function* () { yield bytes; }, createWriteStream(temporary, { flags: 'wx' })); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  return attachment;
}

/** The record kept on a document revision for a referenced original. */
export const externalRecord = (file, hash, format, verifiedAt = new Date().toISOString()) =>
  ({ path: file.path, realPath: file.realPath, bytes: file.bytes, mtimeMs: file.mtimeMs, hash, format, verifiedAt });

/**
 * Where a revision's original stands. Cheap by default (a size and date check for a referenced file);
 * `deep` reads and verifies the bytes. Never throws for a file that is merely missing, moved, changed or unreadable.
 */
export async function originalStatus(root, version, { deep = false } = {}) {
  const attachment = version.attachment;
  if (attachment) {
    const intact = await copyIntact(root, attachment);
    if (intact) return { mode: 'copy', status: 'ok', bytes: attachment.bytes, format: attachment.format };
    if (!version.external) return { mode: 'copy', status: 'missing', bytes: attachment.bytes, format: attachment.format };
  }
  const external = version.external;
  if (!external) return { mode: null, status: 'none' };
  const base = { mode: 'reference', path: external.path, bytes: external.bytes, format: external.format, verifiedAt: external.verifiedAt };
  let info, real;
  try { info = await stat(external.path); real = await realpath(external.path); }
  catch (error) { return { ...base, status: GONE.has(error.code) ? 'missing' : 'unreadable', reason: GONE.has(error.code) ? 'missing' : 'unreadable' }; }
  if (!info.isFile()) return { ...base, status: 'missing', reason: 'missing' };
  if (real !== (external.realPath || external.path)) return { ...base, status: 'changed', reason: 'redirected' };
  if (info.size !== external.bytes) return { ...base, status: 'changed', reason: 'changed' };
  if (deep || info.mtimeMs !== external.mtimeMs) {
    try { if ((await hashFile(external.path, { limit: ORIGINAL_MAX_BYTES })).hash !== external.hash) return { ...base, status: 'changed', reason: 'changed' }; }
    catch (error) { return /at most \d+ MB/.test(error.message) ? { ...base, status: 'changed', reason: 'changed' } : { ...base, status: 'unreadable', reason: 'unreadable' }; }
  }
  return { ...base, status: 'ok' };
}

async function copyIntact(root, attachment) {
  try { const { hash, bytes } = await hashFile(attachmentPath(root, attachment), { limit: ORIGINAL_MAX_BYTES }); return bytes === attachment.bytes && hash === attachment.hash; }
  catch (error) {
    if (GONE.has(error.code) || DENIED.has(error.code) || error.code === 'EISDIR' || /at most \d+ MB/.test(error.message)) return false;
    throw error;
  }
}

/**
 * The verified bytes of a revision's original, for the reader. A referenced file is read from its stored path only,
 * and only if it is still the very file that was verified; otherwise the reason is returned, never the bytes.
 */
export async function readOriginal(root, version) {
  const attachment = version.attachment;
  if (attachment && await copyIntact(root, attachment))
    return { status: 'ok', mode: 'copy', bytes: await readFileChecked(attachmentPath(root, attachment), attachment) };
  if (!version.external) return { status: 'unavailable', reason: 'none' };
  const state = await originalStatus(root, version, { deep: false });
  if (state.status !== 'ok') return { status: 'unavailable', reason: state.reason || state.status, path: state.path, mode: 'reference' };
  try { return { status: 'ok', mode: 'reference', bytes: await readFileChecked(version.external.path, version.external) }; }
  catch (error) {
    return { status: 'unavailable', mode: 'reference', path: version.external.path, reason: GONE.has(error.code) ? 'missing' : DENIED.has(error.code) ? 'unreadable' : 'changed' };
  }
}
