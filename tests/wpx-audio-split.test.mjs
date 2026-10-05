import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createAudioUploader } from '../ui/audio/audio-upload.js';

// WP-X (#131 #120 #127): AudioImport.jsx is the form only; the upload pipeline, the pre-flight, the job cards and the
// correction list live in ui/audio. The upload controller runs here without a DOM.
const MB = 1024 * 1024;
const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const fakeFile = (name, size) => Object.assign(new Blob([new Uint8Array(size)]), { name });
function host({ chunkBytes = 8 * MB, failChunk = -1, blockAt = -1 } = {}) {
  const calls = [];
  let seen = 0, release;
  const call = async (action, args) => {
    calls.push([action, args]);
    if (action === 'audio.upload.start') return { uploadId: `u${calls.filter(([name]) => name === 'audio.upload.start').length}`, chunkBytes };
    if (action === 'audio.upload.chunk') {
      const index = seen++;
      if (index === failChunk) throw new Error('boom');
      if (index === blockAt) await new Promise((resolve) => { release = resolve; });
    }
    return {};
  };
  return { call, calls, release: () => release?.(), names: () => calls.map(([name]) => name) };
}

test('uploads each file in pieces of at most 3 MB through the shared protocol and hands over the finished upload', async () => {
  const fake = host();
  const finished = [], seen = [];
  const uploader = createAudioUploader({ call: fake.call, onFile: (file) => finished.push(file) });
  uploader.subscribe(() => seen.push(uploader.getState().upload?.sent ?? null));
  assert.equal(await uploader.sendFiles([fakeFile('a.mp3', 7 * MB), fakeFile('b.wav', 1 * MB)]), true);
  assert.deepEqual(fake.names(), ['audio.upload.start', 'audio.upload.chunk', 'audio.upload.chunk', 'audio.upload.chunk', 'audio.upload.finish',
    'audio.upload.start', 'audio.upload.chunk', 'audio.upload.finish']);
  assert.deepEqual(fake.calls.filter(([name]) => name === 'audio.upload.chunk').map(([, args]) => args.offset), [0, 3 * MB, 6 * MB, 0]);
  assert.deepEqual(finished, [{ kind: 'upload', uploadId: 'u1', name: 'a.mp3', size: 7 * MB }, { kind: 'upload', uploadId: 'u2', name: 'b.wav', size: 1 * MB }]);
  assert.ok(seen.includes(3 * MB) && seen.includes(7 * MB), 'progress is reported in bytes sent');
  assert.equal(uploader.getState().upload, null, 'the progress row goes away when everything is up');
  assert.deepEqual([...uploader.pendingIds()].sort(), ['u1', 'u2'], 'uploads stay owned by the form until it submits them');
});

test('the host\'s own piece size wins when it is smaller (#127)', async () => {
  const fake = host({ chunkBytes: 1 * MB });
  const uploader = createAudioUploader({ call: fake.call, onFile() {} });
  await uploader.sendFiles([fakeFile('a.mp3', 2.5 * MB)]);
  assert.deepEqual(fake.calls.filter(([name]) => name === 'audio.upload.chunk').map(([, args]) => args.offset), [0, 1 * MB, 2 * MB]);
});

test('claim() hands uploads to a submitted import; dispose() drops the rest on the host', async () => {
  const fake = host();
  const uploader = createAudioUploader({ call: fake.call, onFile() {} });
  await uploader.sendFiles([fakeFile('a.mp3', MB), fakeFile('b.mp3', MB)]);
  uploader.claim(['u1']);
  assert.deepEqual([...uploader.pendingIds()], ['u2']);
  uploader.dispose();
  await settle();
  assert.deepEqual(fake.calls.filter(([name]) => name === 'audio.upload.cancel').map(([, args]) => args.uploadId), ['u2'], 'only the unsubmitted upload is dropped');
  assert.deepEqual([...uploader.pendingIds()], []);
});

test('release() removes one upload from the form and drops it on the host', async () => {
  const fake = host();
  const uploader = createAudioUploader({ call: fake.call, onFile() {} });
  await uploader.sendFiles([fakeFile('a.mp3', MB)]);
  uploader.release('u1');
  await settle();
  assert.deepEqual(fake.calls.filter(([name]) => name === 'audio.upload.cancel').map(([, args]) => args.uploadId), ['u1']);
  assert.deepEqual([...uploader.pendingIds()], []);
});

test('a failed piece cancels the upload on the host, forgets it and shows the error with a way to dismiss', async () => {
  const fake = host({ failChunk: 1 });
  const finished = [];
  const uploader = createAudioUploader({ call: fake.call, onFile: (file) => finished.push(file) });
  await uploader.sendFiles([fakeFile('a.mp3', 7 * MB)]);
  assert.deepEqual(finished, []);
  assert.deepEqual(fake.calls.filter(([name]) => name === 'audio.upload.cancel').map(([, args]) => args.uploadId), ['u1'], 'cancelled exactly once');
  assert.deepEqual([...uploader.pendingIds()], []);
  assert.deepEqual(uploader.getState().upload, { name: 'a.mp3', size: 7 * MB, sent: 0, error: 'boom' });
  uploader.dismiss();
  assert.equal(uploader.getState().upload, null);
  assert.equal(await uploader.sendFiles([fakeFile('c.mp3', MB)]), true, 'the form can upload again');
});

test('cancelling mid-upload stops the transfer without an error and the file never reaches the list', async () => {
  const fake = host({ blockAt: 0 });
  const finished = [];
  const uploader = createAudioUploader({ call: fake.call, onFile: (file) => finished.push(file) });
  const sending = uploader.sendFiles([fakeFile('a.mp3', 7 * MB)]);
  await settle();
  assert.equal(uploader.isBusy(), true);
  assert.equal(await uploader.sendFiles([fakeFile('b.mp3', MB)]), false, 'one upload at a time');
  uploader.cancel();
  fake.release();
  await sending;
  assert.deepEqual(finished, []);
  assert.equal(uploader.getState().upload, null, 'a cancel is not an error');
  assert.equal(fake.names().filter((name) => name === 'audio.upload.chunk').length, 1, 'no piece after the cancel');
  assert.deepEqual(fake.calls.filter(([name]) => name === 'audio.upload.cancel').map(([, args]) => args.uploadId), ['u1']);
  assert.equal(uploader.isBusy(), false);
});

test('run() gives other work (reading a subtitle file) the same one-at-a-time rule and cancellation flag', async () => {
  const uploader = createAudioUploader({ call: async () => ({}), onFile() {} });
  let release, flagSeenInside;
  const first = uploader.run(async (cancelled) => { await new Promise((resolve) => { release = resolve; }); flagSeenInside = cancelled(); });
  await settle();
  assert.equal(await uploader.run(async () => {}), false);
  uploader.cancel();
  release();
  assert.equal(await first, true);
  assert.equal(flagSeenInside, true);
  assert.equal(await uploader.run(async (cancelled) => { flagSeenInside = cancelled(); }), true);
  assert.equal(flagSeenInside, false, 'a new task starts un-cancelled');
});

/* ---------- the bundled modules (they import the translated copy) ---------- */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/audio/formats.js'; export * from './ui/audio/preflight.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.json': 'json', '.css': 'text' }, logLevel: 'silent' });
const bundle = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, bundle, bundle.exports);
const audio = bundle.exports;

test('the supported formats are listed once, from the shared lib constants, and the limits are written from them (#120 #127)', () => {
  audio.setUiLanguage('zh');
  assert.deepEqual(audio.audioFormatNames(), ['MP3', 'WAV', 'M4A', 'AAC', 'OGG', 'FLAC', 'OPUS', 'WEBM', 'AIFF'], 'one name per format, the long spelling');
  assert.equal(audio.audioFileProblem('lecture.mp3', 1024), '');
  assert.equal(audio.audioFileProblem('lecture.mp3', 0), '文件是空的。');
  assert.match(audio.audioFileProblem('notes.pdf', 10), /这不是支持的音频文件。支持 MP3 · WAV · M4A/);
  assert.equal(audio.audioFileProblem('lecture', 10).startsWith('这不是支持的音频文件'), true, 'a name without a dot has no extension (it is not its last letter)');
  assert.equal(audio.audioFileProblem('big.flac', 512 * MB + 1), '文件超过 512 MB，请先压缩成 MP3 或按章节拆分。');
  assert.equal(audio.audioFileProblem('big.flac', 512 * MB), '');
  assert.equal(audio.subtitleProblem(8 * MB + 1), '字幕文件超过 8 MB。');
  assert.equal(audio.subtitleProblem(8 * MB), '');
  audio.setUiLanguage('en');
  try {
    assert.equal(audio.audioFileProblem('big.flac', 600 * MB), 'The file is over 512 MB; compress it to MP3 or split it by chapter first.');
    assert.equal(audio.subtitleProblem(9 * MB), 'The subtitle file exceeds 8 MB.');
  } finally { audio.setUiLanguage('zh'); }
});

test('a name is a subtitle or an audio file by its extension, and a dropped text path must be an absolute audio path', () => {
  assert.equal(audio.isSubtitleName('Week 1.SRT'), true);
  assert.equal(audio.isSubtitleName('notes'), false);
  assert.equal(audio.droppedPath('"C:\\Users\\me\\a.mp3"\nsecond'), 'C:\\Users\\me\\a.mp3');
  assert.equal(audio.droppedPath('file:///C:/Users/me/b.wav'), 'C:/Users/me/b.wav');
  assert.equal(audio.droppedPath('relative/a.mp3'), '');
  assert.equal(audio.droppedPath('/home/me/a.txt'), '');
});

test('pre-flight: the chosen files are sent as paths or uploads, and the result is split back per file', async () => {
  const sent = [];
  const call = async (action, args) => {
    sent.push([action, args]);
    return { transcription: true, text: true, files: [{ seconds: 600, requests: 1 }, { blocked: true, issue: { message: '读不了' } }] };
  };
  const list = [{ key: 'k1', kind: 'upload', uploadId: 'u1' }, { key: 'k2', kind: 'path', path: '/a/b.mp3' }];
  const { checks, status } = await audio.checkFiles(call, list, { paidOnly: true });
  assert.deepEqual(sent, [['audio.preflight', { files: [{ uploadId: 'u1' }, { path: '/a/b.mp3' }], paidOnly: true }]]);
  assert.deepEqual(Object.keys(checks), ['k1', 'k2']);
  assert.equal(checks.k2.blocked, true);
  assert.deepEqual(status, { transcription: true, text: true }, 'readiness is the answer without the per-file part');
  assert.deepEqual(await audio.checkFiles(async () => ({ transcription: false }), list), { checks: null, status: { transcription: false } }, 'an answer without a files list keeps the earlier checks');
});

test('pre-flight notes keep their wording: a long recording offers a lossless split, a blocked file says why, the rest say whom they wait for', () => {
  audio.setUiLanguage('zh');
  const files = [{ key: 'a', name: 'A.mp3' }, { key: 'b', name: 'B.mp3' }];
  const split = audio.preflightNotes(files, { a: { issue: { code: 'long-split', minutes: 90, parts: 2, requests: 2, partMinutes: 45 } }, b: { seconds: 600, requests: 1 } });
  assert.equal(split.a.kind, 'split');
  assert.equal(split.b.kind, 'waiting');
  assert.equal(audio.preflightNotes(files, { a: { blocked: true, issue: { message: 'x' } }, b: { seconds: 60 } }).b.kind, 'held');
});

/* ---------- the shape of the split ---------- */

test('AudioImport.jsx is the form: 350 lines at most, and the jobs and corrections come from ui/audio (#131)', async () => {
  const page = await read('ui/AudioImport.jsx');
  assert.ok(page.split('\n').length <= 350, `AudioImport.jsx has ${page.split('\n').length} lines`);
  for (const [file, pattern] of [['ui/audio/AudioJobs.jsx', /export function AudioJobs\b/], ['ui/audio/AudioCorrections.jsx', /export default function AudioCorrections|export function AudioCorrections/],
    ['ui/audio/useAudioUpload.js', /export function useAudioUpload/], ['ui/audio/useAudioPreflight.js', /export function useAudioPreflight/],
    ['ui/audio/audio-upload.js', /export function createAudioUploader/]]) assert.match(await read(file), pattern, file);
  assert.doesNotMatch(page, /^export \{/m, 'the page has no re-exports: Sources and the reader import ui/audio/* directly (#124)');
  for (const file of ['ui/Sources.jsx', 'ui/document-preview/DocumentViewer.jsx']) assert.doesNotMatch(await read(file), /AudioImport\.jsx/, file);
  assert.match(page, /preflightNotes/);
  assert.match(page, /useAudioUpload\(/);
  assert.match(page, /useAudioPreflight\(/);
  assert.doesNotMatch(page, /function (AudioJob|AudioTasks|AudioCorrections|memberState)\b/, 'those moved out');
});

test('the audio form and its modules keep no private copy of the limits, the extension lists or the glyph icons (#120 #127 #145 #135)', async () => {
  for (const file of ['ui/AudioImport.jsx', 'ui/audio/AudioJobs.jsx', 'ui/audio/AudioCorrections.jsx', 'ui/audio/AudioWorkspace.jsx', 'ui/audio/formats.js', 'ui/audio/preflight.js',
    'ui/audio/useAudioPreflight.js', 'ui/audio/useAudioUpload.js', 'ui/audio/audio-upload.js']) {
    const source = (await read(file)).replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
    // The one byte count left is the piece cap of the upload protocol (the host's UPLOAD_CHUNK_BYTES), in audio-upload.js.
    assert.doesNotMatch(source, file === 'ui/audio/audio-upload.js' ? /\b512 MB|\b8 MB/ : /\b512 MB|\b8 MB|1024 \* 1024/, `${file}: sizes come from lib/audio-formats and formatBytes`);
    assert.doesNotMatch(source, /['"]\.(flac|mp3|wav|m4a|srt|vtt)['"]/, `${file}: no extension literal`);
    assert.doesNotMatch(source, /(const|function) extensionOf|lastIndexOf\(["']\./, `${file}: extensionOf is ui/file-names.js`);
    assert.doesNotMatch(source, />\s*[♫↑↓]\s*</, `${file}: Icon, not a text glyph`);
    assert.doesNotMatch(source, /\{\s*files\.length > 1 \? index \+ 1 : ['"]♫['"]/);
    assert.doesNotMatch(source, /className="[^"]*\b(primary|link-btn|ghost-btn|pill)\b/, `${file}: Button variants, not legacy classes`);
  }
  const page = await read('ui/AudioImport.jsx');
  assert.doesNotMatch(page, /<button\b/, 'the form uses Button / IconButton');
});
