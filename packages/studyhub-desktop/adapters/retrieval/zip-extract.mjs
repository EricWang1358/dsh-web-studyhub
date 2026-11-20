import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
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

function findEocdOffset(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw zipError('extension-extract', 'ZIP archive is too small');
  }
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw zipError('extension-extract', 'ZIP archive is missing end-of-central-directory signature');
}

function readCentralDirectoryMeta(buf, eocdOffset) {
  let totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let centralSize = buf.readUInt32LE(eocdOffset + 12);
  let centralOffset = buf.readUInt32LE(eocdOffset + 16);

  if (eocdOffset >= 20 && buf.readUInt32LE(eocdOffset - 20) === SIG_ZIP64_LOCATOR) {
    const zip64Offset = Number(buf.readBigUInt64LE(eocdOffset - 12));
    if (zip64Offset < 0 || zip64Offset + 56 > buf.length || buf.readUInt32LE(zip64Offset) !== SIG_ZIP64_EOCD) {
      throw zipError('extension-extract', 'ZIP64 end-of-central-directory record is invalid');
    }
    totalEntries = Number(buf.readBigUInt64LE(zip64Offset + 32));
    centralSize = Number(buf.readBigUInt64LE(zip64Offset + 40));
    centralOffset = Number(buf.readBigUInt64LE(zip64Offset + 48));
  }

  if (centralOffset < 0 || centralOffset + centralSize > buf.length) {
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
  const resolvedSizes = (
    baseSizes.compressedSize === UINT32_MAX
    || baseSizes.uncompressedSize === UINT32_MAX
    || baseSizes.localOffset === UINT32_MAX
  )
    ? applyZip64Extra(buf, extraStart, extraEnd, baseSizes)
    : baseSizes;

  return {
    name: buf.subarray(nameStart, extraStart).toString('utf8'),
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
  return { targetPath, isDir: checked.isDir, normalized: checked.normalized };
}

function extractEntryBytes(buf, entry, maxRemainingBytes) {
  const { localOffset, compressedSize, uncompressedSize, method, expectedCrc, name } = entry;
  if (localOffset < 0 || localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw zipError('extension-extract', `Corrupt local file header for ${name}`);
  }
  const localNameLen = buf.readUInt16LE(localOffset + 26);
  const localExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buf.length || dataStart < 0 || compressedSize < 0) {
    throw zipError('extension-extract', `ZIP entry payload out of range for ${name}`);
  }
  if (uncompressedSize > maxRemainingBytes) {
    throw zipError('extension-extract', `ZIP archive exceeds maximum extracted size at ${name}`);
  }

  const slice = buf.subarray(dataStart, dataEnd);
  let data;
  if (method === 0) {
    data = slice;
  } else if (method === 8) {
    data = inflateRawSync(slice, { maxOutputLength: maxRemainingBytes });
  } else {
    throw zipError('extension-extract', `Unsupported ZIP compression method ${method} for ${name}`);
  }

  if (data.length !== uncompressedSize) {
    throw zipError('extension-extract', `ZIP size mismatch while extracting ${name}`);
  }
  if ((crc32(data) >>> 0) !== expectedCrc) {
    throw zipError('extension-extract', `ZIP CRC32 mismatch while extracting ${name}`);
  }
  return data;
}

/**
 * Extract all entries from a standard ZIP or ZIP64 buffer into `destDir`,
 * strictly enforcing Zip-Slip protection, symlink rejection, CRC32 checks, and size bounds.
 */
export async function extractZipArchive(
  zipBuffer,
  destDir,
  { maxEntries = DEFAULT_MAX_ENTRIES, maxExtractedBytes = DEFAULT_MAX_BYTES } = {}
) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  const eocdOffset = findEocdOffset(buf);
  const { totalEntries, centralOffset } = readCentralDirectoryMeta(buf, eocdOffset);
  if (totalEntries > maxEntries) {
    throw zipError('extension-extract', `ZIP archive has too many entries (${totalEntries})`);
  }

  const destRoot = resolve(destDir);
  await mkdir(destRoot, { recursive: true });
  const createdDirs = new Set([destRoot]);
  const ensureDir = async (dir) => {
    if (createdDirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    createdDirs.add(dir);
  };

  let cursor = centralOffset;
  let extractedBytes = 0;
  let fileCount = 0;

  for (let i = 0; i < totalEntries; i += 1) {
    const entry = readCentralEntry(buf, cursor);
    cursor = entry.nextCursor;
    const { targetPath, isDir } = assertSafeTarget(destRoot, entry.name, entry.externalAttrs);
    if (isDir) {
      await ensureDir(targetPath);
      continue;
    }
    const data = extractEntryBytes(buf, entry, maxExtractedBytes - extractedBytes);
    extractedBytes += data.length;
    await ensureDir(dirname(targetPath));
    await writeFile(targetPath, data);
    fileCount += 1;
  }

  return { fileCount, extractedBytes };
}
