import { OfficeFileError } from './zip.js';

/* Read-only access to a Compound File Binary (OLE2) container, the package
   behind the old Office formats (.ppt, .doc, .xls) and behind password-protected
   OOXML files. Only node:buffer is used. Every sector chain is bounded by the
   number of sectors in the file and every stream by its own declared size and
   the file size, so a hostile file cannot loop or exhaust memory. Streams are
   found by name anywhere in the directory (the formats read here keep theirs in
   the root storage). */

export const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export const isCompoundFile = bytes => bytes.length >= OLE_SIGNATURE.length && Buffer.from(bytes.subarray(0, OLE_SIGNATURE.length)).equals(OLE_SIGNATURE);

const ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff, NOSTREAM = 0xffffffff;
const MAX_DIRECTORY_ENTRIES = 100_000;
const damaged = detail => new OfficeFileError('corrupt', `Office file is damaged or not a valid compound file (${detail})`);

/**
 * Returns { names(), has(name), read(name) -> Buffer|null } for a compound file.
 * Throws OfficeFileError('corrupt') when the container is malformed.
 */
export function readCompoundFile(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!isCompoundFile(bytes) || bytes.length < 512) throw damaged('bad header');
  if (bytes.readUInt16LE(0x1c) !== 0xfffe) throw damaged('bad byte order');
  const major = bytes.readUInt16LE(0x1a), shift = bytes.readUInt16LE(0x1e), miniShift = bytes.readUInt16LE(0x20);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12)) || miniShift !== 6) throw damaged('unsupported sector size');
  const sectorSize = 1 << shift, miniSize = 1 << miniShift;
  const sectorCount = Math.ceil(Math.max(0, bytes.length - sectorSize) / sectorSize);
  const fatSectors = bytes.readUInt32LE(0x2c), firstDirectory = bytes.readUInt32LE(0x30), cutoff = bytes.readUInt32LE(0x38);
  const firstMiniFat = bytes.readUInt32LE(0x3c), miniFatSectors = bytes.readUInt32LE(0x40);
  let difat = bytes.readUInt32LE(0x44), difatSectors = bytes.readUInt32LE(0x48);
  if (fatSectors > sectorCount || miniFatSectors > sectorCount || difatSectors > sectorCount) throw damaged('sector counts out of range');

  const sector = index => {
    if (index >= sectorCount) throw damaged('sector out of range');
    const start = (index + 1) * sectorSize;
    return bytes.subarray(start, Math.min(start + sectorSize, bytes.length));
  };
  const words = buffer => Array.from({ length: buffer.length >>> 2 }, (_, index) => buffer.readUInt32LE(index * 4));

  // FAT sector locations: 109 in the header, the rest in a chain of DIFAT sectors.
  const fatLocations = words(bytes.subarray(0x4c, 0x200));
  for (let seen = 0; difat !== ENDOFCHAIN && difat !== FREESECT && difatSectors > 0; seen++, difatSectors--) {
    if (seen > sectorCount) throw damaged('DIFAT loop');
    const entries = words(sector(difat));
    fatLocations.push(...entries.slice(0, -1));
    difat = entries.at(-1);
  }
  const fat = [];
  for (const location of fatLocations.slice(0, fatSectors)) {
    if (location === FREESECT) continue;
    for (const value of words(sector(location))) fat.push(value);
  }

  const chain = (start, table, limit) => {
    const out = [];
    for (let at = start; at !== ENDOFCHAIN; at = table[at]) {
      if (at === FREESECT && !out.length) break;
      if (at >= table.length || out.length > limit) throw damaged('broken sector chain');
      out.push(at);
    }
    return out;
  };
  const readChain = (start, size) => {
    const parts = chain(start, fat, sectorCount).map(sector);
    const data = Buffer.concat(parts);
    if (size !== undefined && data.length < size) throw damaged('stream shorter than declared');
    return size === undefined ? data : data.subarray(0, size);
  };

  // Directory: 128-byte entries, the first is the root (it owns the mini stream).
  const directory = readChain(firstDirectory);
  const count = Math.min(directory.length >>> 7, MAX_DIRECTORY_ENTRIES);
  const entries = [];
  for (let index = 0; index < count; index++) {
    const entry = directory.subarray(index * 128, index * 128 + 128);
    const nameLength = Math.min(64, entry.readUInt16LE(0x40));
    const type = entry[0x42];
    if (type !== 1 && type !== 2 && type !== 5) continue;
    const name = entry.subarray(0, Math.max(0, nameLength - 2)).toString('utf16le');
    // Version 3 files may leave garbage in the high half of the size.
    const size = major === 3 ? entry.readUInt32LE(0x78) : Number(entry.readBigUInt64LE(0x78));
    entries.push({ name, type, start: entry.readUInt32LE(0x74), size, child: entry.readUInt32LE(0x4c) });
  }
  const root = entries.find(entry => entry.type === 5);
  if (!root) throw damaged('no root entry');

  let miniStream, miniFat;
  const mini = () => {
    if (!miniStream) {
      miniStream = root.start === ENDOFCHAIN || root.child === NOSTREAM ? Buffer.alloc(0) : readChain(root.start, Math.min(root.size, bytes.length));
      miniFat = miniFatSectors ? words(readChain(firstMiniFat)) : [];
    }
    return { miniStream, miniFat };
  };
  const streams = new Map();
  for (const entry of entries) if (entry.type === 2 && !streams.has(entry.name)) streams.set(entry.name, entry);

  return {
    names: () => [...streams.keys()],
    has: name => streams.has(name),
    read(name) {
      const entry = streams.get(name);
      if (!entry) return null;
      if (entry.size > bytes.length) throw damaged('stream larger than the file');
      if (!entry.size) return Buffer.alloc(0);
      if (entry.size >= cutoff) return readChain(entry.start, entry.size);
      const { miniStream: data, miniFat: table } = mini();
      const parts = chain(entry.start, table, data.length / miniSize).map(index => {
        const start = index * miniSize;
        if (start + miniSize > data.length) throw damaged('mini sector out of range');
        return data.subarray(start, start + miniSize);
      });
      const out = Buffer.concat(parts);
      if (out.length < entry.size) throw damaged('stream shorter than declared');
      return out.subarray(0, entry.size);
    },
  };
}
