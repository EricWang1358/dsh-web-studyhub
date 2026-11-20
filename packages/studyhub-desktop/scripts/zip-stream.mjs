import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const U32_SAFE = 0xf0000000;
const SMALL_FILE_THRESHOLD = 64 * 1024;

function dosDateTime(date) {
  const source = date instanceof Date ? date : new Date('2026-01-01T00:00:00Z');
  const year = Math.max(1980, source.getUTCFullYear());
  const dosTime = (source.getUTCHours() << 11) | (source.getUTCMinutes() << 5) | Math.floor(source.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((source.getUTCMonth() + 1) << 5) | source.getUTCDate();
  return { dosTime, dosDate };
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, position + written);
    written += bytesWritten;
  }
  return position + written;
}

function buildZip64LocalExtra(rawSize, compressedSize) {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(rawSize), 4);
  extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  return extra;
}

function buildLocalHeader(meta) {
  const extra = meta.needLocalZip64 ? buildZip64LocalExtra(meta.rawSize, meta.compressedSize) : Buffer.alloc(0);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(meta.needLocalZip64 ? 45 : 20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(meta.method, 8);
  header.writeUInt16LE(meta.dosTime, 10);
  header.writeUInt16LE(meta.dosDate, 12);
  header.writeUInt32LE(meta.crc >>> 0, 14);
  header.writeUInt32LE(meta.needLocalZip64 ? U32_MAX : meta.compressedSize, 18);
  header.writeUInt32LE(meta.needLocalZip64 ? U32_MAX : meta.rawSize, 22);
  header.writeUInt16LE(meta.nameBuf.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, meta.nameBuf, extra]);
}

function buildCentralZip64Extra(meta, needSize64, needOffset64) {
  const dataLen = (needSize64 ? 16 : 0) + (needOffset64 ? 8 : 0);
  if (dataLen === 0) return Buffer.alloc(0);
  const extra = Buffer.alloc(4 + dataLen);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(dataLen, 2);
  let cursor = 4;
  if (needSize64) {
    extra.writeBigUInt64LE(BigInt(meta.rawSize), cursor);
    extra.writeBigUInt64LE(BigInt(meta.compressedSize), cursor + 8);
    cursor += 16;
  }
  if (needOffset64) {
    extra.writeBigUInt64LE(BigInt(meta.localOffset), cursor);
  }
  return extra;
}

function buildCentralHeader(meta, forceZip64) {
  const needSize64 = forceZip64 || meta.rawSize >= U32_MAX || meta.compressedSize >= U32_MAX;
  const needOffset64 = forceZip64 || meta.localOffset >= U32_MAX;
  const extra = buildCentralZip64Extra(meta, needSize64, needOffset64);
  const versionNeeded = needSize64 || needOffset64 ? 45 : 20;
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(versionNeeded, 4);
  header.writeUInt16LE(versionNeeded, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(meta.method, 10);
  header.writeUInt16LE(meta.dosTime, 12);
  header.writeUInt16LE(meta.dosDate, 14);
  header.writeUInt32LE(meta.crc >>> 0, 16);
  header.writeUInt32LE(needSize64 ? U32_MAX : meta.compressedSize, 20);
  header.writeUInt32LE(needSize64 ? U32_MAX : meta.rawSize, 24);
  header.writeUInt16LE(meta.nameBuf.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(needOffset64 ? U32_MAX : meta.localOffset, 42);
  return Buffer.concat([header, meta.nameBuf, extra]);
}

function buildEndRecords({ count, centralSize, centralOffset, forceZip64 }) {
  const needCount64 = forceZip64 || count >= U16_MAX;
  const needSize64 = forceZip64 || centralSize >= U32_MAX;
  const needOffset64 = forceZip64 || centralOffset >= U32_MAX;
  const needZip64 = needCount64 || needSize64 || needOffset64;

  const parts = [];
  if (needZip64) {
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(44n, 4);
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeUInt32LE(0, 16);
    eocd64.writeUInt32LE(0, 20);
    eocd64.writeBigUInt64LE(BigInt(count), 24);
    eocd64.writeBigUInt64LE(BigInt(count), 32);
    eocd64.writeBigUInt64LE(BigInt(centralSize), 40);
    eocd64.writeBigUInt64LE(BigInt(centralOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(eocd64, locator);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(needCount64 ? U16_MAX : count, 8);
  eocd.writeUInt16LE(needCount64 ? U16_MAX : count, 10);
  eocd.writeUInt32LE(needSize64 ? U32_MAX : centralSize, 12);
  eocd.writeUInt32LE(needOffset64 ? U32_MAX : centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}

async function writeSmallEntry({ handle, nameBuf, raw, mtime, offset, options }) {
  const { dosTime, dosDate } = dosDateTime(mtime);
  const deflated = raw.length > 0 ? deflateRawSync(raw, { level: options.level }) : raw;
  const useDeflate = raw.length > 0 && deflated.length < raw.length;
  const payload = useDeflate ? deflated : raw;
  const meta = {
    nameBuf,
    method: useDeflate ? 8 : 0,
    crc: raw.length > 0 ? crc32(raw) : 0,
    rawSize: raw.length,
    compressedSize: payload.length,
    dosTime,
    dosDate,
    localOffset: offset,
    needLocalZip64: options.forceZip64 || raw.length >= U32_SAFE,
  };
  const header = buildLocalHeader(meta);
  let nextOffset = await writeAll(handle, header, offset);
  if (payload.length > 0) nextOffset = await writeAll(handle, payload, nextOffset);
  return { meta, nextOffset };
}

async function writeStreamedEntry({ handle, nameBuf, filePath, info, offset, options }) {
  const { dosTime, dosDate } = dosDateTime(info.mtime);
  const needLocalZip64 = options.forceZip64 || info.size >= U32_SAFE;
  const placeholder = buildLocalHeader({
    nameBuf, method: 8, crc: 0, rawSize: info.size, compressedSize: 0, dosTime, dosDate, needLocalZip64,
  });
  let writePos = await writeAll(handle, placeholder, offset);
  let crc = 0;
  let rawSize = 0;
  let compressedSize = 0;

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      crc = crc32(chunk, crc);
      rawSize += chunk.length;
      cb(null, chunk);
    },
  });
  const sink = new Writable({
    write(chunk, _enc, cb) {
      writeAll(handle, chunk, writePos)
        .then((nextPos) => {
          compressedSize += chunk.length;
          writePos = nextPos;
          cb();
        })
        .catch(cb);
    },
  });
  await pipeline(createReadStream(filePath), counter, createDeflateRaw({ level: options.level }), sink);

  const meta = {
    nameBuf, method: 8, crc, rawSize, compressedSize, dosTime, dosDate, localOffset: offset, needLocalZip64,
  };
  const finalHeader = buildLocalHeader(meta);
  await writeAll(handle, finalHeader, offset);
  return { meta, nextOffset: writePos };
}

/**
 * Compute lowercase SHA-256 hex digest of a file via streaming I/O.
 */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function writeSingleEntry(handle, entry, offset, options) {
  const nameBuf = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
  if (!entry.filePath) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    return writeSmallEntry({ handle, nameBuf, raw, mtime: entry.mtime, offset, options });
  }
  const info = await stat(entry.filePath);
  if (info.size < SMALL_FILE_THRESHOLD) {
    const raw = await readFile(entry.filePath);
    return writeSmallEntry({ handle, nameBuf, raw, mtime: entry.mtime || info.mtime, offset, options });
  }
  return writeStreamedEntry({ handle, nameBuf, filePath: entry.filePath, info, offset, options });
}

/**
 * Stream entries to a ZIP (or ZIP64 when needed) archive on disk with low memory footprint.
 * Each entry provides `{ name, filePath?, data?, mtime? }`.
 */
export async function writeZipFile(zipPath, entries, { forceZip64 = false, level = 6 } = {}) {
  const handle = await open(zipPath, 'w');
  const options = { forceZip64, level };
  try {
    const centralParts = [];
    let offset = 0;
    let totalRawBytes = 0;

    for (const entry of entries) {
      const written = await writeSingleEntry(handle, entry, offset, options);
      offset = written.nextOffset;
      totalRawBytes += written.meta.rawSize;
      centralParts.push(buildCentralHeader(written.meta, forceZip64));
    }

    const centralOffset = offset;
    for (const part of centralParts) {
      offset = await writeAll(handle, part, offset);
    }
    const centralSize = offset - centralOffset;
    const endRecords = buildEndRecords({ count: entries.length, centralSize, centralOffset, forceZip64 });
    const finalBytes = await writeAll(handle, endRecords, offset);
    return { entries: entries.length, bytes: finalBytes, rawBytes: totalRawBytes };
  } finally {
    await handle.close();
  }
}
