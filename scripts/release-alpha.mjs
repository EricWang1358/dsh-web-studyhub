import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('Release version must be a valid version number');
const outputArg = process.argv.find(arg => arg.startsWith('--outdir='))?.slice('--outdir='.length);
const target = outputArg ? resolve(root, outputArg) : resolve(root, 'output', `release-${manifest.version}`);
await mkdir(target, { recursive: true });
// npm's CLI sits next to node.exe on Windows and under <prefix>/lib/node_modules on Linux and macOS.
const npmCli = [process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  .find(candidate => candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate));
if (!npmCli) throw new Error('Cannot find npm-cli.js; run the release pack through npm (npm run release:pack)');
async function pack(cwd) {
  const child = spawn(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', target],
    { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(errors || `npm pack exited ${code}`)));
  });
  const receipt = JSON.parse(output)[0];
  return { name: receipt.name, version: receipt.version, filename: receipt.filename, bytes: receipt.size,
    sha256: createHash('sha256').update(await readFile(join(target, receipt.filename))).digest('hex') };
}

// Build and verification are deliberately owned by the release coordinator.
const archives = [await pack(root)];
await mkdir(join(target, 'packages'), { recursive: true });
for (const domain of ['runtime', 'materials', 'bank', 'study', 'generation', 'audio']) {
  const staging = await mkdtemp(join(target, 'packages', `${domain}-`));
  for (const path of ['lib', 'references', 'locale', 'presets', 'LICENSE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'CHANGELOG.zh-CN.md'])
    await cp(join(root, path), join(staging, path), { recursive: true });
  await mkdir(join(staging, 'docs'), { recursive: true });
  for (const path of manifest.files.filter(path => path.startsWith('docs/'))) {
    await mkdir(dirname(join(staging, path)), { recursive: true });
    await cp(join(root, path), join(staging, path));
  }
  const name = `@ericwang1358/dsh-study-${domain}`;
  const entry = `./lib/plugins/${domain}.js`;
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name, version: manifest.version, description: `StudyHub ${domain} capability plugin for DSH`,
    type: 'module', main: entry, exports: { '.': entry, './runtime': './lib/runtime.js', './locale/*': `./locale/plugins/${domain}/*`, './package.json': './package.json' },
    files: manifest.files,
    author: manifest.author, license: manifest.license, engines: manifest.engines, dependencies: manifest.dependencies,
    peerDependencies: manifest.peerDependencies, peerDependenciesMeta: manifest.peerDependenciesMeta,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  await writeFile(join(staging, 'cordis.patch.yml'), `- insert:\n    - id: study-${domain}\n      name: '${name}'\n      config: {}\n`);
  archives.push(await pack(staging));
}
// The search extension (WP28b): a companion bundle StudyHub installs on request; same version, same checksum list.
{
  const source = join(root, 'packages', 'studyhub-retrieval');
  const staging = await mkdtemp(join(target, 'packages', 'retrieval-'));
  await cp(source, staging, { recursive: true });
  await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
  const companion = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await writeFile(join(staging, 'package.json'), JSON.stringify({ ...companion, version: manifest.version }, null, 2) + '\n');
  archives.push(await pack(staging));
}
const setupFilename = `StudyHub-${manifest.version}-Setup.html`;
await cp(join(root, 'docs/install.html'), join(target, setupFilename));
const setup = { filename: setupFilename,
  sha256: createHash('sha256').update(await readFile(join(target, setupFilename))).digest('hex') };
const setupZhFilename = `StudyHub-${manifest.version}-Setup.zh-CN.html`;
await cp(join(root, 'docs/install.zh-CN.html'), join(target, setupZhFilename));
const setupZh = { filename: setupZhFilename,
  sha256: createHash('sha256').update(await readFile(join(target, setupZhFilename))).digest('hex') };
await writeFile(join(target, `SHA256SUMS-${manifest.version}.txt`), [...archives, setup, setupZh].map(artifact => `${artifact.sha256}  ${artifact.filename}`).join('\n') + '\n');
await writeFile(join(target, 'artifacts.json'), JSON.stringify({ version: manifest.version, archives, setup, setupZh }, null, 2) + '\n');
console.log(JSON.stringify({ directory: target, archives, setup, setupZh }, null, 2));
