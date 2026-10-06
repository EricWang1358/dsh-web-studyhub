import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { nativeSelects } from './native-selects.mjs';

const require = createRequire(import.meta.url);

/** Bundle a browser module (and what it imports) for node and return its exports; React stays external. Select and Combobox are the native stand-ins of tests/helpers/native-selects.mjs. */
export async function loadUi(contents) {
  const compiled = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
