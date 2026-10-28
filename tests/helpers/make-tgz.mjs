import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/* A .tgz the way npm packs one (ustar headers, everything under package/), for tests of lib/npm-tarball.js and the local live install.
   `files`: { 'package/name': string | Buffer } or [{ name, data, type, base256 }] for links, PAX ('x') and GNU long-name ('L') records and other odd entries. */

function header(name, size, type = '0', mode = 0o644, base256 = false) {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  block.write('0000000\0', 108); block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  if (base256) block[124] = 0x80; // a GNU base-256 size, which no npm tarball uses
  block.write('        ', 148);
  block.write(type, 156);
  block.write('ustar\0', 257); block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

export function makeTgz(files) {
  const list = Array.isArray(files) ? files : Object.entries(files).map(([name, data]) => ({ name, data }));
  const parts = [];
  for (const { name, data = '', type = '0', mode, base256 = false } of list) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const carries = ['0', 'x', 'L'].includes(type);
    parts.push(header(name, carries ? bytes.length : 0, type, mode, base256));
    if (carries) parts.push(bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A PAX extended-header record: `<length> path=<value>
`, the length counting itself. */
export function paxRecord(key, value) {
  const body = ` ${key}=${value}
`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${length}${body}`;
}

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const integrityOf = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
