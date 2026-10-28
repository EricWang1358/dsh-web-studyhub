/* The ZCode package of a release (npm run release:zcode), built on the `zcode` branch after it merged the release commit
   of `main`: StudyHub-ZCode-<version>.zip and SHA256SUMS-ZCode-<version>.txt, uploaded to the same GitHub release
   v<version> as two extra assets (main's own release keeps its assets). Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   The zip holds one folder, StudyHub-ZCode-<version>/:
     install.bat                 finds ZCode, checks Node 22+, registers this folder as a local marketplace and installs
     marketplace.json            the one-plugin marketplace "studyhub-bundle"
     README-ZCode.md, README-ZCode.zh-CN.md   the guide (docs/zcode*.md)
     studyhub/                   the plugin: .zcode-plugin, commands, hooks, host, install, the built panel (dist/ui), and
                                 StudyHub's lib, skills, references, locale and presets from this same commit, with its
                                 production node_modules installed here, so the learner's computer needs no npm and no network.
   The plugin's version is StudyHub's. Options: --outdir=<dir> (default output/release-<version>), --keep (keep the staging folder). */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildZcodePanel } from './build-zcode.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginSource = join(root, 'packages', 'studyhub-zcode');
export const MARKETPLACE = 'studyhub-bundle';
export const zipName = (version) => `StudyHub-ZCode-${version}.zip`;
export const sumsName = (version) => `SHA256SUMS-ZCode-${version}.txt`;
export const RECEIPT = 'artifacts-zcode.json';
/** StudyHub's own parts the plugin carries (the same set scripts/release-alpha.mjs stages for the domain packages). */
export const STUDYHUB_PARTS = ['lib', 'skills', 'references', 'locale', 'presets', 'LICENSE'];
/** The plugin's own parts, from packages/studyhub-zcode. */
export const PLUGIN_PARTS = ['.zcode-plugin', 'commands', 'hooks', 'host', 'install'];

const run = (command, args, options = {}) => new Promise((done, fail) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let out = '', err = '';
  child.stdout.on('data', (bytes) => { out += bytes; });
  child.stderr.on('data', (bytes) => { err += bytes; });
  child.on('error', fail);
  child.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`${command} ${args.join(' ')} exited ${code}: ${err || out}`))));
});

function npmCli() {
  const found = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find((candidate) => candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate));
  if (!found) throw new Error('Cannot find npm-cli.js; run the pack through npm (npm run release:zcode)');
  return found;
}

/** Every bare package lib/ imports (lib/client*.js, the DSH UI bundle, is not part of the plugin). */
export async function libPackages(dir = join(root, 'lib')) {
  const names = new Set();
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(m?js)$/.test(entry.name) && !/^client(\..+)?\.js$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        // Static imports and re-exports (`… from '…'`, a bare `import '…'`) and dynamic import('…') of a package name.
        for (const [, specifier] of text.matchAll(/(?:^\s*(?:import|export)\s[^;'"]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)['"]((?:@[\w.-]+\/)?\w[\w.-]*(?:\/[\w./-]*)?)['"]/gm)) {
          if (specifier.startsWith('node:')) continue;
          names.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
        }
      }
    }
  };
  await walk(dir);
  return [...names].sort();
}

/** The plugin's package.json: its own dependencies plus the ones lib/ imports, at the versions StudyHub declares. */
export async function pluginManifest(version) {
  const studyhub = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const own = JSON.parse(await readFile(join(pluginSource, 'package.json'), 'utf8'));
  const optional = new Set(Object.keys(studyhub.peerDependenciesMeta || {}).filter((name) => studyhub.peerDependenciesMeta[name]?.optional));
  const declared = { ...studyhub.devDependencies, ...studyhub.dependencies };
  const dependencies = { ...own.dependencies };
  for (const name of await libPackages()) {
    if (optional.has(name) || dependencies[name]) continue;
    if (!declared[name]) throw new Error(`lib/ imports ${name}, which StudyHub's package.json does not declare`);
    dependencies[name] = declared[name];
  }
  const { devDependencies: _dev, studyhub: _note, ...rest } = own;
  return { ...rest, version, dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) };
}

export const marketplaceOf = (version, description) => ({
  name: MARKETPLACE,
  displayName: 'StudyHub for ZCode',
  plugins: [{ name: 'studyhub', source: './studyhub', version, description, displayName: 'StudyHub',
    displayName_i18n: { 'zh-CN': 'StudyHub 学习中枢' },
    description_i18n: { 'zh-CN': '把课程资料变成带出处的题目、练习和间隔复习，在 ZCode 侧栏里学；与同一台电脑上的 DeepSeek Harness 共用学习库。' } }],
});

/** Stage the plugin folder under `folder` (StudyHub-ZCode-<version>). */
export async function stage(folder, version) {
  const plugin = join(folder, 'studyhub');
  await rm(folder, { recursive: true, force: true });
  await mkdir(plugin, { recursive: true });
  for (const part of PLUGIN_PARTS) await cp(join(pluginSource, part), join(plugin, part), { recursive: true });
  for (const part of STUDYHUB_PARTS)
    await cp(join(root, part), join(plugin, part), { recursive: true, filter: (source) => !/^client(\..+)?\.js$/.test(source.split(sep).pop()) });
  await buildZcodePanel({ outdir: join(plugin, 'dist', 'ui') });
  const manifest = await pluginManifest(version);
  await writeFile(join(plugin, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const pluginJson = JSON.parse(await readFile(join(pluginSource, '.zcode-plugin', 'plugin.json'), 'utf8'));
  await writeFile(join(plugin, '.zcode-plugin', 'plugin.json'), `${JSON.stringify({ ...pluginJson, version }, null, 2)}\n`);
  // install.bat sits next to marketplace.json; cmd.exe needs CRLF.
  await rm(join(plugin, 'install', 'install.bat'));
  const bat = (await readFile(join(pluginSource, 'install', 'install.bat'), 'utf8')).replace(/\r?\n/g, '\r\n');
  if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(bat)) throw new Error('install.bat must be ASCII');
  await writeFile(join(folder, 'install.bat'), bat);
  await writeFile(join(folder, 'marketplace.json'), `${JSON.stringify(marketplaceOf(version, pluginJson.description), null, 2)}\n`);
  await cp(join(root, 'docs', 'zcode.md'), join(folder, 'README-ZCode.md'));
  await cp(join(root, 'docs', 'zcode.zh-CN.md'), join(folder, 'README-ZCode.zh-CN.md'));
  // Production dependencies only, installed here: the learner's computer runs no npm.
  await run(process.execPath, [npmCli(), 'install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'], { cwd: plugin });
  return plugin;
}

/** Windows' own tar (bsdtar, which reads and writes zip), not a Git-for-Windows GNU tar earlier on PATH. */
export const windowsTar = () => join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe');

/** Zip `folder` (its name becomes the zip's top folder). Windows' tar writes zip by extension; elsewhere `zip`. */
export async function zipFolder(folder, zipPath) {
  await rm(zipPath, { force: true });
  if (process.platform === 'win32') await run(windowsTar(), ['-a', '-c', '-f', zipPath, '-C', dirname(folder), relative(dirname(folder), folder)]);
  else await run('zip', ['-r', '-q', '-X', zipPath, relative(dirname(folder), folder)], { cwd: dirname(folder) });
}

export async function releaseZcode({ outdir, keep = false } = {}) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Release version must be a valid version number');
  const target = resolve(root, outdir || join('output', `release-${version}`));
  await mkdir(target, { recursive: true });
  const folder = join(target, 'zcode', `StudyHub-ZCode-${version}`);
  await stage(folder, version);
  const zip = join(target, zipName(version));
  await zipFolder(folder, zip);
  if (!keep) await rm(join(target, 'zcode'), { recursive: true, force: true });
  const bytes = await readFile(zip);
  const artifact = { filename: zipName(version), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(join(target, sumsName(version)), `${artifact.sha256}  ${artifact.filename}\n`);
  await writeFile(join(target, RECEIPT), `${JSON.stringify({ version, zcode: artifact, checksums: sumsName(version) }, null, 2)}\n`);
  return { directory: target, version, zcode: artifact, checksums: sumsName(version), size: (await stat(zip)).size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outdir = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice(9);
  console.log(JSON.stringify(await releaseZcode({ outdir, keep: process.argv.includes('--keep') }), null, 2));
}
