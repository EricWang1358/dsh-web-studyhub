import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { TOOLS } from '../../lib/large-documents.js';

/* Every catalogue channel label through the page's own ui(), in English. */
const compiled = await build({ stdin: { contents: `export { ui, setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
module.exports.setUiLanguage('en');
export const ToolCatalogLabels = TOOLS.flatMap(tool => tool.channels.map(channel => ({ zh: channel.label, en: module.exports.ui(channel.label) })));
