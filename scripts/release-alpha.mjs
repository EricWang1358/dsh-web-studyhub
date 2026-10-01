import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!manifest.version.includes('-alpha.')) throw new Error('This packaging command is for alpha releases');
const outputArg = process.argv.find(arg => arg.startsWith('--outdir='))?.slice('--outdir='.length);
const target = outputArg ? resolve(root, outputArg) : resolve(root, 'output', `release-${manifest.version}`);
await mkdir(target, { recursive: true });
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
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
for (const domain of ['runtime', 'materials', 'bank', 'study', 'generation', 'audio']) {
  const staging = join(target, 'packages', domain);
  await mkdir(staging, { recursive: true });
  for (const path of ['lib', 'references', 'LICENSE', 'README.md'])
    await cp(join(root, path), join(staging, path), { recursive: true });
  await mkdir(join(staging, 'docs'), { recursive: true });
  await cp(join(root, 'docs/architecture.md'), join(staging, 'docs/architecture.md'));
  const name = `@ericwang1358/dsh-study-${domain}`;
  const entry = `./lib/plugins/${domain}.js`;
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name, version: manifest.version, description: `StudyHub ${domain} capability plugin for DSH`,
    type: 'module', main: entry, exports: { '.': entry, './runtime': './lib/runtime.js', './package.json': './package.json' },
    files: ['lib', 'references', 'docs/architecture.md', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    license: manifest.license, engines: manifest.engines, dependencies: manifest.dependencies,
    peerDependencies: manifest.peerDependencies, peerDependenciesMeta: manifest.peerDependenciesMeta,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  await writeFile(join(staging, 'cordis.patch.yml'), `- insert:\n    - id: study-${domain}\n      name: '${name}'\n      config: {}\n`);
  archives.push(await pack(staging));
}
await writeFile(join(target, `SHA256SUMS-${manifest.version}.txt`), archives.map(archive => `${archive.sha256}  ${archive.filename}`).join('\n') + '\n');
await writeFile(join(target, 'artifacts.json'), JSON.stringify({ version: manifest.version, archives }, null, 2) + '\n');
console.log(JSON.stringify({ directory: target, archives }, null, 2));
