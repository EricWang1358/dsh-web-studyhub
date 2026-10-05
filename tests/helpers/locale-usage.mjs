import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Which English translation keys does the source still use? The key is the Chinese source text (ui('…'), uiFormat('…', [...]), a label table the
   page passes to ui()), so a key is "referenced" when its text stands in a source file of ui/ or lib/ as written, or as a string literal would write it
   (an escaped quote, a "\n"). A key that no file mentions cannot be reached by any call, whatever it is called. */

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const SOURCE = /\.(?:js|jsx|mjs)$/;
async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'locales' && entry.name !== 'node_modules') await walk(path, files); }
    else if (SOURCE.test(entry.name)) files.push(path);
  }
  return files;
}

/** The text of every source file of ui/ and lib/ (the translations themselves are not source), plus the same text with string-literal escapes undone. */
export async function sourceCorpus(root = repoRoot) {
  const files = [...await walk(join(root, 'ui')), ...await walk(join(root, 'lib'))];
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
