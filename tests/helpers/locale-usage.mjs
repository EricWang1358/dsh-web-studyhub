import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Which English translation keys does the source still use? The key is the Chinese source text (ui('…'), uiFormat('…', [...]), a label table the
   page passes to ui()), so a key is "referenced" when its text stands in a source file of ui/ or lib/ as written, or as a string literal would write it
   (an escaped quote, a "\n"). A key that no file mentions cannot be reached by any call, whatever it is called. */

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const SOURCE = /\.(?:js|jsx|mjs)$/;
/* `npm run build` writes bundles of the whole client into lib/ (lib/client.js, lib/client.<chunk>.js; gitignored): they are output, not source. */
const BUILD_OUTPUT = /^client(?:\..+)?\.js$/;
async function walk(dir, files = [], top = true) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'locales' && entry.name !== 'node_modules') await walk(path, files, false); }
    else if (SOURCE.test(entry.name) && !(top && BUILD_OUTPUT.test(entry.name))) files.push(path);
  }
  return files;
}

/** The source files of ui/ and lib/ (not the translations, not the build's bundles). */
export async function sourceFiles(root = repoRoot) {
  return [...await walk(join(root, 'ui'), [], false), ...await walk(join(root, 'lib'))];
}

/** The text of every source file of ui/ and lib/ (the translations themselves are not source), plus the same text with string-literal escapes undone. */
export async function sourceCorpus(root = repoRoot) {
  const files = await sourceFiles(root);
  const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  const unescaped = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\(['"`])/g, '$1').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  return `${text}\n${unescaped}`;
}

/** Every English catalogue of ui/locales: [{ file, keys }]. */
export async function englishCatalogues(root = repoRoot) {
  const dir = join(root, 'ui', 'locales');
  const names = (await readdir(dir)).filter((name) => /^en(?:\..+)?\.json$/.test(name)).sort();
  return Promise.all(names.map(async (file) => ({ file, keys: Object.keys(JSON.parse(await readFile(join(dir, file), 'utf8'))) })));
}

/** The keys (of `keys`) that `corpus` does not mention. */
export const unreferencedKeys = (keys, corpus) => keys.filter((key) => !corpus.includes(key));
