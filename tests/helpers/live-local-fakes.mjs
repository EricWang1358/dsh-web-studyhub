import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrityOf, makeTgz, sha256Hex } from './make-tgz.mjs';

/* Stand-ins for the local live engine's install (lib/live-local-install.js): tiny pinned files (two npm tarballs and three model files with their
   real-format integrity and sha256), a fetch that serves them from memory with Range support and can cut, corrupt, refuse or stall a download, and
   a DSH home under %TEMP%. Nothing goes to the network. */

export const FAKE_ENGINE_VERSION = '9.9.9-test';

/** `modelBytes`: the size of the stand-in model.int8.onnx (larger for the space tests). */
export function fakePins({ modelBytes = 300_000 } = {}) {
  const pkg = (name, extra = {}) => makeTgz({ 'package/package.json': JSON.stringify({ name, version: FAKE_ENGINE_VERSION, main: 'index.js' }), 'package/index.js': 'module.exports = {};', ...extra });
  const engine = pkg('sherpa-onnx-node'), native = pkg('sherpa-onnx-win-x64', { 'package/sherpa-onnx.node': Buffer.alloc(2048, 7), 'package/onnxruntime.dll': Buffer.alloc(4096, 5) });
  const model = { 'model.int8.onnx': Buffer.alloc(modelBytes, 1), 'tokens.txt': Buffer.from('<blk> 0\n'.repeat(500)), 'silero_vad.onnx': Buffer.alloc(20_000, 3) };
  const tar = (name, bytes) => ({ name, path: `${name}/-/${name}-${FAKE_ENGINE_VERSION}.tgz`, integrity: integrityOf(bytes), bytes: bytes.length, unpacked: bytes.length * 2 });
  const pins = {
    engineVersion: FAKE_ENGINE_VERSION,
    registries: ['https://mirror.test/', 'https://registry.test/'],
    engine: tar('sherpa-onnx-node', engine),
    platforms: { 'win32-x64': tar('sherpa-onnx-win-x64', native) },
    model: Object.entries(model).map(([name, bytes]) => ({ name, url: `https://models.test/${name}`, bytes: bytes.length, sha256: sha256Hex(bytes) })),
  };
  const files = new Map([
    ...pins.registries.flatMap(base => [[`${base}${pins.engine.path}`, engine], [`${base}${pins.platforms['win32-x64'].path}`, native]]),
    ...pins.model.map(pin => [pin.url, model[pin.name]]),
  ]);
  return { pins, files, model };
}

/**
 * fetch over `files` (url -> Buffer). `rules[url]`: { status, cutAfter (bytes, then the stream errors), corrupt (wrong bytes), stall (never ends
 * until aborted), oversize (that many extra bytes), failCode (after the first piece the stream errors with this code, e.g. ENOSPC) }. Every request is logged as { url, range }.
 */
export function fakeFetch(files) {
  const requests = [], rules = new Map();
  const fetch = async (url, { signal, headers = {} } = {}) => {
    signal?.throwIfAborted();
    const range = headers.range || headers.Range || '';
    requests.push({ url, range });
    const rule = rules.get(url) || {};
    const body = files.get(url);
    if (!body || rule.status) return new Response('missing', { status: rule.status || 404 });
    let bytes = rule.corrupt ? Buffer.from(body).fill(9, 0, 16) : rule.oversize ? Buffer.concat([body, Buffer.alloc(rule.oversize, 1)]) : body, status = 200;
    const from = /^bytes=(\d+)-$/.exec(range)?.[1];
    if (from !== undefined && !rule.noRange) {
      if (Number(from) >= bytes.length) return new Response(null, { status: 416 });
      bytes = bytes.subarray(Number(from)); status = 206;
    }
    // Pulled, not pushed: an error is raised only after the first piece was read (a stream's error drops what is still queued).
    let step = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        const half = rule.cutAfter ?? (rule.stall || rule.failCode ? Math.floor(bytes.length / 3) : bytes.length);
        if (step++ === 0) { controller.enqueue(new Uint8Array(bytes.subarray(0, half))); return; }
        if (rule.stall) {
          await new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
            signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
          }).catch(error => controller.error(error));
          return;
        }
        if (rule.failCode) { controller.error(Object.assign(new Error(`write failed: ${rule.failCode}`), { code: rule.failCode })); return; }
        if (rule.cutAfter !== undefined) { controller.error(new Error('socket hang up')); return; }
        controller.close();
      },
    });
    return new Response(stream, { status, headers: { 'content-length': String(bytes.length) } });
  };
  return { fetch, requests, rules };
}

/** A DSH home and an install location under %TEMP%, removed afterwards; DSH_HOME points at the home while the test runs. */
export async function liveLocalHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-local-install-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, home: process.env.DSH_HOME, location: join(dir, 'D', 'StudyHub', 'LiveLocal') };
}
