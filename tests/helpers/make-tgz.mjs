import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/* A .tgz the way npm packs one (ustar headers, everything under package/), for tests of lib/npm-tarball.js and the local live install.
   `files`: { 'package/name': string | Buffer } or [{ name, data, type }] for links and other odd entries. */

function header(name, size, type = '0', mode = 0o644) {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  block.write('0000000\0', 108); block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
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
  for (const { name, data = '', type = '0', mode } of list) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    parts.push(header(name, type === '0' ? bytes.length : 0, type, mode));
    if (type === '0') parts.push(bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const integrityOf = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
