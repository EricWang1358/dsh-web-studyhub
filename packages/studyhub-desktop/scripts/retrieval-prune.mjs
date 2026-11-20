import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ORT_WEB_BLOAT_RE = /\.(?:wasm|map)$|^(?:ort\.(?:all|webgl|webgpu|jspi)\.|ort-wasm-)/i;
const SKIP_DIR_NAMES = new Set(['.bin', '.cache']);

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function measurePath(target) {
  let info;
  try {
    info = await stat(target);
  } catch {
    return { files: 0, bytes: 0 };
  }
  if (!info.isDirectory()) return { files: 1, bytes: info.size };
  let files = 0;
  let bytes = 0;
  for (const entry of await safeReaddir(target)) {
    const child = await measurePath(join(target, entry.name));
    files += child.files;
    bytes += child.bytes;
  }
  return { files, bytes };
}

async function removeTarget(target, isDir, totals) {
  const measured = await measurePath(target);
  if (measured.files === 0 && !isDir) return;
  await rm(target, { recursive: true, force: true });
  if (isDir) totals.removedDirs += 1;
  totals.removedFiles += measured.files;
  totals.removedBytes += measured.bytes;
}

async function pruneWin32Arches(platDir, totals) {
  for (const arch of await safeReaddir(platDir)) {
    if (arch.isDirectory() && arch.name !== 'x64') {
      await removeTarget(join(platDir, arch.name), true, totals);
    }
  }
}

async function pruneOnnxRuntimeNode(pkgDir, totals) {
  const binDir = join(pkgDir, 'bin');
  for (const napi of await safeReaddir(binDir)) {
    if (!napi.isDirectory() || !napi.name.startsWith('napi-')) continue;
    const napiDir = join(binDir, napi.name);
    for (const platform of await safeReaddir(napiDir)) {
      if (!platform.isDirectory()) continue;
      const platDir = join(napiDir, platform.name);
      if (platform.name !== 'win32') await removeTarget(platDir, true, totals);
      else await pruneWin32Arches(platDir, totals);
    }
  }
}

async function pruneOnnxRuntimeWeb(pkgDir, totals) {
  const docsDir = join(pkgDir, 'docs');
  const docsMeasure = await measurePath(docsDir);
  if (docsMeasure.files > 0) await removeTarget(docsDir, true, totals);

  const distDir = join(pkgDir, 'dist');
  for (const entry of await safeReaddir(distDir)) {
    if (!entry.isFile() || !ORT_WEB_BLOAT_RE.test(entry.name)) continue;
    await removeTarget(join(distDir, entry.name), false, totals);
  }
}

function isForeignPlatformPackage(scope, pkgName) {
  if (scope === '@lancedb' && pkgName.startsWith('lancedb-')) {
    return !pkgName.startsWith('lancedb-win32-x64');
  }
  if (scope === '@img' && pkgName.startsWith('sharp-')) {
    return !pkgName.includes('win32-x64');
  }
  return false;
}

async function pruneScopedDir(scopeDir, scopeName, totals) {
  for (const pkg of await safeReaddir(scopeDir)) {
    if (!pkg.isDirectory()) continue;
    const pkgDir = join(scopeDir, pkg.name);
    if (isForeignPlatformPackage(scopeName, pkg.name)) {
      await removeTarget(pkgDir, true, totals);
      continue;
    }
    await pruneNodeModulesTree(join(pkgDir, 'node_modules'), totals);
  }
}

async function pruneNodeModulesTree(nodeModulesDir, totals) {
  const entries = await safeReaddir(nodeModulesDir);
  if (entries.length === 0) return;

  for (const entry of entries) {
    const fullPath = join(nodeModulesDir, entry.name);
    if (entry.name === '.cache' && entry.isDirectory()) {
      await removeTarget(fullPath, true, totals);
      continue;
    }
    if (entry.name === '.package-lock.json' && entry.isFile()) {
      await removeTarget(fullPath, false, totals);
      continue;
    }
    if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) continue;

    if (entry.name.startsWith('@')) {
      await pruneScopedDir(fullPath, entry.name, totals);
      continue;
    }
    if (entry.name === 'onnxruntime-node') await pruneOnnxRuntimeNode(fullPath, totals);
    else if (entry.name === 'onnxruntime-web') await pruneOnnxRuntimeWeb(fullPath, totals);
    await pruneNodeModulesTree(join(fullPath, 'node_modules'), totals);
  }
}

/**
 * Remove non-win32-x64 native binaries and browser-only ONNX WASM/source-map bloat
 * from a staged `studyhub-retrieval` bundle while keeping all Windows x64 runtime deps intact.
 */
export async function pruneRetrievalBundle(bundleDir) {
  const totals = { removedDirs: 0, removedFiles: 0, removedBytes: 0 };
  const rootLock = join(bundleDir, 'package-lock.json');
  const lockInfo = await measurePath(rootLock);
  if (lockInfo.files > 0) await removeTarget(rootLock, false, totals);
  await pruneNodeModulesTree(join(bundleDir, 'node_modules'), totals);
  return totals;
}
