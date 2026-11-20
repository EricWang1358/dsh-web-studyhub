import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import { validateZipEntryPath } from '../../domain/retrieval-policy.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EXTRA_ZIP64_ID = 0x0001;
const UINT32_MAX = 0xffffffff;
const DEFAULT_MAX_ENTRIES = 120_000;
const DEFAULT_MAX_BYTES = 1536 * 1024 * 1024;

function zipError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readExactFromHandle(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw zipError('extension-extract', 'Unexpected EOF while reading ZIP archive');
    offset += bytesRead;
  }
  return buffer;
}

async function openZipSource(zipInput) {
  if (typeof zipInput === 'string') {
    const info = await stat(zipInput);
    const handle = await open(zipInput, 'r');
    return {
      size: info.size,
      readAt: (position, length) => readExactFromHandle(handle, length, position),
      createSliceStream: (start, length) => createReadStream(zipInput, { start, end: start + length - 1 }),
      close: () => handle.close(),
    };
  }
  const buf = Buffer.isBuffer(zipInput) ? zipInput : Buffer.from(zipInput);
  return {
    size: buf.length,
    readAt: async (position, length) => {
      if (position < 0 || position + length > buf.length) {
        throw zipError('extension-extract', 'Unexpected EOF while reading ZIP archive');
      }
      return buf.subarray(position, position + length);
    },
    createSliceStream: (start, length) => Readable.from([buf.subarray(start, start + length)]),
    close: async () => {},
  };
}

function findEocdInTail(tail) {
  if (tail.length < 22) throw zipError('extension-extract', 'ZIP archive is too small');
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + 22 + commentLen === tail.length) return i;
  }
  throw zipError('extension-extract', 'ZIP archive is missing end-of-central-directory signature');
}

async function readCentralDirectoryMeta(source) {
  if (source.size < 22) throw zipError('extension-extract', 'ZIP archive is too small');
  const tailLen = Math.min(source.size, 65557 + 76);
  const tail = await source.readAt(source.size - tailLen, tailLen);
  const eocdPos = findEocdInTail(tail);

  let totalEntries = tail.readUInt16LE(eocdPos + 10);
  let centralSize = tail.readUInt32LE(eocdPos + 12);
  let centralOffset = tail.readUInt32LE(eocdPos + 16);

  if (eocdPos >= 20 && tail.readUInt32LE(eocdPos - 20) === SIG_ZIP64_LOCATOR) {
    const zip64Offset = Number(tail.readBigUInt64LE(eocdPos - 12));
    if (zip64Offset < 0 || zip64Offset + 56 > source.size) {
      throw zipError('extension-extract', 'ZIP64 end-of-central-directory record is invalid');
    }
    const zip64 = await source.readAt(zip64Offset, 56);
    if (zip64.readUInt32LE(0) !== SIG_ZIP64_EOCD) {
      throw zipError('extension-extract', 'ZIP64 end-of-central-directory record is invalid');
    }
    totalEntries = Number(zip64.readBigUInt64LE(32));
    centralSize = Number(zip64.readBigUInt64LE(40));
    centralOffset = Number(zip64.readBigUInt64LE(48));
  }

  if (centralOffset < 0 || centralOffset + centralSize > source.size) {
    throw zipError('extension-extract', 'ZIP central directory bounds are out of range');
  }
  return { totalEntries, centralSize, centralOffset };
}

function applyZip64Extra(buf, extraStart, extraEnd, sizes) {
  let cursor = extraStart;
  while (cursor + 4 <= extraEnd) {
    const headerId = buf.readUInt16LE(cursor);
    const dataSize = buf.readUInt16LE(cursor + 2);
    const dataStart = cursor + 4;
    const dataEnd = dataStart + dataSize;
    cursor = dataEnd;
    if (headerId !== EXTRA_ZIP64_ID || dataEnd > extraEnd) continue;

    let pos = dataStart;
    const out = { ...sizes };
    if (out.uncompressedSize === UINT32_MAX && pos + 8 <= dataEnd) {
      out.uncompressedSize = Number(buf.readBigUInt64LE(pos));
      pos += 8;
    }
    if (out.compressedSize === UINT32_MAX && pos + 8 <= dataEnd) {
      out.compressedSize = Number(buf.readBigUInt64LE(pos));
      pos += 8;
    }
    if (out.localOffset === UINT32_MAX && pos + 8 <= dataEnd) {
      out.localOffset = Number(buf.readBigUInt64LE(pos));
    }
    return out;
  }
  return sizes;
}

function readCentralEntry(buf, cursor) {
  if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
    throw zipError('extension-extract', 'ZIP archive has corrupt central directory header');
  }
  const versionMadeBy = buf.readUInt16LE(cursor + 4);
  const method = buf.readUInt16LE(cursor + 10);
  const expectedCrc = buf.readUInt32LE(cursor + 16);
  const nameLen = buf.readUInt16LE(cursor + 28);
  const extraLen = buf.readUInt16LE(cursor + 30);
  const commentLen = buf.readUInt16LE(cursor + 32);
  const externalAttrs = buf.readUInt32LE(cursor + 38);
  const nameStart = cursor + 46;
  const extraStart = nameStart + nameLen;
  const extraEnd = extraStart + extraLen;
  const nextCursor = extraEnd + commentLen;
  if (nextCursor > buf.length) {
    throw zipError('extension-extract', 'ZIP central directory entry extends past archive end');
  }

  const baseSizes = {
    compressedSize: buf.readUInt32LE(cursor + 20),
    uncompressedSize: buf.readUInt32LE(cursor + 24),
    localOffset: buf.readUInt32LE(cursor + 42),
  };
  const needsZip64 = baseSizes.compressedSize === UINT32_MAX
    || baseSizes.uncompressedSize === UINT32_MAX
    || baseSizes.localOffset === UINT32_MAX;
  const resolvedSizes = needsZip64 ? applyZip64Extra(buf, extraStart, extraEnd, baseSizes) : baseSizes;

  return {
    name: buf.subarray(nameStart, extraStart).toString('utf8'),
    versionMadeBy,
    method,
    expectedCrc,
    externalAttrs,
    ...resolvedSizes,
    nextCursor,
  };
}

function assertSafeTarget(destRoot, rawName, externalAttrs) {
  const unixType = (externalAttrs >>> 16) & 0xf000;
  if (unixType === 0xa000) {
    throw zipError('extension-zip-unsafe', `ZIP archive contains symlink entry: ${rawName}`);
  }
  const checked = validateZipEntryPath(rawName);
  if (!checked.ok) {
    throw zipError('extension-zip-unsafe', `Unsafe ZIP entry path (${checked.reason}): ${rawName}`);
  }
  const targetPath = resolve(destRoot, checked.normalized);
  const rel = relative(destRoot, targetPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw zipError('extension-zip-unsafe', `ZIP entry escapes target directory: ${rawName}`);
  }
  return { targetPath, isDir: checked.isDir };
}

/** Extract Unix file mode bits from a ZIP central directory entry (preserving +x while keeping owner rw). */
export function unixModeOfZipEntry(entry) {
  const unixType = (entry.externalAttrs >>> 16) & 0xf000;
  const madeByUnix = (entry.versionMadeBy >>> 8) === 3;
  const perms = (entry.externalAttrs >>> 16) & 0o777;
  if ((unixType === 0x8000 || madeByUnix) && perms !== 0) {
    return (perms | 0o600) & 0o777;
  }
  return null;
}

async function applyEntryUnixMode(targetPath, entry, platform, chmodFile) {
  if (platform === 'win32') return;
  const mode = unixModeOfZipEntry(entry);
  if (mode !== null) await chmodFile(targetPath, mode);
}

function createVerifyStream(entry, maxRemainingBytes, onStats) {
  let actualCrc = 0;
  let written = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      if (written > maxRemainingBytes || written > entry.uncompressedSize) {
        callback(zipError('extension-extract', `ZIP archive exceeds maximum extracted size at ${entry.name}`));
        return;
      }
      actualCrc = crc32(chunk, actualCrc);
      onStats(written, actualCrc >>> 0);
      callback(null, chunk);
    },
  });
}

async function resolveEntryDataStart(source, entry, maxRemainingBytes) {
  const { localOffset, compressedSize, uncompressedSize, name } = entry;
  if (localOffset < 0 || localOffset + 30 > source.size) {
    throw zipError('extension-extract', `Corrupt local file header for ${name}`);
  }
  const lfh = await source.readAt(localOffset, 30);
  if (lfh.readUInt32LE(0) !== SIG_LOCAL) {
    throw zipError('extension-extract', `Corrupt local file header for ${name}`);
  }
  const dataStart = localOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  if (dataStart < 0 || compressedSize < 0 || dataStart + compressedSize > source.size) {
    throw zipError('extension-extract', `ZIP entry payload out of range for ${name}`);
  }
  if (uncompressedSize > maxRemainingBytes) {
    throw zipError('extension-extract', `ZIP archive exceeds maximum extracted size at ${name}`);
  }
  return dataStart;
}

async function streamEntryToFile({ source, entry, targetPath, maxRemainingBytes }) {
  const dataStart = await resolveEntryDataStart(source, entry, maxRemainingBytes);
  const { compressedSize, uncompressedSize, method, expectedCrc, name } = entry;
  if (compressedSize === 0 && uncompressedSize === 0) {
    if ((expectedCrc >>> 0) !== 0) throw zipError('extension-extract', `ZIP CRC32 mismatch while extracting ${name}`);
    const empty = await open(targetPath, 'w');
    await empty.close();
    return 0;
  }
  if (compressedSize === 0) {
    throw zipError('extension-extract', `ZIP size mismatch while extracting ${name}`);
  }
  if (method !== 0 && method !== 8) {
    throw zipError('extension-extract', `Unsupported ZIP compression method ${method} for ${name}`);
  }

  let written = 0;
  let actualCrc = 0;
  const verify = createVerifyStream(entry, maxRemainingBytes, (bytes, crc) => {
    written = bytes;
    actualCrc = crc;
  });
  const input = source.createSliceStream(dataStart, compressedSize);
  const output = createWriteStream(targetPath);
  const streams = method === 8 ? [input, createInflateRaw(), verify, output] : [input, verify, output];
  try {
    await pipeline(...streams);
    if (written !== uncompressedSize) throw zipError('extension-extract', `ZIP size mismatch while extracting ${name}`);
    if ((actualCrc >>> 0) !== (expectedCrc >>> 0)) {
      throw zipError('extension-extract', `ZIP CRC32 mismatch while extracting ${name}`);
    }
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
  return written;
}

/**
 * Extract all entries from a standard ZIP or ZIP64 archive (file path or Buffer) into `destDir`
 * using non-blocking async streaming decompression, strictly enforcing Zip-Slip protection,
 * symlink rejection, Unix +x permission restoration, CRC32 verification, and size bounds.
 */
export async function extractZipArchive(
  zipInput,
  destDir,
  { maxEntries = DEFAULT_MAX_ENTRIES, maxExtractedBytes = DEFAULT_MAX_BYTES, platform = process.platform, chmodFile = chmod } = {}
) {
  const source = await openZipSource(zipInput);
  try {
    const { totalEntries, centralSize, centralOffset } = await readCentralDirectoryMeta(source);
    if (totalEntries > maxEntries) throw zipError('extension-extract', `ZIP archive has too many entries (${totalEntries})`);
    const cdBuf = centralSize > 0 ? await source.readAt(centralOffset, centralSize) : Buffer.alloc(0);
    const destRoot = resolve(destDir);
    await mkdir(destRoot, { recursive: true });
    const createdDirs = new Set([destRoot]);
    const ensureDir = async (dir) => {
      if (createdDirs.has(dir)) return;
      await mkdir(dir, { recursive: true });
      createdDirs.add(dir);
    };

    let cursor = 0;
    let extractedBytes = 0;
    let fileCount = 0;
    for (let i = 0; i < totalEntries; i += 1) {
      const entry = readCentralEntry(cdBuf, cursor);
      cursor = entry.nextCursor;
      const { targetPath, isDir } = assertSafeTarget(destRoot, entry.name, entry.externalAttrs);
      if (isDir) {
        await ensureDir(targetPath);
        continue;
      }
      await ensureDir(dirname(targetPath));
      extractedBytes += await streamEntryToFile({ source, entry, targetPath, maxRemainingBytes: maxExtractedBytes - extractedBytes });
      await applyEntryUnixMode(targetPath, entry, platform, chmodFile);
      fileCount += 1;
    }
    return { fileCount, extractedBytes };
  } finally {
    await source.close().catch(() => {});
  }
}
