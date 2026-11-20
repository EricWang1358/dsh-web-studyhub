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

async function findBuiltMsi() {
  const msiDir = join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'msi');
  if (!(await pathExists(msiDir))) return null;
  const files = (await readdir(msiDir)).filter((name) => name.toLowerCase().endsWith('.msi')).sort();
  return files.length > 0 ? join(msiDir, files[0]) : null;
}

export async function packPortableZip({
  outdir = join(desktopRoot, 'dist', 'release'),
  runtimeDir = join(desktopRoot, 'src-tauri', 'resources', 'runtime'),
  exePath = '',
  version = '',
} = {}) {
  const rootPkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const releaseVersion = version || rootPkg.version;
  const resolvedExe = await resolveExecutable(exePath);
  const resolvedRuntime = resolve(runtimeDir);
  if (!(await pathExists(join(resolvedRuntime, 'lib')))) {
    throw new Error(`Staged runtime is incomplete (missing lib/): ${resolvedRuntime}`);
  }

  const prefix = `StudyHub-Desktop-${releaseVersion}`;
  const runtimeFiles = await walkFiles(resolvedRuntime, resolvedRuntime);
  const exeStat = await stat(resolvedExe);
  const zipEntries = [
    { name: `${prefix}/StudyHub.exe`, data: await readFile(resolvedExe), mtime: exeStat.mtime },
  ];

  for (const item of runtimeFiles) {
    const info = await stat(item.fullPath);
    zipEntries.push({
      name: `${prefix}/resources/runtime/${item.relPath}`,
      data: await readFile(item.fullPath),
      mtime: info.mtime,
    });
  }

  const releaseOut = resolve(outdir);
  await mkdir(releaseOut, { recursive: true });
  const zipName = `StudyHub-Desktop-${releaseVersion}-win-x64.zip`;
  const zipPath = join(releaseOut, zipName);
  const zipBuffer = createZipBuffer(zipEntries);
  await writeFile(zipPath, zipBuffer);

  const artifacts = [{ name: zipName, sha256: sha256Hex(zipBuffer), bytes: zipBuffer.length }];
  const msiSource = await findBuiltMsi();
  if (msiSource) {
    const msiName = `StudyHub-Desktop-${releaseVersion}-win-x64.msi`;
    const msiDest = join(releaseOut, msiName);
    await copyFile(msiSource, msiDest);
    const msiBuf = await readFile(msiDest);
    artifacts.push({ name: msiName, sha256: sha256Hex(msiBuf), bytes: msiBuf.length });
  }

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
