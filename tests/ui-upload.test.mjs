import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// #127 / #120: one base64 helper, one chunked-upload protocol (start, chunks, finish, cancel on failure), one set of
// path and file-name helpers.
const m = await loadUi(`export * from './ui/upload.js'; export * from './ui/paths.js'; export * from './ui/file-names.js';`);
const MB = 1024 * 1024;

const blobOf = (bytes) => ({ name: 'talk.mp3', size: bytes.length, slice: (from, to) => ({ arrayBuffer: async () => bytes.subarray(from, to) }) });
function host({ chunkBytes, fail } = {}) {
  const calls = [];
  const call = async (action, args) => {
    calls.push([action, args]);
    if (fail?.(action, calls)) throw new Error(`${action} failed`);
    return action.endsWith('.start') ? { uploadId: 'u1', ...(chunkBytes ? { chunkBytes } : {}) } : {};
  };
  return { call, calls, actions: () => calls.map(([action]) => action), chunks: () => calls.filter(([action]) => action.endsWith('.chunk')).map(([, args]) => args) };
}

test('toBase64 encodes a blob or a slice without FileReader', async () => {
  assert.equal(await m.toBase64({ arrayBuffer: async () => Buffer.from('hello world') }), Buffer.from('hello world').toString('base64'));
  assert.equal(await m.toBase64({ arrayBuffer: async () => new Uint8Array(0) }), '');
  const big = Buffer.alloc(100_000, 3);
  assert.equal(await m.toBase64({ arrayBuffer: async () => big }), big.toString('base64'), 'larger than one encoding step');
});

test('uploadInChunks goes start, chunks, finish under the given namespace and returns the upload id', async () => {
  const bytes = Buffer.alloc(5 * MB + 123, 7), api = host({ chunkBytes: 3 * MB }), progress = [], started = [];
  const id = await m.uploadInChunks(api.call, 'audio', blobOf(bytes), { onProgress: (fraction, sent) => progress.push([fraction, sent]), onStart: info => started.push(info.uploadId) });
  assert.equal(id, 'u1');
  assert.deepEqual(started, ['u1']);
  assert.deepEqual(api.actions(), ['audio.upload.start', 'audio.upload.chunk', 'audio.upload.chunk', 'audio.upload.chunk', 'audio.upload.finish']);
  assert.deepEqual(api.calls[0][1], { name: 'talk.mp3', size: bytes.length });
  assert.deepEqual(api.chunks().map(chunk => chunk.offset), [0, 2 * MB, 4 * MB], 'the default piece (2 MB) is the ceiling');
  assert.equal(Buffer.compare(Buffer.concat(api.chunks().map(chunk => Buffer.from(chunk.data, 'base64'))), bytes), 0, 'every byte arrives once, in order');
  assert.equal(progress.at(-1)[0], 1);
  assert.equal(progress.at(-1)[1], bytes.length);
  assert.ok(progress.every(([fraction], index) => index === 0 || fraction >= progress[index - 1][0]));
});

test('the host chunk size is honoured when it is smaller, and a larger ceiling can be asked for', async () => {
  const bytes = Buffer.alloc(3 * MB, 1);
  const small = host({ chunkBytes: MB });
  await m.uploadInChunks(small.call, 'audio', blobOf(bytes));
  assert.deepEqual(small.chunks().map(chunk => chunk.offset), [0, MB, 2 * MB], 'the host said 1 MB');
  const roomy = host({ chunkBytes: 8 * MB });
  await m.uploadInChunks(roomy.call, 'audio', blobOf(bytes), { maxChunkBytes: 3 * MB });
  assert.deepEqual(roomy.chunks().map(chunk => chunk.offset), [0], 'min(host, ceiling)');
  const silent = host();
  await m.uploadInChunks(silent.call, 'mineru', blobOf(bytes));
  assert.deepEqual(silent.chunks().map(chunk => chunk.offset), [0, 2 * MB], 'no host answer: the default piece');
});

test('a failure in the middle cancels the upload so nothing is left behind', async () => {
  const bytes = Buffer.alloc(5 * MB, 2);
  for (const failing of ['chunk', 'finish']) {
    let seen = 0;
    const api = host({ chunkBytes: 2 * MB, fail: action => (failing === 'chunk' ? action.endsWith('.chunk') && ++seen === 2 : action.endsWith('.finish')) });
    await assert.rejects(m.uploadInChunks(api.call, 'audio', blobOf(bytes)), new RegExp(`${failing} failed`));
    assert.equal(api.actions().at(-1), 'audio.upload.cancel');
    assert.equal(api.calls.at(-1)[1].uploadId, 'u1');
  }
  const refused = host({ fail: action => action.endsWith('.start') });
  await assert.rejects(m.uploadInChunks(refused.call, 'audio', blobOf(bytes)), /start failed/);
  assert.deepEqual(refused.actions(), ['audio.upload.start'], 'nothing to cancel before it started');
});

test('an AbortSignal stops between pieces, cancels the upload and rejects with the abort reason', async () => {
  const bytes = Buffer.alloc(6 * MB, 2), controller = new AbortController();
  const api = host({ chunkBytes: 2 * MB });
  const inner = api.call;
  const call = async (action, args) => { const answer = await inner(action, args); if (action.endsWith('.chunk') && args.offset === 2 * MB) controller.abort(new Error('stopped by the learner')); return answer; };
  await assert.rejects(m.uploadInChunks(call, 'audio', blobOf(bytes), { signal: controller.signal }), /stopped by the learner/);
  assert.equal(api.chunks().length, 2, 'no piece after the abort');
  assert.equal(api.actions().at(-1), 'audio.upload.cancel');
  assert.ok(!api.actions().includes('audio.upload.finish'));
  const early = new AbortController(); early.abort(new Error('before it began'));
  const idle = host();
  await assert.rejects(m.uploadInChunks(idle.call, 'audio', blobOf(bytes), { signal: early.signal }), /before it began/);
  assert.ok(!idle.actions().includes('audio.upload.finish'));
});

test('a failing cancel does not hide the original error', async () => {
  const api = host({ fail: (action) => action.endsWith('.chunk') || action.endsWith('.cancel') });
  await assert.rejects(m.uploadInChunks(api.call, 'audio', blobOf(Buffer.alloc(10, 1))), /chunk failed/);
});

test('isAbsolutePath knows drive, UNC and rooted paths', () => {
  for (const path of ['D:\\a\\b.pdf', 'D:/a/b.pdf', '/home/me/b.pdf', '\\\\server\\share\\b.pdf']) assert.equal(m.isAbsolutePath(path), true, path);
  for (const path of ['b.pdf', '..\\b.pdf', 'dir/b.pdf', '', undefined, null, 5]) assert.equal(m.isAbsolutePath(path), false, String(path));
});

test('unquotePath cleans a path as a person pastes it', () => {
  assert.equal(m.unquotePath('  "D:\\a b\\book.pdf" '), 'D:\\a b\\book.pdf');
  assert.equal(m.unquotePath('@D:\\a\\book.pdf'), 'D:\\a\\book.pdf');
  assert.equal(m.unquotePath('file:///D:/a%20b/book.pdf'), 'D:/a b/book.pdf');
  assert.equal(m.unquotePath('file:///home/me/book.pdf'), '/home/me/book.pdf');
  assert.equal(m.unquotePath('file:///bad%E0%A4%A'), '');
  assert.equal(m.unquotePath('book.pdf'), 'book.pdf');
  assert.equal(m.unquotePath(undefined), '');
});

test('extensionOf is the lower-case suffix with its dot, and empty without one', () => {
  assert.equal(m.extensionOf('Lecture.MP3'), '.mp3');
  assert.equal(m.extensionOf('a.b.flac'), '.flac');
  assert.equal(m.extensionOf('talk'), '', 'no dot: not the last letter');
  assert.equal(m.extensionOf('recording'), '');
  assert.equal(m.extensionOf('.hidden'), '.hidden');
  assert.equal(m.extensionOf('dir.d/file'), '', 'a dot in a folder name is not an extension');
  assert.equal(m.extensionOf('D:\\dir.d\\file'), '');
  assert.equal(m.extensionOf('trailing.'), '');
  assert.equal(m.extensionOf(''), '');
  assert.equal(m.extensionOf(undefined), '');
});

test('baseName is the last path segment of either kind', () => {
  assert.equal(m.baseName('D:\\a\\b\\book.pdf'), 'book.pdf');
  assert.equal(m.baseName('/home/me/book.pdf'), 'book.pdf');
  assert.equal(m.baseName('book.pdf'), 'book.pdf');
  assert.equal(m.baseName('dir/'), '');
  assert.equal(m.baseName(undefined), '');
});
