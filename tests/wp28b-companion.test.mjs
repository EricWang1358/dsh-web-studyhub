import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SERVER_NAME, serverConfig, mount, readEndpoint } from '../packages/studyhub-retrieval/index.js';

/* WP28b: the companion bundle @ericwang1358/studyhub-retrieval. DSH installs it like any bundle; its own
   plugin mounts DSH's MCP client for a local search server that DSH's own runtime starts, so no config file
   is edited and no system Node, Python or Docker is needed. */

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'packages/studyhub-retrieval/package.json'), 'utf8'));

test('the bundle declares what DSH needs: a patch layer, a pinned server dependency, an optional MCP client peer, display text', async () => {
  assert.equal(manifest.name, '@ericwang1358/studyhub-retrieval');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.match(manifest.dependencies['mcp-local-rag'], /^\d+\.\d+\.\d+$/, 'an exact version: the tool names and arguments StudyHub calls are the ones checked');
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-mcp-client']);
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-mcp-client'].optional, true);
  assert.ok(manifest.files.includes('index.js') && manifest.files.some(file => file.startsWith('locale')));
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(join(root, `packages/studyhub-retrieval/locale/${language}.json`), 'utf8'));
    assert.ok(locale.meta.title && locale.meta.description);
  }
  const patch = YAML.parse(await readFile(join(root, 'packages/studyhub-retrieval/cordis.patch.yml'), 'utf8'));
  assert.deepEqual(patch[0].insert.map(row => [row.id, row.name]), [['studyhub-retrieval', '@ericwang1358/studyhub-retrieval']]);
});

test('peers the server needs at runtime are declared, because DSH\'s installer does not add peer dependencies', () => {
  // @lancedb/lancedb (under mcp-local-rag) requires apache-arrow >=15.0.0 <=18.1.0 as a peer; without it the
  // server exits at start with "Cannot find module 'apache-arrow'" and the extension looks installed but never runs.
  const arrow = manifest.dependencies['apache-arrow'];
  assert.match(arrow, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = arrow.split('.').map(Number);
  assert.ok(major >= 15 && (major < 18 || (major === 18 && (minor < 1 || (minor === 1 && patch === 0)))), `apache-arrow ${arrow} within lancedb's peer range`);
});

test('the server runs on DSH\'s own Node with absolute paths under the StudyHub home; nothing is read from PATH or a config file', () => {
  const home = join(tmpdir(), 'dsh-home');
  const config = serverConfig({ home, entry: join(home, 'node_modules', 'mcp-local-rag', 'dist', 'index.js'), execPath: process.execPath });
  assert.equal(config.serverName, SERVER_NAME);
  assert.equal(SERVER_NAME, 'studyhub');
  assert.equal(config.transport, 'stdio');
  assert.equal(config.command, process.execPath);
  assert.ok(isAbsolute(config.args[0]));
  for (const key of ['DB_PATH', 'CACHE_DIR', 'BASE_DIR']) assert.ok(config.env[key].startsWith(join(home, 'study', 'retrieval')), key);
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.ok(config.toolCallTimeoutMs >= 10 * 60 * 1000, 'the first call downloads the embedding model');
  assert.equal(config.failOnStartupError, false);
  assert.equal(JSON.stringify(config).match(/KEY|TOKEN|SECRET|PASSWORD/i), null, 'no credentials');
});

test('under DSH Desktop (Electron as Node) the child is told to run as Node; a documented download endpoint is passed on', () => {
  const config = serverConfig({ home: '/h', entry: '/h/x.js', execPath: '/app/DSH.exe', electron: true, hfEndpoint: 'https://models.example.org' });
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(config.env.HF_ENDPOINT, 'https://models.example.org');
  assert.equal(config.command, '/app/DSH.exe');
});

test('the download endpoint comes from the StudyHub settings file and must be an https address', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wp28b-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await readEndpoint(home), undefined);
  await mkdir(join(home, 'study'), { recursive: true });
  await writeFile(join(home, 'study', 'retrieval.json'), JSON.stringify({ provider: 'builtin', hfEndpoint: 'https://mirror.example.org' }));
  assert.equal(await readEndpoint(home), 'https://mirror.example.org');
  await writeFile(join(home, 'study', 'retrieval.json'), JSON.stringify({ hfEndpoint: 'file:///etc/passwd' }));
  assert.equal(await readEndpoint(home), undefined);
  await writeFile(join(home, 'study', 'retrieval.json'), '{not json');
  assert.equal(await readEndpoint(home), undefined);
});

test('mounting: needs a recent Node and DSH\'s MCP client, and says so instead of failing DSH', async () => {
  const calls = [];
  const ctx = { plugin: (...args) => { calls.push(args); } };
  const client = { name: 'mcp-client' };
  const base = { home: join(tmpdir(), 'wp28b-mount'), execPath: '/n', resolveEntry: () => '/h/index.js', loadClient: async () => client, node: '22.22.0', warn() {} };
  const mounted = await mount(ctx, base);
  assert.equal(mounted.mounted, true);
  assert.equal(calls[0][0], client);
  assert.equal(calls[0][1].serverName, 'studyhub');
  assert.deepEqual(await mount(ctx, { ...base, node: '20.11.0' }), { mounted: false, reason: 'node' });
  assert.deepEqual(await mount(ctx, { ...base, loadClient: async () => { throw Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }); } }), { mounted: false, reason: 'client' });
  assert.deepEqual(await mount(ctx, { ...base, resolveEntry: () => { throw new Error('missing'); } }), { mounted: false, reason: 'server' });
  assert.equal(calls.length, 1);
});

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(Buffer.concat(err).toString('utf8') || `exit ${code}`)));
  });
}

test('the release pack builds the companion as an asset with its checksum, at the same version as the main package', async t => {
  const outdir = await mkdtemp(join(tmpdir(), 'wp28b-release-'));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  const main = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const env = { ...process.env }; delete env.npm_execpath;
  await run(process.execPath, [join(root, 'scripts/release-alpha.mjs'), `--outdir=${outdir}`], { cwd: root, env });
  const artifacts = JSON.parse(await readFile(join(outdir, 'artifacts.json'), 'utf8'));
  const companion = artifacts.archives.find(archive => archive.name === '@ericwang1358/studyhub-retrieval');
  assert.ok(companion, 'the companion is an archive of the release');
  assert.equal(companion.version, main.version);
  assert.equal(companion.filename, `ericwang1358-studyhub-retrieval-${main.version}.tgz`);
  const sums = await readFile(join(outdir, `SHA256SUMS-${main.version}.txt`), 'utf8');
  assert.match(sums, new RegExp(`^${companion.sha256}  ${companion.filename}$`, 'm'));
  const packed = JSON.parse(await run('tar', ['-xzOf', companion.filename, 'package/package.json'], { cwd: outdir }));
  assert.equal(packed.version, main.version);
  assert.equal(packed.dependencies['mcp-local-rag'], manifest.dependencies['mcp-local-rag']);
  assert.equal(packed.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok((await run('tar', ['-tzf', companion.filename], { cwd: outdir })).includes('package/index.js'));
});
