import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractZipEntry } from './zip-utils.mjs';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(desktopRoot, '../..');
const DEFAULT_NODE_VERSION = '22.22.3';
const CLIENT_BUNDLE_RE = /^client(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/;
// Host-provided runtime dependencies imported statically by lib/** (devDependencies in root package.json because DSH provides them).
const REQUIRED_HOST_RUNTIME_DEPS = ['@deepseek-ai/cordis'];
// Fallback retrieval index-heal helpers referenced by desktop retrieval runtime when an installation lacks them.
const RETRIEVAL_HELPER_FILES = ['heal.js', 'check-index.mjs'];
// External-agent CLI bridge bundled into the packaged runtime alongside lib/**.
const CLI_SCRIPT_FILES = ['study-cli.mjs'];

async function pathExists(target) {
  return access(target).then(() => true, () => false);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function downloadPortableNode(destPath, version) {
  const baseUrl = (process.env.STUDYHUB_NODE_DIST_URL || `https://nodejs.org/dist/v${version}`).replace(/\/$/, '');
  const zipName = `node-v${version}-win-x64.zip`;
  const [sumsRes, zipRes] = await Promise.all([
    fetch(`${baseUrl}/SHASUMS256.txt`),
    fetch(`${baseUrl}/${zipName}`),
  ]);
  if (!sumsRes.ok) throw new Error(`Failed to fetch Node SHASUMS256.txt (HTTP ${sumsRes.status})`);
  if (!zipRes.ok) throw new Error(`Failed to fetch ${zipName} (HTTP ${zipRes.status})`);

  const sumsText = await sumsRes.text();
  const expectedLine = sumsText.split(/\r?\n/).find((line) => line.trim().endsWith(`  ${zipName}`));
  if (!expectedLine) throw new Error(`SHASUMS256.txt did not list ${zipName}`);
  const expectedHash = expectedLine.trim().split(/\s+/)[0].toLowerCase();

  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  const actualHash = sha256Hex(zipBuf);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA256 mismatch for ${zipName}: expected ${expectedHash}, got ${actualHash}`);
  }

  const extracted = extractZipEntry(zipBuf, (name) => name.endsWith('/node.exe') || name === 'node.exe');
  await writeFile(destPath, extracted.data);
  return { source: `${baseUrl}/${zipName}`, sha256: actualHash };
}

async function stageNodeBinary(runtimeDir, options) {
  const binaryName = process.platform === 'win32' || options.downloadNode ? 'node.exe' : 'node';
  const destPath = join(runtimeDir, binaryName);
  if (options.nodePath) {
    await copyFile(resolve(options.nodePath), destPath);
    return { source: resolve(options.nodePath), binaryName };
  }
  if (options.downloadNode) {
    const downloaded = await downloadPortableNode(destPath, options.nodeVersion);
    return { ...downloaded, binaryName };
  }
  await copyFile(process.execPath, destPath);
  return { source: process.execPath, binaryName };
}

async function collectProductionPackages(rootNodeModules, initialNames) {
  const visited = new Set();
  const queue = [...initialNames];

  while (queue.length > 0) {
    const pkgName = queue.shift();
    if (!pkgName || visited.has(pkgName)) continue;
    const pkgDir = join(rootNodeModules, ...pkgName.split('/'));
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!(await pathExists(pkgJsonPath))) continue;
    visited.add(pkgName);
    const pkg = await readJson(pkgJsonPath);
    const nextDeps = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ];
    for (const dep of nextDeps) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return [...visited].sort();
}

async function stageProductionNodeModules(runtimeDir, rootPkg) {
  const sourceModules = join(repoRoot, 'node_modules');
  const destModules = join(runtimeDir, 'node_modules');
  const rootSeeds = [
    ...Object.keys(rootPkg.dependencies || {}),
    ...REQUIRED_HOST_RUNTIME_DEPS,
  ];
  const packages = await collectProductionPackages(sourceModules, rootSeeds);
  for (const required of REQUIRED_HOST_RUNTIME_DEPS) {
    if (!packages.includes(required)) {
      throw new Error(`Required runtime dependency missing from node_modules: ${required}`);
    }
  }
  await mkdir(destModules, { recursive: true });

  for (const pkgName of packages) {
    const src = join(sourceModules, ...pkgName.split('/'));
    const dst = join(destModules, ...pkgName.split('/'));
    await mkdir(resolve(dst, '..'), { recursive: true });
    await cp(src, dst, { recursive: true });
  }
  return packages;
}

async function stageDirectoryIfPresent(srcDir, destDir, filter) {
  if (!(await pathExists(srcDir))) return false;
  await cp(srcDir, destDir, { recursive: true, ...(filter ? { filter } : {}) });
  return true;
}

async function stageDesktopBackend(runtimeDir, allowIncomplete) {
  const destDesktop = join(runtimeDir, 'packages', 'studyhub-desktop');
  await mkdir(destDesktop, { recursive: true });
  await copyFile(join(desktopRoot, 'package.json'), join(destDesktop, 'package.json'));

  const layers = ['domain', 'application', 'adapters', 'entry'];
  const copied = [];
  for (const layer of layers) {
    const ok = await stageDirectoryIfPresent(join(desktopRoot, layer), join(destDesktop, layer));
    if (ok) copied.push(layer);
  }
  const sidecarEntry = join(destDesktop, 'entry', 'sidecar.mjs');
  if (!allowIncomplete && !(await pathExists(sidecarEntry))) {
    throw new Error(`Missing sidecar entry after staging: ${sidecarEntry}`);
  }
  return copied;
}

async function stageRetrievalHelpers(runtimeDir) {
  const srcDir = join(repoRoot, 'packages', 'studyhub-retrieval');
  const destDir = join(runtimeDir, 'packages', 'studyhub-retrieval');
  const staged = [];
  for (const name of RETRIEVAL_HELPER_FILES) {
    const src = join(srcDir, name);
    if (!(await pathExists(src))) continue;
    await mkdir(destDir, { recursive: true });
    await copyFile(src, join(destDir, name));
    staged.push(name);
  }
  return staged;
}

async function stageCliScripts(runtimeDir, allowIncomplete) {
  const srcDir = join(repoRoot, 'scripts');
  const destDir = join(runtimeDir, 'scripts');
  const staged = [];
  for (const name of CLI_SCRIPT_FILES) {
    const src = join(srcDir, name);
    if (!(await pathExists(src))) {
      if (allowIncomplete) continue;
      throw new Error(`Missing CLI script after staging: ${src}`);
    }
    await mkdir(destDir, { recursive: true });
    await copyFile(src, join(destDir, name));
    staged.push(name);
  }
  return staged;
}

function buildRuntimePackageJson(rootPkg) {
  return {
    name: rootPkg.name,
    version: rootPkg.version,
    type: rootPkg.type || 'module',
    main: rootPkg.main,
    exports: rootPkg.exports,
    dependencies: rootPkg.dependencies || {},
  };
}

export async function stageRuntime({
  outdir = join(desktopRoot, 'src-tauri', 'resources', 'runtime'),
  nodePath = process.env.STUDYHUB_STAGE_NODE_PATH || '',
  downloadNode = process.env.STUDYHUB_STAGE_DOWNLOAD_NODE === '1',
  nodeVersion = process.env.STUDYHUB_NODE_VERSION || DEFAULT_NODE_VERSION,
  allowIncomplete = false,
} = {}) {
  const runtimeDir = resolve(outdir);
  const gitkeepPath = join(runtimeDir, '.gitkeep');
  const preserveGitkeep = await pathExists(gitkeepPath);
  const rootPkg = await readJson(join(repoRoot, 'package.json'));
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  if (preserveGitkeep) {
    await writeFile(gitkeepPath, '', 'utf8');
  }

  const nodeInfo = await stageNodeBinary(runtimeDir, { nodePath, downloadNode, nodeVersion });
  await writeFile(
    join(runtimeDir, 'package.json'),
    `${JSON.stringify(buildRuntimePackageJson(rootPkg), null, 2)}\n`,
    'utf8'
  );

  await stageDirectoryIfPresent(join(repoRoot, 'lib'), join(runtimeDir, 'lib'), (src) => {
    const parent = basename(resolve(src, '..'));
    return !(parent === 'lib' && CLIENT_BUNDLE_RE.test(basename(src)));
  });

  for (const dirName of ['skills', 'references', 'locale', 'presets']) {
    await stageDirectoryIfPresent(join(repoRoot, dirName), join(runtimeDir, dirName));
  }

  const packages = await stageProductionNodeModules(runtimeDir, rootPkg);
  const desktopLayers = await stageDesktopBackend(runtimeDir, allowIncomplete);
  const retrievalHelpers = await stageRetrievalHelpers(runtimeDir);
  const cliScripts = await stageCliScripts(runtimeDir, allowIncomplete);
  const manifest = {
    version: rootPkg.version,
    node: nodeInfo,
    productionPackages: packages.length,
    desktopLayers,
    retrievalHelpers,
    cliScripts,
  };
  await writeFile(
    join(runtimeDir, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outArg = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice(9);
  const nodeArg = process.argv.find((arg) => arg.startsWith('--node-path='))?.slice(12);
  const result = await stageRuntime({
    ...(outArg ? { outdir: resolve(outArg) } : {}),
    ...(nodeArg ? { nodePath: nodeArg } : {}),
    downloadNode: process.argv.includes('--download-node') || process.env.STUDYHUB_STAGE_DOWNLOAD_NODE === '1',
    allowIncomplete: process.argv.includes('--allow-incomplete'),
  });
  console.log(
    `Staged StudyHub Desktop runtime v${result.version}: ${result.productionPackages} prod packages, layers [${result.desktopLayers.join(', ')}]`
  );
}
