import { existsSync } from 'node:fs';
import { access, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from '../adapters/cli/process-runner.mjs';
import { pruneRetrievalBundle } from './retrieval-prune.mjs';
import {
  EXPECTED_MCP_TOOLS,
  REQUIRED_BUNDLE_FILES,
  assertBundleComplete,
  verifyPackedRetrieval,
} from './retrieval-verify.mjs';
import { sha256File, writeZipFile } from './zip-stream.mjs';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(desktopRoot, '../..');
const DEFAULT_SOURCE_DIR = join(repoRoot, 'packages', 'studyhub-retrieval');
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const EMPTY_PRUNE = Object.freeze({ removedDirs: 0, removedFiles: 0, removedBytes: 0 });

export { EXPECTED_MCP_TOOLS, REQUIRED_BUNDLE_FILES, pruneRetrievalBundle, verifyPackedRetrieval };

export function retrievalAssetName(version) {
  return `StudyHub-Desktop-Retrieval-${version}-win-x64.zip`;
}

export function retrievalChecksumsName(version) {
  return `SHA256SUMS-Desktop-Retrieval-${version}.txt`;
}

export function formatChecksumsFile(assetName, sha256) {
  return `${sha256.toLowerCase()}  ${assetName}\n`;
}

async function pathExists(target) {
  return access(target).then(() => true, () => false);
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((p) => p && /npm-cli\.js$/i.test(p) && existsSync(p));
  if (!found) throw new Error('Cannot find npm-cli.js next to Node executable');
  return found;
}

async function walkFiles(dir, baseDir) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const collected = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await walkFiles(fullPath, baseDir)));
    } else if (entry.isFile()) {
      collected.push({
        filePath: fullPath,
        name: relative(baseDir, fullPath).split(sep).join('/'),
      });
    }
  }
  return collected;
}

async function stageSourceBundle({ sourceDir, stagingDir, releaseVersion, includeNodeModules }) {
  const resolvedSource = resolve(sourceDir);
  await cp(resolvedSource, stagingDir, {
    recursive: true,
    dereference: true,
    filter: (src) => includeNodeModules || !relative(resolvedSource, src).split(sep).includes('node_modules'),
  });
  const rootLicense = join(repoRoot, 'LICENSE');
  if (await pathExists(rootLicense)) {
    await copyFile(rootLicense, join(stagingDir, 'LICENSE'));
  }
  const pkgPath = join(stagingDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  await writeFile(pkgPath, `${JSON.stringify({ ...pkg, version: releaseVersion }, null, 2)}\n`, 'utf8');
}

async function installWin64ProdDeps(stagingDir) {
  const npmCli = findNpmCli();
  const result = await runProcess({
    command: process.execPath,
    args: [
      npmCli, 'install', '--omit=dev', '--omit=peer',
      '--no-audit', '--no-fund', '--no-package-lock',
      '--os=win32', '--cpu=x64',
    ],
    cwd: stagingDir,
    env: { ...process.env, STUDYHUB_SKIP_PREPARE: '1' },
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || result.errorMessage || '').slice(0, 1200);
    throw new Error(`npm install for retrieval bundle failed (code=${result.code}): ${detail}`);
  }
}

async function resolveReleaseVersion(explicitVersion) {
  const rootPkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const releaseVersion = explicitVersion || rootPkg.version;
  if (!SEMVER_RE.test(releaseVersion)) {
    throw new Error(`Invalid release version for retrieval bundle: ${releaseVersion}`);
  }
  return releaseVersion;
}

async function prepareStagedRetrieval({ sourceDir, stagingDir, releaseVersion, skipInstall, prune }) {
  await stageSourceBundle({ sourceDir, stagingDir, releaseVersion, includeNodeModules: skipInstall });
  if (!skipInstall) await installWin64ProdDeps(stagingDir);
  const pruned = prune ? await pruneRetrievalBundle(stagingDir) : { ...EMPTY_PRUNE };
  await assertBundleComplete(stagingDir, releaseVersion);
  return pruned;
}

export async function packRetrievalBundle(options = {}) {
  const config = {
    outdir: join(desktopRoot, 'dist', 'release'),
    sourceDir: DEFAULT_SOURCE_DIR,
    version: '',
    skipInstall: false,
    prune: true,
    verify: false,
    runMcpSmoke: true,
    forceZip64: false,
    ...options,
  };
  const releaseVersion = await resolveReleaseVersion(config.version);
  const tempRoot = await mkdtemp(join(tmpdir(), 'studyhub-pack-retrieval-'));
  const stagingDir = join(tempRoot, 'bundle');

  try {
    const pruned = await prepareStagedRetrieval({ ...config, stagingDir, releaseVersion });
    const releaseOut = resolve(config.outdir);
    await mkdir(releaseOut, { recursive: true });
    const assetName = retrievalAssetName(releaseVersion);
    const checksumsName = retrievalChecksumsName(releaseVersion);
    const zipPath = join(releaseOut, assetName);
    const checksumsPath = join(releaseOut, checksumsName);

    const files = await walkFiles(stagingDir, stagingDir);
    const zipMeta = await writeZipFile(zipPath, files, { forceZip64: config.forceZip64 });
    const sha256 = await sha256File(zipPath);
    await writeFile(checksumsPath, formatChecksumsFile(assetName, sha256), 'utf8');

    const verified = config.verify
      ? await verifyPackedRetrieval({ zipPath, checksumsPath, expectedVersion: releaseVersion, runMcpSmoke: config.runMcpSmoke })
      : null;

    return {
      version: releaseVersion,
      outdir: releaseOut,
      assetName,
      zipPath,
      checksumsName,
      checksumsPath,
      sha256,
      entries: zipMeta.entries,
      bytes: zipMeta.bytes,
      rawBytes: zipMeta.rawBytes,
      pruned,
      verified,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function parseCliFlag(prefix) {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outArg = parseCliFlag('--outdir=');
  const sourceArg = parseCliFlag('--source-dir=');
  const verArg = parseCliFlag('--version=');
  const result = await packRetrievalBundle({
    ...(outArg ? { outdir: resolve(outArg) } : {}),
    ...(sourceArg ? { sourceDir: resolve(sourceArg) } : {}),
    ...(verArg ? { version: verArg } : {}),
    skipInstall: process.argv.includes('--skip-install'),
    prune: !process.argv.includes('--no-prune'),
    verify: process.argv.includes('--verify'),
    runMcpSmoke: !process.argv.includes('--no-mcp-smoke'),
    forceZip64: process.argv.includes('--force-zip64'),
  });
  const mib = (n) => (n / 1048576).toFixed(2);
  console.log(
    `Packed ${result.assetName} (${mib(result.bytes)} MiB zip / ${mib(result.rawBytes)} MiB raw, ${result.entries} entries, pruned ${mib(result.pruned.removedBytes)} MiB) + ${result.checksumsName}${result.verified ? ' [VERIFIED]' : ''}`
  );
}
