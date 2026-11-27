/* Full Windows runs start hundreds of isolated Node workers. Read the original library sources once before starting
   them. A worker may reuse a source only while its original file identity and nanosecond timestamps still match. */
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Arguments for the study process of a real crash/restart fixture. Never install the test worker's network guard in it. */
export function fixtureSourcePreload() {
  return process.platform === 'win32' && process.env.STUDY_TEST_SOURCE_CACHE && process.env.STUDY_BUILD_CACHE !== '0'
    ? ['--import', new URL('./test-module-loader.mjs', import.meta.url).href] : [];
}

function fingerprint(path) {
  const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return info?.isFile() ? [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join('/') : null;
}

export function writeTestSources(directory, destination) {
  const entries = {};
  const sources = [];
  let offset = 0;
  function walk(dir, top) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory() && item.name !== 'node_modules') walk(path, false);
      if (!item.isFile() || !item.name.endsWith('.js') || (top && /^client(?:\..+)?\.js$/.test(item.name))) continue;
      const before = fingerprint(path);
      if (!before) continue;
      const source = readFileSync(path);
      if (before !== fingerprint(path)) continue;
      entries[pathToFileURL(path).href] = [before, offset, source.length];
      sources.push(source);
      offset += source.length;
    }
  }
  walk(realpathSync.native(directory), true);
  // Keep source bytes out of JSON: parsing every large module into a separate string costs even a one-module worker.
  const index = Buffer.from(JSON.stringify(entries));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(index.length);
  writeFileSync(destination, Buffer.concat([length, index, ...sources]));
}

export function readTestSources(file) {
  let entries, sources;
  return url => {
    try {
      if (!entries) {
        const archive = readFileSync(file);
        const start = 4 + archive.readUInt32LE();
        entries = JSON.parse(archive.toString('utf8', 4, start));
        sources = archive.subarray(start);
      }
      const entry = entries[url];
      if (entry && entry[1] + entry[2] <= sources.length && fingerprint(fileURLToPath(url)) === entry[0]) {
        return sources.subarray(entry[1], entry[1] + entry[2]);
      }
    } catch { entries ??= {}; } // Missing, replaced, or unreadable sources always go through Node.
    return undefined;
  };
}
