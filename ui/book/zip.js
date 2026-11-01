/* A .zip of text files for 分文件导出 of the 复习全书 (#489 item 7): stored, not compressed, so it needs no library and no worker, and a whole book is written at once in the browser. UTF-8 names and text. Pure: bytes in, bytes out. */

const CRC_TABLE = Array.from({ length: 256 }, (_, at) => {
  let value = at;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** The CRC-32 a zip keeps of a file's bytes. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const UTF8_NAMES = 0x0800, ZIP_VERSION = 20;
// 1980-01-01, the earliest a zip can say: the same book makes the same bytes.
const DOS_DATE = 0x0021;

function header(size, fields) {
  const view = new DataView(new ArrayBuffer(size));
  let at = 0;
  for (const [bytes, value] of fields) { if (bytes === 4) view.setUint32(at, value, true); else view.setUint16(at, value, true); at += bytes; }
  return new Uint8Array(view.buffer);
}

/** files: [{ name, text }] -> the bytes of a .zip holding them in that order. */
export function zipTextFiles(files) {
  const encoder = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), data = encoder.encode(file.text), crc = crc32(data);
    const shared = [[2, ZIP_VERSION], [2, UTF8_NAMES], [2, 0], [2, 0], [2, DOS_DATE], [4, crc], [4, data.length], [4, data.length], [2, name.length], [2, 0]];
    const local = header(30, [[4, 0x04034b50], ...shared]);
    parts.push(local, name, data);
    central.push(header(46, [[4, 0x02014b50], [2, ZIP_VERSION], ...shared, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), name);
    offset += local.length + name.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, [[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, size], [4, offset], [2, 0]]);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}
