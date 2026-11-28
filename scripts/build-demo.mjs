import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uiBuildDefine } from './ui-build-marker.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = resolve(root, 'output/static-demo-site');
const browserService = {
  name: 'browser-study-service',
  setup(b) {
    b.onResolve({ filter: /(^|\/)store\.js$/ }, args => resolve(args.resolveDir, args.path) === resolve(root, 'lib/store.js')
      ? {path:resolve(root,'web-demo/store.js')} : null);
    b.onResolve({ filter: /^node:crypto$/ }, () => ({path:resolve(root,'web-demo/crypto.js')}));
    b.onResolve({ filter: /^node:util$/ }, () => ({path:resolve(root,'web-demo/util.js')}));
    b.onResolve({ filter: /^node:fs\/promises$/ }, args => ({path:resolve(root,/[\\/](?:board|store-lock|atomic-json)\.js$/.test(args.importer)?'web-demo/files.js':'web-demo/unavailable.js')}));
    b.onResolve({ filter: /^node:(fs|http|https|child_process|async_hooks|zlib|worker_threads|stream|module)$/ }, () => ({path:resolve(root,'web-demo/unavailable.js')}));
    b.onResolve({ filter: /^node:(timers|stream)\/promises$/ }, () => ({path:resolve(root,'web-demo/unavailable.js')}));
    b.onResolve({ filter: /^node:path$/ }, () => ({path:resolve(root,'web-demo/unavailable.js')}));
    b.onResolve({ filter: /^(node:os|proper-lockfile)$/ }, () => ({path:resolve(root,'web-demo/files.js')}));
    b.onResolve({ filter: /^(@deepseek-ai\/dsh-llm|pdfjs-dist(\/.*)?)$/ }, () => ({path:resolve(root,'web-demo/unavailable.js')}));
    b.onResolve({ filter: /(^|\/)(documents|pdf-runtime|legacy)\.js$/ }, () => ({path:resolve(root,'web-demo/unavailable.js')}));
    b.onLoad({ filter: /[\\/]lib[\\/]generation\.js$/ }, async args => {
      const [code, recruitment] = await Promise.all([
        readFile(args.path, 'utf8'),
        readFile(resolve(root, 'references/recruitment-prep.md'), 'utf8'),
      ]);
      const pattern = /await\s+readFile\(\s*new\s+URL\(\s*["']\.\.\/references\/recruitment-prep\.md["']\s*,\s*import\.meta\.url\s*\)\s*,\s*["']utf8["']\s*\)/;
      if (!pattern.test(code)) throw new Error('scripts/build-demo.mjs: failed to inline references/recruitment-prep.md in lib/generation.js');
      return { contents: code.replace(pattern, () => JSON.stringify(recruitment)), loader: 'js' };
    });
    b.onLoad({ filter: /[\\/]lib[\\/]companion-template[\\/]template-runtime\.js$/ }, async () => {
      const mod = await import('../lib/companion-template/template-runtime.js');
      return {
        loader: 'js',
        contents: [
          `export const RUNTIME_MODULE_FILES = Object.freeze(${JSON.stringify(mod.RUNTIME_MODULE_FILES)});`,
          `export const LESSON_TEMPLATE_RUNTIME_JS = ${JSON.stringify(mod.LESSON_TEMPLATE_RUNTIME_JS)};`,
          `const EN_ONLY_RUNTIME_JS = ${JSON.stringify(mod.buildLessonTemplateRuntimeJs('en'))};`,
          `export function buildLessonTemplateRuntimeJs(language = 'zh') { return language === 'en' ? EN_ONLY_RUNTIME_JS : LESSON_TEMPLATE_RUNTIME_JS; }`,
        ].join('\n'),
      };
    });
  },
};
export async function buildDemoClient({ outdir = resolve(target, 'dist'), write = true } = {}) {
  if (write) await rm(resolve(outdir, 'chunks'), { recursive: true, force: true });
  const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
  const result = await build({ absWorkingDir:root, entryPoints:['web-demo/main.jsx'], bundle:true, format:'esm', platform:'browser',
    outdir, entryNames:'app', chunkNames:'chunks/[name]-[hash]', splitting:true, write,
    plugins:[browserService], minify:true, jsx:'automatic',
    define:{...uiBuildDefine(version),'process.env.NODE_ENV':'"production"','process.env.DSH_HOME':'"/demo"','process.uptime':'Number'}, loader:{'.woff': 'file','.woff2':'file','.ttf':'file'}, metafile:true,
  });
  const inputs=Object.keys(result.metafile.inputs);
  if (inputs.some(p=>/lib\/store\.js|proper-lockfile|pdfjs-dist|@deepseek-ai\/dsh-llm/.test(p))) throw new Error('Server-only dependency leaked into demo bundle');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await mkdir(resolve(target, 'dist'), {recursive:true});
  const result = await buildDemoClient();
  await writeFile(resolve(root,'output/demo-build-meta.json'),JSON.stringify(result.metafile,null,2));
  await writeFile(resolve(target,'dist/index.html'),`<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Try the StudyHub learning workflow. A bilingual, no-key interactive demo with real practice and local progress.">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'">
  <title>StudyHub — Interactive demo</title><link rel="icon" type="image/svg+xml" href="./icon.svg"><link rel="stylesheet" href="./app.css"></head>
  <body><div id="root"></div><noscript>This interactive demo requires JavaScript.</noscript><script type="module" src="./app.js"></script></body></html>`);
  await writeFile(resolve(target,'dist/icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#211f1b"/><path d="M18 14h28v38H18z" fill="#ede7db"/><path d="M18 14h5v38h-5z" fill="#bd6049"/><path d="M29 26h11M29 34h11M29 42h7" stroke="#211f1b" stroke-width="3"/></svg>');
  const manifestPath=resolve(target,'.openai/hosting.json');
  let manifest={};try {manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch{ /* the first build has no manifest */ }
  await mkdir(resolve(target,'.openai'),{recursive:true});
  await writeFile(manifestPath,JSON.stringify({...manifest,static:{directory:'dist'}},null,2)+'\n');
  await writeFile(resolve(target,'README.md'),'# StudyHub interactive demo\n\nStatic browser build. English by default with Chinese switching. No API keys, API requests, private course files, or backend. Progress stays in browser local storage.\n\nBuilt from the plugin’s study service and explicit public sample fixtures. AI-like content is prerecorded.\n');
  console.log('Static demo built: '+target);
}
