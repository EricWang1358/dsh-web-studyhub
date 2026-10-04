import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

/** Bundle a browser module (and what it imports) for node and return its exports; React stays external. */
export async function loadUi(contents) {
  const compiled = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
