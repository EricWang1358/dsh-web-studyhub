import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostReact, shimJsxRuntime } from './host-react.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageId = '@ericwang1358/dsh-daily-flashcard';
const chunkName = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
export const buildCacheDir = resolve(root, 'node_modules', '.cache', 'studyhub-tests', 'bundles');
const cacheEnabled = () => process.env.STUDY_BUILD_CACHE !== '0';

/** Fast nanosecond-resolution fingerprint of every source file that can affect UI/client bundles, excluding emitted lib/client*.js chunks. */
export async function sourceTreeDigest(extraFiles = []) {
  const hash = createHash('sha256');
  async function walk(dir, topLib = false) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (topLib && (entry.name === 'client.js' || chunkName.test(entry.name))) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full, false);
      else if (entry.isFile()) {
        const info = await stat(full, { bigint: true });
        hash.update(`${relative(root, full).split(sep).join('/')}\0${info.size}\0${info.mtimeNs}\n`);
      }
    }
  }
  await walk(resolve(root, 'ui'), false);
  await walk(resolve(root, 'lib'), true);
  for (const file of ['scripts/build.mjs', 'scripts/host-react.mjs', 'package.json', 'package-lock.json', ...extraFiles]) {
    const full = resolve(root, file);
    const info = await stat(full, { bigint: true }).catch(() => null);
    if (info) hash.update(`${relative(root, full).split(sep).join('/')}\0${info.size}\0${info.mtimeNs}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

export async function writeCacheAtomically(file, contents) {
  await mkdir(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, file).catch(async () => { await rm(tmp, { force: true }).catch(() => {}); });
}

/** The English catalogue on demand (#563). Chinese is the source language, so a Chinese interface needs none of ui/locales/en*.json nor
 * lib/application-messages-en.js (about 1.1 MB). In the host build the two static imports that reach them (ui/i18n.js → ui/english-catalogue.js,
 * lib/application-messages.js → its English table) get an empty module instead; ui/i18n.js's dynamic import of the same catalogue then becomes
 * a chunk of its own, which an English interface loads before StudyHub renders. Node, the tests and the preview keep the ordinary imports. */
const englishCatalogue = resolve(root, 'ui/english-catalogue.js'), i18nModule = resolve(root, 'ui/i18n.js');
const appMessages = resolve(root, 'lib/application-messages.js'), appMessagesEnglish = resolve(root, 'lib/application-messages-en.js');
export const englishOnDemand = {
  name: 'english-on-demand',
  setup(build) {
    build.onResolve({ filter: /(?:english-catalogue|application-messages-en)\.js$/ }, args => {
      if (args.kind !== 'import-statement') return undefined;
      const target = resolve(args.resolveDir, args.path);
      if (args.importer === i18nModule && target === englishCatalogue) return { path: 'ui/english-catalogue.js', namespace: 'english-on-demand' };
      if (args.importer === appMessages && target === appMessagesEnglish) return { path: 'lib/application-messages-en.js', namespace: 'english-on-demand' };
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: 'english-on-demand' }, args => ({ loader: 'js',
      contents: args.path === 'ui/english-catalogue.js' ? 'export const ENGLISH_SOURCES = null;\n' : 'export default {};\n' }));
  },
};

/* Inline browserStorage from ui/storage.js into client.js (#630, #115) so ui/host.jsx uses the single storage module without
   creating a shared static chunk import on client.js. */
const hostEntry = resolve(root, 'ui/host.jsx'), storageModule = resolve(root, 'ui/storage.js');
const entryStorageInline = {
  name: 'entry-storage-inline',
  setup(build) {
    build.onResolve({ filter: /^\.\/storage\.js$/ }, args =>
      args.importer === hostEntry && resolve(args.resolveDir, args.path) === storageModule
        ? { path: storageModule, namespace: 'entry-storage-inline' }
        : undefined);
    build.onLoad({ filter: /.*/, namespace: 'entry-storage-inline' }, async args => ({
      loader: 'js', resolveDir: resolve(root, 'ui'), contents: await readFile(args.path, 'utf8'),
    }));
  },
};

async function flushHostClient(outdir, outputFiles) {
  await mkdir(outdir, { recursive: true });
  // Remove only this build's obsolete hashed modules; backend files share lib.
  const current = new Set(outputFiles.map(file => basename(file.path)));
  for (const name of await readdir(outdir)) {
    if (chunkName.test(name) && !current.has(name)) await rm(resolve(outdir, name));
  }
  await Promise.all(outputFiles.map(file => writeFile(file.path, file.contents)));
}

/** Emit real ES module boundaries as DSH's package-local classic factories.
 * DSH serves sibling client.*.js files and supplies require.async('./client.*.js').
 * Its require is synchronous, so static dependencies must arrive before the
 * requested factory materializes. Shared chunks keep React and UI state single.
 */
export async function buildHostClient({ outdir = resolve(root, 'lib'), write = true } = {}) {
  const targetDir = resolve(outdir);
  const outKey = createHash('sha256').update(relative(root, targetDir).split(sep).join('/')).digest('hex').slice(0, 12);
  const cacheFile = cacheEnabled() ? resolve(buildCacheDir, `host-${outKey}-${await sourceTreeDigest()}.json`) : null;
  if (cacheFile) {
    const cached = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
    if (cached?.metafile && Array.isArray(cached.files)) {
      const outputFiles = cached.files.map(({ name, text }) => ({ path: resolve(targetDir, name), text, contents: Buffer.from(text) }));
      if (write) await flushHostClient(targetDir, outputFiles);
      return { errors: [], warnings: [], metafile: cached.metafile, outputFiles };
    }
  }
  const result = await build({
    absWorkingDir: root, entryPoints: { client: 'ui/host.jsx' }, outdir: targetDir,
    chunkNames: 'client.[name]-[hash]', bundle: true, splitting: true,
    write: false, metafile: true, format: 'esm', platform: 'browser',
    plugins: [hostReact, englishOnDemand, entryStorageInline], loader: { '.css': 'text' }, jsx: 'transform',
    minify: true, logLevel: 'silent',
  });
  const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
  const staticImports = name => outputs.get(name).imports
    .filter(edge => !edge.external && edge.kind === 'import-statement').map(edge => basename(edge.path));
  // Group shared dependencies by depth: unrelated files arrive in parallel,
  // while a factory's own synchronous imports are already registered.
  function loadExpression(name) {
    const levels = new Map();
    function visit(current, open = new Set()) {
      if (open.has(current)) throw new Error(`Client static module cycle at ${current}`);
      const next = new Set([...open, current]);
      const depth = Math.max(-1, ...staticImports(current).map(dependency => visit(dependency, next))) + 1;
      levels.set(current, depth); return depth;
    }
    visit(name);
    let expression = 'Promise.resolve()';
    for (let depth = 0; depth < levels.get(name); depth++) {
      const names = [...levels].filter(([, value]) => value === depth).map(([file]) => file);
      expression += `.then(()=>Promise.all([${names.map(file => `require.async(${JSON.stringify(`./${file}`)})`).join(',')}]))`;
    }
    return `${expression}.then(()=>require.async(${JSON.stringify(`./${name}`)}))`;
  }
  // esbuild emits a side-effect-only import of its shared runtime helpers in
  // every entry, even this entry which uses none. They have no authored inputs;
  // their consumers load them through the normal shared dependency graph.
  for (const dependency of staticImports('client.js')) {
    if (Object.keys(outputs.get(dependency).inputs).length)
      throw new Error('Classic entry must expose apply without synchronous chunk imports');
  }
  result.outputFiles = await Promise.all(result.outputFiles.map(async file => {
    const name = basename(file.path);
    if (name !== 'client.js' && !chunkName.test(name)) throw new Error(`Unsupported DSH chunk name ${name}`);
    const source = name === 'client.js' ? file.text.replace(/import"\.\/client\.[^"]+\.js";/g, '') : file.text;
    const compiled = await transform(source, { format: 'cjs', minify: true, platform: 'browser' });
    const code = compiled.code
      .replace(/require\("\.\/(client\.[^"]+\.js)"\)/g, (_match, dependency) => `require(${JSON.stringify(`${packageId}/${dependency}`)})`)
      .replace(/import\("\.\/(client\.[^"]+\.js)"\)/g, (_match, dependency) => loadExpression(dependency));
    const registration = { id: packageId, ...(name === 'client.js' ? {} : { chunk: name }) };
    const text = `// Generated by scripts/build.mjs from ui modules.\nwindow.__ModuleLoader__.load({...${JSON.stringify(registration)},factory:function(require){var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});\n`;
    return { path: file.path, text, contents: Buffer.from(text) };
  }));
  if (cacheFile) {
    await writeCacheAtomically(cacheFile, JSON.stringify({
      metafile: result.metafile,
      files: result.outputFiles.map(file => ({ name: basename(file.path), text: file.text })),
    })).catch(() => {});
  }
  if (write) await flushHostClient(targetDir, result.outputFiles);
  return result;
}

/** `production`: minified with React's production build, the way the shipped client modules are built. The default stays the readable development build the journeys debug against; speed is measured with `production` (scripts/qa/ui-motion.mjs --production). */
export async function buildPreview({ outdir = resolve(root, 'dist'), write = true, production = false } = {}) {
  const targetDir = resolve(outdir);
  const cacheFile = cacheEnabled() ? resolve(buildCacheDir, `preview-${production ? 'prod' : 'dev'}-${await sourceTreeDigest()}.json`) : null;
  let files = cacheFile ? await readFile(cacheFile, 'utf8').then(JSON.parse, () => null) : null;
  if (!Array.isArray(files)) {
    // The local preview server exposes app.js/app.css only. Its single IIFE
    // includes the same authored lazy boundaries without extra HTTP resources.
    const built = await build({
      absWorkingDir: root, entryPoints: ['ui/dev.jsx'], plugins: [shimJsxRuntime],
      bundle: true, outdir: targetDir, write: false, entryNames: 'app', platform: 'browser',
      format: 'iife', loader: { '.css': 'css' }, minify: production,
      ...(production ? { define: { 'process.env.NODE_ENV': '"production"' } } : {}),
    });
    files = built.outputFiles.map(file => ({ name: basename(file.path), text: file.text }));
    if (cacheFile) await writeCacheAtomically(cacheFile, JSON.stringify(files)).catch(() => {});
  }
  if (write) {
    await mkdir(targetDir, { recursive: true });
    await Promise.all(files.map(({ name, text }) => writeFile(resolve(targetDir, name), text)));
    return { errors: [], warnings: [] };
  }
  return { errors: [], warnings: [], outputFiles: files.map(({ name, text }) => ({ path: resolve(targetDir, name), text, contents: Buffer.from(text) })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const hostOnly = process.argv.includes('--host-only');
  await buildHostClient();
  if (!hostOnly) await buildPreview();
  console.log(hostOnly ? 'Built DSH client modules' : 'Built DSH client modules and standalone preview');
}
