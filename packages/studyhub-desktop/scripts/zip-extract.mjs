import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) throw new Error('Unexpected EOF while reading ZIP archive');
    read += bytesRead;
  }
  return buffer;
}

function findEocdInTail(tail) {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + 22 + commentLen === tail.length) return i;
  }
  throw new Error('ZIP archive is missing end-of-central-directory signature');
}

async function readCentralDirectoryMeta(handle, fileSize) {
  const tailLen = Math.min(fileSize, 65557 + 76);
  const tailStart = fileSize - tailLen;
  const tail = await readExact(handle, tailLen, tailStart);
  const eocdPos = findEocdInTail(tail);

  let totalEntries = tail.readUInt16LE(eocdPos + 10);
  let centralSize = tail.readUInt32LE(eocdPos + 12);
  let centralOffset = tail.readUInt32LE(eocdPos + 16);

  const needZip64 = totalEntries === U16_MAX || centralSize === U32_MAX || centralOffset === U32_MAX;
  const locatorPos = eocdPos - 20;
  if (needZip64 && locatorPos >= 0 && tail.readUInt32LE(locatorPos) === ZIP64_LOCATOR_SIG) {
    const eocd64Offset = Number(tail.readBigUInt64LE(locatorPos + 8));
    const eocd64 = await readExact(handle, 56, eocd64Offset);
    if (eocd64.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
      throw new Error('ZIP64 end-of-central-directory signature mismatch');
    }
    totalEntries = Number(eocd64.readBigUInt64LE(32));
    centralSize = Number(eocd64.readBigUInt64LE(40));
    centralOffset = Number(eocd64.readBigUInt64LE(48));
  }
  return { totalEntries, centralSize, centralOffset };
}

function parseZip64Extra(extra, sizes) {
  let cursor = 0;
  let { compressedSize, rawSize, localOffset } = sizes;
  while (cursor + 4 <= extra.length) {
    const tag = extra.readUInt16LE(cursor);
    const len = extra.readUInt16LE(cursor + 2);
    const bodyStart = cursor + 4;
    cursor = bodyStart + len;
    if (tag !== 0x0001) continue;
    let field = bodyStart;
    if (rawSize === U32_MAX) { rawSize = Number(extra.readBigUInt64LE(field)); field += 8; }
    if (compressedSize === U32_MAX) { compressedSize = Number(extra.readBigUInt64LE(field)); field += 8; }
    if (localOffset === U32_MAX) { localOffset = Number(extra.readBigUInt64LE(field)); }
  }
  return { compressedSize, rawSize, localOffset };
}

function parseCentralDirectory(cdBuffer, totalEntries) {
  const entries = [];
  let cursor = 0;
  for (let i = 0; i < totalEntries; i += 1) {
    if (cdBuffer.readUInt32LE(cursor) !== CDH_SIG) {
      throw new Error('ZIP archive has corrupt central directory header');
    }
    const method = cdBuffer.readUInt16LE(cursor + 10);
    const crc = cdBuffer.readUInt32LE(cursor + 16);
    const rawCompressed = cdBuffer.readUInt32LE(cursor + 20);
    const rawUncompressed = cdBuffer.readUInt32LE(cursor + 24);
    const nameLen = cdBuffer.readUInt16LE(cursor + 28);
    const extraLen = cdBuffer.readUInt16LE(cursor + 30);
    const commentLen = cdBuffer.readUInt16LE(cursor + 32);
    const rawOffset = cdBuffer.readUInt32LE(cursor + 42);
    const name = cdBuffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const extra = cdBuffer.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
    cursor += 46 + nameLen + extraLen + commentLen;
    const resolved = parseZip64Extra(extra, {
      compressedSize: rawCompressed, rawSize: rawUncompressed, localOffset: rawOffset,
    });
    entries.push({ name, method, crc, ...resolved });
  }
  return entries;
}

/**
 * Resolve a ZIP entry path strictly inside `destRoot`, rejecting Zip-Slip attempts.
 */
export function resolveSafeZipTarget(destRoot, entryName) {
  if (!entryName || entryName.includes('\0') || entryName.includes('\\')) {
    throw new Error(`Unsafe ZIP entry path: ${entryName}`);
  }
  if (entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName)) {
    throw new Error(`Absolute ZIP entry path rejected: ${entryName}`);
  }
  const segments = entryName.split('/');
  if (segments.some((part) => part === '..')) {
    throw new Error(`Path traversal ZIP entry rejected: ${entryName}`);
  }
  const rootAbs = resolve(destRoot);
  const target = resolve(rootAbs, entryName);
  const rel = relative(rootAbs, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`ZIP entry escapes destination directory: ${entryName}`);
  }
  return target;
}

/**
 * List entries in a standard ZIP or ZIP64 archive on disk.
 */
export async function listZipEntries(zipPath) {
  const { size } = await stat(zipPath);
  const handle = await open(zipPath, 'r');
  try {
    const meta = await readCentralDirectoryMeta(handle, size);
    const cdBuf = await readExact(handle, meta.centralSize, meta.centralOffset);
    return parseCentralDirectory(cdBuf, meta.totalEntries);
  } finally {
    await handle.close();
  }
}

async function extractSingleEntry(handle, zipPath, entry, targetPath) {
  const lfh = await readExact(handle, 30, entry.localOffset);
  if (lfh.readUInt32LE(0) !== LFH_SIG) {
    throw new Error(`Corrupt local header for ${entry.name}`);
  }
  const dataStart = entry.localOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  await mkdir(dirname(targetPath), { recursive: true });
  if (entry.compressedSize === 0 && entry.rawSize === 0) {
    const emptyHandle = await open(targetPath, 'w');
    await emptyHandle.close();
    if (entry.crc !== 0) throw new Error(`CRC32 mismatch on empty entry ${entry.name}`);
    return;
  }

  let actualCrc = 0;
  const crcCheck = new Transform({
    transform(chunk, _enc, cb) {
      actualCrc = crc32(chunk, actualCrc);
      cb(null, chunk);
    },
  });
  const source = createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const sink = createWriteStream(targetPath);
  if (entry.method === 0) {
    await pipeline(source, crcCheck, sink);
  } else if (entry.method === 8) {
    await pipeline(source, createInflateRaw(), crcCheck, sink);
  } else {
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  }
  if ((actualCrc >>> 0) !== (entry.crc >>> 0)) {
    throw new Error(`ZIP CRC32 mismatch while extracting ${entry.name}`);
  }
}

/**
 * Extract all entries from a ZIP or ZIP64 archive safely into `destDir`.
 */
export async function extractZipFile(zipPath, destDir) {
  const { size } = await stat(zipPath);
  const handle = await open(zipPath, 'r');
  try {
    const meta = await readCentralDirectoryMeta(handle, size);
    const cdBuf = await readExact(handle, meta.centralSize, meta.centralOffset);
    const entries = parseCentralDirectory(cdBuf, meta.totalEntries);
    await mkdir(destDir, { recursive: true });
    for (const entry of entries) {
      const target = resolveSafeZipTarget(destDir, entry.name);
      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true });
      } else {
        await extractSingleEntry(handle, zipPath, entry, target);
      }
    }
    return entries;
  } finally {
    await handle.close();
  }
}
