import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_BUNDLE_FILES,
  formatChecksumsFile,
  packRetrievalBundle,
  pruneRetrievalBundle,
  retrievalAssetName,
  retrievalChecksumsName,
  verifyPackedRetrieval,
} from '../packages/studyhub-desktop/scripts/pack-retrieval.mjs';
import { stageRuntime } from '../packages/studyhub-desktop/scripts/stage-runtime.mjs';
import { extractZipFile, listZipEntries, resolveSafeZipTarget } from '../packages/studyhub-desktop/scripts/zip-extract.mjs';
import { sha256File, writeZipFile } from '../packages/studyhub-desktop/scripts/zip-stream.mjs';
import { retrievalReleaseUrls } from '../packages/studyhub-desktop/domain/retrieval-policy.js';
import { extractZipArchive } from '../packages/studyhub-desktop/adapters/retrieval/zip-extract.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const exists = (target) => access(target).then(() => true, () => false);

async function writeFixture(root, relPath, content = 'x') {
  const full = join(root, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  return full;
}

test('retrieval asset and checksums naming follows the shared desktop contract', () => {
  const version = '4.15.1';
  const asset = retrievalAssetName(version);
  const sums = retrievalChecksumsName(version);
  assert.equal(asset, 'StudyHub-Desktop-Retrieval-4.15.1-win-x64.zip');
  assert.equal(sums, 'SHA256SUMS-Desktop-Retrieval-4.15.1.txt');
  const hash = 'A'.repeat(64);
  assert.equal(formatChecksumsFile(asset, hash), `${'a'.repeat(64)}  ${asset}\n`);
});

test('pruneRetrievalBundle removes foreign native binaries and browser WASM bloat while preserving win32-x64 deps', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-prune-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Foreign binaries (should be removed)
  const shouldRemove = [
    'package-lock.json',
    'node_modules/.package-lock.json',
    'node_modules/.cache/tmp.bin',
    'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnx.dylib',
    'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnx.so',
    'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime.dll',
    'node_modules/mcp-local-rag/node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/libonnx.so',
    'node_modules/@lancedb/lancedb-darwin-arm64/lancedb.node',
    'node_modules/@lancedb/lancedb-linux-x64-gnu/lancedb.node',
    'node_modules/@img/sharp-darwin-arm64/sharp.node',
    'node_modules/@img/sharp-linux-x64/sharp.node',
    'node_modules/onnxruntime-web/docs/readme.md',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
    'node_modules/onnxruntime-web/dist/ort.all.js',
    'node_modules/onnxruntime-web/dist/ort.webgl.mjs',
    'node_modules/onnxruntime-web/dist/ort.webgpu.js',
    'node_modules/onnxruntime-web/dist/ort.jspi.mjs',
    'node_modules/onnxruntime-web/dist/ort.min.js.map',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  ];

  // Required Windows x64 runtime files (must remain)
  const shouldKeep = [
    'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
    'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
    'node_modules/mcp-local-rag/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/DirectML.dll',
    'node_modules/@lancedb/lancedb/dist/index.js',
    'node_modules/@lancedb/lancedb-win32-x64-msvc/lancedb.win32-x64-msvc.node',
    'node_modules/@img/colour/index.js',
    'node_modules/@img/sharp-win32-x64/sharp.node',
    'node_modules/onnxruntime-web/package.json',
    'node_modules/onnxruntime-web/dist/ort.min.js',
    'node_modules/onnxruntime-web/dist/ort.node.min.mjs',
  ];

  for (const rel of [...shouldRemove, ...shouldKeep]) {
    await writeFixture(dir, rel, Buffer.alloc(128, 0x41));
  }

  const stats = await pruneRetrievalBundle(dir);
  assert.ok(stats.removedFiles >= shouldRemove.length);
  assert.ok(stats.removedBytes >= shouldRemove.length * 128);

  for (const rel of shouldRemove) {
    assert.equal(await exists(join(dir, rel)), false, `expected pruned: ${rel}`);
  }
  for (const rel of shouldKeep) {
    assert.equal(await exists(join(dir, rel)), true, `expected kept: ${rel}`);
  }
});

test('packRetrievalBundle stamps version, prunes bloat, streams large files, and writes verified SHA256SUMS', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-pack-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const sourceDir = join(work, 'src-retrieval');
  const outdir = join(work, 'release');
  const largePayload = Buffer.alloc(96 * 1024, 0x5a);

  await writeFixture(sourceDir, 'package.json', JSON.stringify({
    name: '@ericwang1358/studyhub-retrieval',
    version: '4.11.0',
    type: 'module',
  }, null, 2));
  for (const file of REQUIRED_BUNDLE_FILES.filter((f) => f !== 'package.json')) {
    await writeFixture(sourceDir, file, `// ${file}\n`);
  }
  await writeFixture(sourceDir, 'locale/zh.json', '{"title":"检索扩展"}\n');
  await writeFixture(sourceDir, 'node_modules/mcp-local-rag/dist/index.js', 'export const ok = true;\n');
  await writeFixture(sourceDir, 'node_modules/@lancedb/lancedb-win32-x64-msvc/native.node', largePayload);
  await writeFixture(sourceDir, 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/lib.dylib', Buffer.alloc(2048, 0x33));

  const packed = await packRetrievalBundle({
    outdir,
    sourceDir,
    version: '4.99.0',
    skipInstall: true,
    prune: true,
    verify: true,
    runMcpSmoke: false,
  });

  assert.equal(packed.assetName, 'StudyHub-Desktop-Retrieval-4.99.0-win-x64.zip');
  assert.equal(packed.checksumsName, 'SHA256SUMS-Desktop-Retrieval-4.99.0.txt');
  assert.equal(packed.verified?.ok, true);
  assert.ok(packed.pruned.removedBytes >= 2048);

  // Source package.json must remain untouched
  const srcPkg = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8'));
  assert.equal(srcPkg.version, '4.11.0');

  // Checksums line matches exact disk bytes
  const sumsBody = await readFile(packed.checksumsPath, 'utf8');
  const expectedHash = createHash('sha256').update(await readFile(packed.zipPath)).digest('hex');
  assert.equal(sumsBody, `${expectedHash}  StudyHub-Desktop-Retrieval-4.99.0-win-x64.zip\n`);

  // Verify flat top-level layout and pruned foreign binary absence
  const entries = await listZipEntries(packed.zipPath);
  const names = new Set(entries.map((e) => e.name));
  for (const required of REQUIRED_BUNDLE_FILES) {
    assert.ok(names.has(required), `ZIP must contain top-level ${required}`);
  }
  assert.ok(names.has('LICENSE'));
  assert.ok(names.has('node_modules/@lancedb/lancedb-win32-x64-msvc/native.node'));
  assert.ok(!names.has('node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/lib.dylib'));

  // Extract and verify large streamed binary and stamped version
  const extractDir = join(work, 'extracted');
  await extractZipFile(packed.zipPath, extractDir);
  const extractedPkg = JSON.parse(await readFile(join(extractDir, 'package.json'), 'utf8'));
  assert.equal(extractedPkg.version, '4.99.0');
  const extractedLarge = await readFile(join(extractDir, 'node_modules/@lancedb/lancedb-win32-x64-msvc/native.node'));
  assert.deepEqual(extractedLarge, largePayload);

  // Tampering fails SHA-256 verification
  const tampered = Buffer.from(await readFile(packed.zipPath));
  tampered[tampered.length - 1] ^= 0xff;
  await writeFile(packed.zipPath, tampered);
  await assert.rejects(
    () => verifyPackedRetrieval({
      zipPath: packed.zipPath,
      checksumsPath: packed.checksumsPath,
      expectedVersion: '4.99.0',
      runMcpSmoke: false,
    }),
    /SHA-256 mismatch/
  );
});

test('zip-stream and zip-extract round-trip ZIP64 archives and block Zip-Slip paths', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'studyhub-zip64-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const bigFile = await writeFixture(work, 'big.bin', Buffer.alloc(80 * 1024, 0x6b));
  const zipPath = join(work, 'archive64.zip');
  await writeZipFile(zipPath, [
    { name: 'small.txt', data: 'hello zip64' },
    { name: 'empty.txt', data: '' },
    { name: 'nested/big.bin', filePath: bigFile },
  ], { forceZip64: true });

  const digest = await sha256File(zipPath);
  assert.match(digest, /^[0-9a-f]{64}$/);

  const outDir = join(work, 'out');
  const extracted = await extractZipFile(zipPath, outDir);
  assert.equal(extracted.length, 3);
  assert.equal(await readFile(join(outDir, 'small.txt'), 'utf8'), 'hello zip64');
  assert.equal(await readFile(join(outDir, 'empty.txt'), 'utf8'), '');
  assert.equal((await readFile(join(outDir, 'nested/big.bin'))).length, 80 * 1024);

  // Verify runtime's installer zip extractor also reads our ZIP64 archive identically
  const runtimeOutDir = join(work, 'runtime-out');
  const runtimeRes = await extractZipArchive(await readFile(zipPath), runtimeOutDir);
  assert.equal(runtimeRes.fileCount, 3);
  assert.equal(await readFile(join(runtimeOutDir, 'small.txt'), 'utf8'), 'hello zip64');
  assert.equal((await readFile(join(runtimeOutDir, 'nested/big.bin'))).length, 80 * 1024);

  for (const unsafe of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/win.ini', 'a\\b.txt', 'bad\0name']) {
    assert.throws(() => resolveSafeZipTarget(outDir, unsafe), /ZIP entry/);
  }
});

test('release-desktop.yml, desktop package.json, and stage-runtime.mjs align with the retrieval asset contract', async (t) => {
  const workflow = await readFile(join(REPO_ROOT, '.github/workflows/release-desktop.yml'), 'utf8');
  const rootPkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(await readFile(join(REPO_ROOT, 'packages/studyhub-desktop/package.json'), 'utf8'));

  assert.equal(desktopPkg.version, rootPkg.version);
  assert.equal(desktopPkg.scripts['pack:retrieval'], 'node scripts/pack-retrieval.mjs');

  assert.match(workflow, /tests\/desktop-retrieval\.test\.mjs/);
  assert.match(workflow, /tests\/desktop-retrieval-ui\.test\.mjs/);
  assert.match(workflow, /tests\/desktop-retrieval-pack\.test\.mjs/);
  assert.match(workflow, /npm --prefix packages\/studyhub-desktop run pack:retrieval -- --verify/);

  const assetName = retrievalAssetName(rootPkg.version);
  const sumsName = retrievalChecksumsName(rootPkg.version);
  const urls = retrievalReleaseUrls(rootPkg.version, 'https://example.invalid/releases/download/');
  assert.equal(urls.name, assetName);
  assert.equal(urls.checksumsName, sumsName);
  assert.match(assetName, /^StudyHub-Desktop-Retrieval-.*-win-x64\.zip$/);
  assert.match(sumsName, /^SHA256SUMS-Desktop-Retrieval-.*\.txt$/);
  assert.match(workflow, /StudyHub-Desktop-Retrieval-\.\*-win-x64\\\.zip/);
  assert.match(workflow, /SHA256SUMS-Desktop-Retrieval-\.\*\\\.txt/);

  // Stage runtime into a temp dir and verify retrieval helpers & proper-lockfile are staged
  const stagedDir = await mkdtemp(join(tmpdir(), 'studyhub-stage-check-'));
  t.after(() => rm(stagedDir, { recursive: true, force: true }));
  const manifest = await stageRuntime({ outdir: stagedDir });
  assert.deepEqual(manifest.retrievalHelpers, ['heal.js', 'check-index.mjs']);
  assert.equal(await exists(join(stagedDir, 'packages/studyhub-retrieval/heal.js')), true);
  assert.equal(await exists(join(stagedDir, 'packages/studyhub-retrieval/check-index.mjs')), true);
  assert.equal(await exists(join(stagedDir, 'node_modules/proper-lockfile/package.json')), true);
});
