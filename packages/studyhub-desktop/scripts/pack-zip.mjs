import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createZipBuffer } from './zip-utils.mjs';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(desktopRoot, '../..');

async function pathExists(target) {
  return access(target).then(() => true, () => false);
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function resolveExecutable(explicitExe) {
  if (explicitExe) {
    const candidate = resolve(explicitExe);
    if (!(await pathExists(candidate))) throw new Error(`Desktop executable not found: ${candidate}`);
    return candidate;
  }
  const releaseDir = join(desktopRoot, 'src-tauri', 'target', 'release');
  for (const name of ['StudyHub.exe', 'studyhub-desktop.exe']) {
    const candidate = join(releaseDir, name);
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(`Compiled desktop executable not found in ${releaseDir}`);
}

async function walkFiles(dir, baseDir) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const collected = [];
  for (const entry of entries) {
    if (entry.name === '.gitkeep') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await walkFiles(fullPath, baseDir)));
    } else if (entry.isFile()) {
      collected.push({
        fullPath,
        relPath: relative(baseDir, fullPath).split(sep).join('/'),
      });
    }
  }
  return collected;
}

const DEFAULT_REPO = 'EricWang1358/dsh-web-studyhub';

async function findBuiltMsi(msiDir = join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'msi')) {
  if (!(await pathExists(msiDir))) return null;
  const files = (await readdir(msiDir)).filter((name) => name.toLowerCase().endsWith('.msi')).sort();
  return files.length > 0 ? join(msiDir, files[0]) : null;
}

async function findBuiltNsis(nsisDir = join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'nsis')) {
  if (!(await pathExists(nsisDir))) return null;
  const files = (await readdir(nsisDir))
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .sort();
  if (files.length === 0) return null;
  const exePath = join(nsisDir, files[0]);
  const sigCandidate = `${exePath}.sig`;
  const sigPath = (await pathExists(sigCandidate)) ? sigCandidate : null;
  return { exePath, sigPath };
}

export function buildUpdaterManifest({
  version,
  signature,
  downloadUrl,
  pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  notes = `StudyHub Desktop ${version}`,
}) {
  const platformEntry = {
    signature: String(signature).trim(),
    url: downloadUrl,
  };
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': platformEntry,
      'windows-x86_64-nsis': { ...platformEntry },
    },
  };
}

async function copyHashedArtifact(sourcePath, destName, releaseOut) {
  const destPath = join(releaseOut, destName);
  await copyFile(sourcePath, destPath);
  const buf = await readFile(destPath);
  return { name: destName, sha256: sha256Hex(buf), bytes: buf.length };
}

async function packageNsisArtifacts({ nsisDir, releaseOut, releaseVersion, repo, pubDate }) {
  const nsisBuilt = await findBuiltNsis(nsisDir);
  if (!nsisBuilt) return { artifact: null, updaterManifest: null };
  const setupName = `StudyHub-Desktop-${releaseVersion}-win-x64-setup.exe`;
  const artifact = await copyHashedArtifact(nsisBuilt.exePath, setupName, releaseOut);
  if (!nsisBuilt.sigPath) return { artifact, updaterManifest: null };

  const sigDest = join(releaseOut, `${setupName}.sig`);
  await copyFile(nsisBuilt.sigPath, sigDest);
  const signature = (await readFile(sigDest, 'utf8')).trim();
  const downloadUrl = `https://github.com/${repo}/releases/download/v${releaseVersion}/${setupName}`;
  const manifest = buildUpdaterManifest({
    version: releaseVersion,
    signature,
    downloadUrl,
    ...(pubDate ? { pubDate } : {}),
  });
  await writeFile(join(releaseOut, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { artifact, updaterManifest: 'latest.json' };
}

async function collectZipEntries(resolvedExe, resolvedRuntime, prefix) {
  const runtimeFiles = await walkFiles(resolvedRuntime, resolvedRuntime);
  const exeStat = await stat(resolvedExe);
  const entries = [
    { name: `${prefix}/StudyHub.exe`, data: await readFile(resolvedExe), mtime: exeStat.mtime },
  ];
  for (const item of runtimeFiles) {
    const info = await stat(item.fullPath);
    entries.push({
      name: `${prefix}/resources/runtime/${item.relPath}`,
      data: await readFile(item.fullPath),
      mtime: info.mtime,
    });
  }
  return entries;
}

function resolvePackOptions(options = {}) {
  return {
    outdir: options.outdir || join(desktopRoot, 'dist', 'release'),
    runtimeDir: options.runtimeDir || join(desktopRoot, 'src-tauri', 'resources', 'runtime'),
    exePath: options.exePath || '',
    version: options.version || '',
    msiDir: options.msiDir || join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'msi'),
    nsisDir: options.nsisDir || join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'nsis'),
    repo: options.repo || process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
    pubDate: options.pubDate || '',
  };
}

export async function packPortableZip(options = {}) {
  const { outdir, runtimeDir, exePath, version, msiDir, nsisDir, repo, pubDate } = resolvePackOptions(options);
  const rootPkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const releaseVersion = version || rootPkg.version;
  const resolvedExe = await resolveExecutable(exePath);
  const resolvedRuntime = resolve(runtimeDir);
  if (!(await pathExists(join(resolvedRuntime, 'lib')))) {
    throw new Error(`Staged runtime is incomplete (missing lib/): ${resolvedRuntime}`);
  }

  const releaseOut = resolve(outdir);
  await mkdir(releaseOut, { recursive: true });
  const zipName = `StudyHub-Desktop-${releaseVersion}-win-x64.zip`;
  const zipBuffer = createZipBuffer(
    await collectZipEntries(resolvedExe, resolvedRuntime, `StudyHub-Desktop-${releaseVersion}`),
  );
  await writeFile(join(releaseOut, zipName), zipBuffer);

  const artifacts = [{ name: zipName, sha256: sha256Hex(zipBuffer), bytes: zipBuffer.length }];
  const msiSource = await findBuiltMsi(msiDir);
  if (msiSource) {
    artifacts.push(
      await copyHashedArtifact(msiSource, `StudyHub-Desktop-${releaseVersion}-win-x64.msi`, releaseOut),
    );
  }
  const nsisPack = await packageNsisArtifacts({ nsisDir, releaseOut, releaseVersion, repo, pubDate });
  if (nsisPack.artifact) artifacts.push(nsisPack.artifact);

  const checksumsName = `SHA256SUMS-Desktop-${releaseVersion}.txt`;
  const checksumsBody = artifacts
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => `${item.sha256}  ${item.name}`)
    .join('\n')
    .concat('\n');
  await writeFile(join(releaseOut, checksumsName), checksumsBody, 'utf8');

  return {
    version: releaseVersion,
    outdir: releaseOut,
    checksums: checksumsName,
    updaterManifest: nsisPack.updaterManifest,
    artifacts: artifacts.map((item) => ({ ...item, file: basename(item.name) })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outArg = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice(9);
  const runtimeArg = process.argv.find((arg) => arg.startsWith('--runtime-dir='))?.slice(14);
  const exeArg = process.argv.find((arg) => arg.startsWith('--exe='))?.slice(6);
  const verArg = process.argv.find((arg) => arg.startsWith('--version='))?.slice(10);
  const result = await packPortableZip({
    ...(outArg ? { outdir: resolve(outArg) } : {}),
    ...(runtimeArg ? { runtimeDir: resolve(runtimeArg) } : {}),
    ...(exeArg ? { exePath: exeArg } : {}),
    ...(verArg ? { version: verArg } : {}),
  });
  console.log(
    `Packed ${result.artifacts.map((a) => `${a.name} (${(a.bytes / 1048576).toFixed(2)} MiB)`).join(', ')} + ${result.checksums}`
  );
}
