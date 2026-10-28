import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { InstallError } from './tool-install.js';

/* An npm package tarball (.tgz) unpacked without npm: the local live engine (lib/live-local-install.js) fetches two pinned tarballs whose sha512
   integrity it already checked, and unpacks them here. Only regular files are written; the leading `package/` folder is dropped; a name that is
   absolute or climbs out of the target ('..') is refused, as are links and anything over the size limits. */

export const TARBALL_LIMITS = Object.freeze({ maxUnpackedBytes: 200 * 1_048_576, maxEntries: 2000 });

const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
const octal = (block, start, length) => { const text = field(block, start, length).trim(); return text ? parseInt(text, 8) : 0; };
/** The `path=` record of a PAX extended header, if any. */
const paxPath = data => /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] || '';

/** The entries of an uncompressed tar: [{ name, type, mode, data }] (type '0' a file, '5' a folder, anything else is reported as it is). */
export function readTar(tar, limits = TARBALL_LIMITS) {
  const entries = [];
  let at = 0, longName = '', total = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const size = octal(header, 124, 12), type = String.fromCharCode(header[156] || 48);
    const prefix = field(header, 345, 155), base = field(header, 0, 100);
    const data = tar.subarray(at + 512, at + 512 + size);
    if (data.length !== size) throw new InstallError('checksum', 'the package archive is cut short');
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'L') { longName = type === 'x' ? paxPath(data) : data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'g') continue;
    const name = longName || (prefix ? `${prefix}/${base}` : base);
    longName = '';
    total += size;
    if (entries.length >= limits.maxEntries || total > limits.maxUnpackedBytes) throw new InstallError('checksum', 'the package archive is larger than expected');
    entries.push({ name, type: type === '\0' ? '0' : type, mode: octal(header, 100, 8), data });
  }
  return entries;
}

/** Unpack the .tgz at `file` into `destDir` (made if missing). Resolves the files written, relative to `destDir`. */
export async function extractPackage(file, destDir, limits = TARBALL_LIMITS) {
  let tar;
  try { tar = gunzipSync(await readFile(file), { maxOutputLength: limits.maxUnpackedBytes + 4 * 1_048_576 }); }
  catch (error) { throw new InstallError('checksum', `the package archive cannot be unpacked: ${error.message}`); }
  const root = path.resolve(destDir), written = [];
  await mkdir(root, { recursive: true });
  for (const entry of readTar(tar, limits)) {
    if (entry.type === '5') continue;
    if (entry.type !== '0') throw new InstallError('checksum', `the package archive holds a link or a device (${entry.name})`);
    const relative = entry.name.replace(/\\/g, '/').split('/').slice(1).join('/');
    if (!relative) continue;
    const target = path.resolve(root, relative);
    if (path.isAbsolute(relative) || !target.startsWith(`${root}${path.sep}`)) throw new InstallError('checksum', `the package archive names a file outside its folder (${entry.name})`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    if (process.platform !== 'win32' && entry.mode & 0o111) await chmod(target, 0o755);
    written.push(relative);
  }
  return written;
}
