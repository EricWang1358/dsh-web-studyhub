import { createHash } from 'node:crypto';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, basename, extname } from 'node:path';
import { id as makeId } from './util.js';

/* An interactive diagram of a skeleton, drawn by the learner's own agent with an outside tool (the open-source Archify skill is the one
   docs/companions.md recommends) and handed to the library as one HTML file. StudyHub only stores it and shows it in an isolated frame
   (ui/SkeletonCompanion.jsx); it never runs, parses for meaning, or sends the file anywhere.

   What the library accepts is deliberately narrow: a regular file that the real path (symbolic links resolved) puts inside the session
   workspace or the library, at most 5 MB, one UTF-8 document that starts like an HTML page. The copy lives at
   <library>/skeleton-diagrams/<skeleton id>/<diagram id>.html; the skeleton record keeps the small index. */

export const MAX_DIAGRAM_BYTES = 5 * 1024 * 1024;
export const MAX_DIAGRAMS = 8;
export const DIAGRAM_FOLDER = 'skeleton-diagrams';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const notFound = (message) => Object.assign(new Error(message), { code: 'not-found' });

const OUTSIDE = '这个文件不在当前工作目录或学习库里，不能挂到骨架上。';
const NOT_HTML = '这个文件不是 HTML 文档（开头要有 <!doctype html> 或 <html>）。';

/** Whether `child` is `parent` or lies below it (both real paths). */
function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!!path && !path.startsWith('..') && !isAbsolute(path));
}

/** The path as the conversation gives it: quoted, @-mentioned, or relative to `base`. */
function given(value, base) {
  if (typeof value !== 'string') throw new Error('请给出要挂上去的 HTML 文件路径。');
  const clean = value.trim().replace(/^"(.*)"$/, '$1').replace(/^@/, '').replace(/^"(.*)"$/, '$1').trim();
  if (!clean || clean.length > 4096 || clean.includes('\0')) throw new Error('请给出要挂上去的 HTML 文件路径。');
  return isAbsolute(clean) ? clean : resolve(base, clean);
}

/** True when the text starts like an HTML page: a doctype or an html element, after only blanks, comments and an XML declaration. */
export function looksLikeHtml(text) {
  let rest = text.replace(/^﻿/, '').slice(0, 4096);
  for (let step = 0; step < 20; step += 1) {
    const trimmed = rest.replace(/^\s+/, '');
    rest = trimmed.replace(/^(?:<!--[\s\S]*?-->|<\?xml[\s\S]*?\?>)/i, '');
    if (rest === trimmed) break;
  }
  return /^<!doctype\s+html\b/i.test(rest) || /^<html[\s>]/i.test(rest);
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
/** The page's own <title>, tidied, or ''. */
export function titleOf(text) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text.slice(0, 65536));
  return match ? match[1].replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITIES[entity]).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}
const tidy = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * Read the file the agent made. `workspace` is the session's folder (set by the host, never by the caller); `root` is the library.
 * Rejects, with a plain reason, everything that is not one HTML document inside those two folders.
 * @returns {Promise<{ text: string, bytes: number, sha256: string, name: string }>}
 */
export async function readDiagramSource({ path, workspace = '', root }) {
  const target = given(path, workspace || root);
  const allowed = [];
  for (const folder of [workspace, root]) {
    if (!folder) continue;
    try { allowed.push(await realpath(folder)); } catch { /* a folder that is not there allows nothing */ }
  }
  let real;
  try { real = await realpath(target); } catch { throw new Error('找不到这个文件。'); }
  if (!allowed.some((folder) => inside(folder, real))) throw new Error(OUTSIDE);
  const handle = await open(real, 'r').catch(() => { throw new Error('找不到这个文件。'); });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('这个路径不是普通文件。');
    if (info.size > MAX_DIAGRAM_BYTES) throw new Error('这个文件超过 5 MB，不能挂到骨架上。');
    const buffer = Buffer.alloc(Math.min(info.size, MAX_DIAGRAM_BYTES) + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
      if (read >= buffer.length) break;
    }
    if (read > MAX_DIAGRAM_BYTES) throw new Error('这个文件超过 5 MB，不能挂到骨架上。');
    const bytes = buffer.subarray(0, read);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('这个文件不是 UTF-8 文本，不能挂到骨架上。'); }
    if (!looksLikeHtml(text)) throw new Error(NOT_HTML);
    return { text, bytes: read, sha256: createHash('sha256').update(bytes).digest('hex'), name: basename(real, extname(real)) };
  } finally { await handle.close(); }
}

const folderOf = (root, skeletonId) => {
  if (!SAFE_ID.test(String(skeletonId))) throw notFound('Skeleton not found');
  return join(root, DIAGRAM_FOLDER, skeletonId);
};
const fileOf = (root, skeletonId, diagramId) => {
  if (!SAFE_ID.test(String(diagramId))) throw notFound('Diagram not found');
  return join(folderOf(root, skeletonId), `${diagramId}.html`);
};

/** Copy the text into the library atomically (a temporary file in the same folder, then a rename). */
export async function writeDiagramFile(root, skeletonId, diagramId, text) {
  const target = fileOf(root, skeletonId, diagramId);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${makeId()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return target;
}

/** The stored document of one record, checked against the record: a missing or changed file is reported, never returned. */
export async function readDiagramFile(root, skeletonId, record) {
  const file = fileOf(root, skeletonId, record.id);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error('这张图的文件已不在学习库里，可以删除这条记录。');
  if (info.size > MAX_DIAGRAM_BYTES) throw new Error('这张图的文件已被改动，没有显示。可以删除后重新挂一次。');
  const handle = await open(file, 'r');
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  if (bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256)
    throw new Error('这张图的文件已被改动，没有显示。可以删除后重新挂一次。');
  return { html: bytes.toString('utf8'), file };
}

/** Delete the stored copies of some diagrams of a skeleton; a copy that is already gone is fine. */
export async function removeDiagramFiles(root, skeletonId, diagramIds) {
  for (const diagramId of diagramIds) await rm(fileOf(root, skeletonId, diagramId), { force: true });
}
/** Delete every stored diagram of a skeleton (the skeleton itself was deleted). */
export async function removeDiagramFolder(root, skeletonId) {
  if (SAFE_ID.test(String(skeletonId))) await rm(folderOf(root, skeletonId), { recursive: true, force: true });
}

/* The full backup (`export`) carries the stored files beside the library state, like the original attachments of materials: the records
   are already in `skeletons`, the files are in `portableDiagrams`. A file that is gone is left out (the record then says so when opened);
   a restore checks every file against its record before anything is replaced. */
export const DIAGRAM_BACKUP = 'study-skeleton-diagrams/v1';

/** The stored files of every attached diagram, for a backup. Returns [] when there is nothing to carry. */
export async function exportDiagramFiles(root, skeletons) {
  const files = [];
  for (const skeleton of skeletons || []) for (const record of skeleton.diagrams || []) {
    try {
      const { html } = await readDiagramFile(root, skeleton.id, record);
      files.push({ skeletonId: skeleton.id, id: record.id, sha256: record.sha256, bytes: record.bytes, dataBase64: Buffer.from(html, 'utf8').toString('base64') });
    } catch { /* a missing or changed copy is not carried */ }
  }
  return files;
}

/** Check a backup's files against the restored skeletons' records. Returns what to write; throws before anything is written. */
export function verifyDiagramBackup(backup, skeletons) {
  if (backup?.format !== DIAGRAM_BACKUP || !Array.isArray(backup.files)) throw new Error('Portable backup has an unreadable diagram section');
  const verified = [];
  for (const file of backup.files) {
    const skeleton = (skeletons || []).find((item) => item.id === file?.skeletonId);
    const record = skeleton?.diagrams?.find((item) => item.id === file.id);
    if (!record) continue;
    const bytes = Buffer.from(String(file.dataBase64 || ''), 'base64');
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* checked below */ }
    if (!SAFE_ID.test(skeleton.id) || !SAFE_ID.test(record.id) || bytes.length > MAX_DIAGRAM_BYTES || bytes.length !== record.bytes
      || createHash('sha256').update(bytes).digest('hex') !== record.sha256 || !looksLikeHtml(text))
      throw new Error('Portable backup diagram does not match its record');
    verified.push({ skeletonId: skeleton.id, id: record.id, text });
  }
  return verified;
}

/** Write verified files into a library (after its state was restored). */
export async function restoreDiagramFiles(root, verified) {
  for (const file of verified) await writeDiagramFile(root, file.skeletonId, file.id, file.text);
  return { restored: verified.length };
}

/** One record as the page and the agent read it: whether the skeleton changed since the diagram was attached rides along. */
export const diagramView = (skeleton, record) => ({ ...record, stale: record.skeletonRevision !== skeleton.updatedAt });

/** A record for a new diagram. `title` may be empty: the document's own title, then the file name, stand in. */
export function newDiagramRecord({ skeleton, source, title }) {
  return { id: makeId(), title: tidy(title) || titleOf(source.text) || tidy(source.name) || 'diagram',
    createdAt: new Date().toISOString(), bytes: source.bytes, sha256: source.sha256, skeletonRevision: skeleton.updatedAt };
}

/** Keep the newest MAX_DIAGRAMS records; the oldest are returned so their files can go. */
export function addDiagram(skeleton, record) {
  skeleton.diagrams = [...(skeleton.diagrams || []), record];
  return skeleton.diagrams.splice(0, Math.max(0, skeleton.diagrams.length - MAX_DIAGRAMS));
}

/**
 * The host (never the caller) says which folder the session works in: whatever `workspace` the arguments carried is replaced, so
 * the agent cannot widen where a diagram may be read from. Other actions are returned as they are.
 */
export function scopeDiagramArgs(action, args, cwd) {
  if (action !== 'skeleton.diagram.attach') return args;
  return { ...args, workspace: typeof cwd === 'string' ? cwd : '' };
}
