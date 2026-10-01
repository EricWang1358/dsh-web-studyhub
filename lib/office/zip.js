import { crc32, inflateRawSync } from 'node:zlib';

/** A problem with an Office file, with a stable machine-readable `code`. */
export class OfficeFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OfficeFileError';
    this.code = code;
  }
}

const MB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 10_000,        // files in the archive
  maxTotalBytes: 1024 * MB,  // declared uncompressed size of all entries
  maxEntryBytes: 64 * MB,    // one inflated entry (document.xml is the biggest we read)
  maxReadBytes: 256 * MB,    // everything inflated by one reader
  maxRatio: 500,             // uncompressed / compressed, for entries above RATIO_FLOOR
});
const RATIO_FLOOR = 512 * 1024;

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50, SIG_ZIP64_LOCATOR = 0x07064b50;
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const damaged = detail => new OfficeFileError('corrupt', `Office file is damaged or not a valid ZIP package (${detail})`);
const locked = () => new OfficeFileError('encrypted', 'Office file is password-protected or in an old format');

/**
 * Read-only ZIP access for OOXML packages using only node:zlib: stored and
 * deflate entries, no ZIP64, no encryption. Nothing is written to disk, names
 * are only ever used as map keys, and every size is capped before anything is
 * inflated (entry count, declared total, per-entry size and ratio, cumulative
 * output), so a hostile archive cannot exhaust memory.
 *
 * Returns { names(), has(name), read(name) -> Buffer|null, text(name) -> string|null }.
 */
export function readZip(input, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length >= OLE.length && bytes.subarray(0, OLE.length).equals(OLE)) throw new OfficeFileError('ole', 'Office file is password-protected or in an old format');
  const end = findEnd(bytes);
  if (end < 0) {
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === SIG_LOCAL) throw damaged('the end of the archive is missing');
    throw new OfficeFileError('not-zip', 'Office file is damaged or not a valid ZIP package');
  }
  if ((end >= 20 && bytes.readUInt32LE(end - 20) === SIG_ZIP64_LOCATOR) ||
      bytes.readUInt16LE(end + 10) === 0xffff || bytes.readUInt32LE(end + 12) === 0xffffffff || bytes.readUInt32LE(end + 16) === 0xffffffff)
    throw new OfficeFileError('zip64', 'Office file uses ZIP64, which is not supported');
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw damaged('multi-part archives are not supported');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (count > limits.maxEntries) throw new OfficeFileError('too-many-entries', 'Office file is too large when unpacked (too many files)');
  if (offset + size > end) throw damaged('the file index is out of range');

  const entries = new Map();
  let position = offset, declaredTotal = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== SIG_CENTRAL) throw damaged('bad file index');
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10), crc = bytes.readUInt32LE(position + 16);
    const compressed = bytes.readUInt32LE(position + 20), uncompressed = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28), extraLength = bytes.readUInt16LE(position + 30), commentLength = bytes.readUInt16LE(position + 32);
    const localOffset = bytes.readUInt32LE(position + 42);
    if (position + 46 + nameLength > end) throw damaged('bad file name');
    const name = bytes.toString((flags & 0x800) ? 'utf8' : 'latin1', position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x41) throw locked();
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff)
      throw new OfficeFileError('zip64', 'Office file uses ZIP64, which is not supported');
    declaredTotal += uncompressed;
    if (declaredTotal > limits.maxTotalBytes) throw new OfficeFileError('bomb', 'Office file is too large when unpacked');
    if (!entries.has(name)) entries.set(name, { method, crc, compressed, uncompressed, localOffset });
  }

  let readBytes = 0;
  function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const { method, crc, compressed, uncompressed, localOffset } = entry;
    if (method !== 0 && method !== 8) throw new OfficeFileError('unsupported-method', `Office file is damaged or not a valid ZIP package (compression method ${method})`);
    if (uncompressed > limits.maxEntryBytes || (uncompressed > RATIO_FLOOR && uncompressed / Math.max(1, compressed) > limits.maxRatio) ||
        readBytes + uncompressed > limits.maxReadBytes) throw new OfficeFileError('bomb', 'Office file is too large when unpacked');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== SIG_LOCAL) throw damaged('bad file header');
    const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (start + compressed > offset) throw damaged('file data runs past the archive');
    const data = bytes.subarray(start, start + compressed);
    let output;
    if (method === 0) {
      if (compressed !== uncompressed) throw damaged('stored size mismatch');
      output = Buffer.from(data);
    } else {
      try { output = inflateRawSync(data, { maxOutputLength: Math.max(1, uncompressed) }); }
      catch { throw damaged('a file could not be unpacked'); }
    }
    if (output.length !== uncompressed || crc32(output) !== crc) throw damaged('a file does not match its checksum');
    readBytes += output.length;
    return output;
  }
  return {
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    read,
    text(name) {
      const data = read(name);
      return data === null ? null : data.toString('utf8').replace(/^﻿/, '');
    },
  };
}

function findEnd(bytes) {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let index = bytes.length - 22; index >= lowest; index--) if (bytes.readUInt32LE(index) === SIG_END) return index;
  return -1;
}
