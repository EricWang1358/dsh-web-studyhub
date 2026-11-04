import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildCacheDir, sourceTreeDigest, writeCacheAtomically } from '../../scripts/build.mjs';
import { nativeSelects } from './native-selects.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const EXTERNAL = [
  'react', 'react-dom', 'react/*', 'react-dom/*',
  '@codemirror/*', '@lezer/*', '@uiw/*', '@base-ui/*',
  'markdown-it', 'markdown-it-texmath', 'dompurify',
  'katex', 'katex/*', 'parse5', 'pdf-lib', 'yaml', 'schemastery', 'proper-lockfile',
];
let treePromise;
const uiTreeDigest = () => (treePromise ??= sourceTreeDigest([
  'tests/helpers/ui-module.mjs', 'tests/helpers/native-selects.mjs', 'tests/helpers/native-select-stub.jsx',
]));

/** Bundle a browser module (and what it imports) for node and return its exports; React stays external. Select and Combobox are the native stand-ins of tests/helpers/native-selects.mjs. */
export async function loadUi(contents) {
  const cwd = resolve(process.cwd());
  const useCache = process.env.STUDY_BUILD_CACHE !== '0' && cwd === resolve(root);
  const cacheFile = useCache
    ? resolve(buildCacheDir, 'ui-module', `${createHash('sha256').update(`${await uiTreeDigest()}\0${cwd}\0${contents}`).digest('hex').slice(0, 32)}.cjs`)
    : null;
  let code = cacheFile ? await readFile(cacheFile, 'utf8').catch(() => null) : null;
  if (code === null) {
    const compiled = await build({ stdin: { contents, resolveDir: cwd }, bundle: true, write: false, platform: 'node', format: 'cjs',
      external: EXTERNAL, plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
    code = compiled.outputFiles[0].text;
    if (cacheFile) await writeCacheAtomically(cacheFile, code).catch(() => {});
  }
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  return module.exports;
}
