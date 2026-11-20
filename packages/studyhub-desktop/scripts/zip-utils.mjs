import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const source = date instanceof Date ? date : new Date('2026-01-01T00:00:00Z');
  const year = Math.max(1980, source.getUTCFullYear());
  const dosTime = (source.getUTCHours() << 11) | (source.getUTCMinutes() << 5) | Math.floor(source.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((source.getUTCMonth() + 1) << 5) | source.getUTCDate();
  return { dosTime, dosDate };
}

function encodeEntry(entry) {
  const nameBuf = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
  const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
  const deflated = raw.length > 0 ? deflateRawSync(raw, { level: 6 }) : raw;
  const useDeflate = raw.length > 0 && deflated.length < raw.length;
  const payload = useDeflate ? deflated : raw;
  const { dosTime, dosDate } = dosDateTime(entry.mtime);
  return {
    nameBuf,
    payload,
    method: useDeflate ? 8 : 0,
    crc: crc32(raw),
    rawSize: raw.length,
    dosTime,
    dosDate,
  };
}

function localFileHeader(meta) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(meta.method, 8);
  header.writeUInt16LE(meta.dosTime, 10);
  header.writeUInt16LE(meta.dosDate, 12);
  header.writeUInt32LE(meta.crc, 14);
  header.writeUInt32LE(meta.payload.length, 18);
  header.writeUInt32LE(meta.rawSize, 22);
  header.writeUInt16LE(meta.nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, meta.nameBuf, meta.payload]);
}

function centralDirectoryHeader(meta, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(meta.method, 10);
  header.writeUInt16LE(meta.dosTime, 12);
  header.writeUInt16LE(meta.dosDate, 14);
  header.writeUInt32LE(meta.crc, 16);
  header.writeUInt32LE(meta.payload.length, 20);
  header.writeUInt32LE(meta.rawSize, 24);
  header.writeUInt16LE(meta.nameBuf.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, meta.nameBuf]);
}

function endOfCentralDirectory(count, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

export function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const meta = encodeEntry(entry);
    const local = localFileHeader(meta);
    localParts.push(local);
    centralParts.push(centralDirectoryHeader(meta, offset));
    offset += local.length;
  }

  const centralBlock = Buffer.concat(centralParts);
  const eocd = endOfCentralDirectory(entries.length, centralBlock.length, offset);
  return Buffer.concat([...localParts, centralBlock, eocd]);
}

function findEocdOffset(zipBuffer) {
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  throw new Error('ZIP archive is missing end-of-central-directory signature');
}

function readZipEntryPayload(zipBuffer, localOffset, compressedSize, method) {
  if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error('ZIP archive has corrupt local file header');
  }
  const nameLen = zipBuffer.readUInt16LE(localOffset + 26);
  const extraLen = zipBuffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const slice = zipBuffer.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(slice);
  if (method === 8) return inflateRawSync(slice);
  throw new Error(`Unsupported ZIP compression method: ${method}`);
}

export function extractZipEntry(zipBuffer, predicate) {
  const eocd = findEocdOffset(zipBuffer);
  const totalEntries = zipBuffer.readUInt16LE(eocd + 10);
  let cursor = zipBuffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < totalEntries; i += 1) {
    if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP archive has corrupt central directory header');
    }
    const method = zipBuffer.readUInt16LE(cursor + 10);
    const expectedCrc = zipBuffer.readUInt32LE(cursor + 16);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localOffset = zipBuffer.readUInt32LE(cursor + 42);
    const name = zipBuffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (!predicate(name)) continue;
    const data = readZipEntryPayload(zipBuffer, localOffset, compressedSize, method);
    if (crc32(data) !== expectedCrc) {
      throw new Error(`ZIP CRC32 mismatch while extracting ${name}`);
    }
    return { name, data };
  }

  throw new Error('Matching entry was not found inside ZIP archive');
}
