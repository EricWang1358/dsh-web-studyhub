/* A book converted from a file the learner pointed at (a path) gets that file as its original, BY REFERENCE, when the conversion finishes: no copy and no size
   limit, the file checked to be the very one that was converted. A book converted from an upload (a browser file has no place of its own) keeps today's behaviour.
   The conversion history remembers the path for the one-click offer, and the list the panel reads never shows it. The local mineru is a fake CLI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { historyDir } from '../lib/mineru-history.js';
import { makePdf } from './helpers/pdf.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
import { patientCli } from './helpers/wait.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));

async function harness(t, { hold = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-obp-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-obp-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-obp-fake-'));
  const books = await mkdtemp(join(tmpdir(), 'study-obp-books-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl'), signal = join(work, 'release');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 3, totalFromPdf: true, modelsReady: true,
    ...(hold ? { finishSignal: signal } : {}) })); await writeFile(logPath, '');
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const options = { mineru: { limits: { windowPages: 50, livenessMs: 0 }, local: { cli, home: work } } };
  const service = new StudyService(root, { ...options, ...switchOptions(SWITCH_MODE, { paths: ['pdfConvert'] }) });
  const h = {
    root, books, service,
    call: (action, args) => service.call(action, args),
    release: () => writeFile(signal, ''),
    until: async (condition, what) => { for (let i = 0; i < 1500; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Timed out waiting for ${what}`); },
    upload: async (bytes, name = 'Book.pdf') => {
      const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name, size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await service.call('mineru.upload.finish', { uploadId });
      return uploadId;
    },
    finished: async () => {
      const job = await h.until(async () => (await service.call('snapshot')).jobs.find(entry => entry.type === 'pdf-convert' && entry.status === 'complete'), 'a complete conversion');
      await service.call('job.wait', { jobId: job.id, timeoutSeconds: 10 });
      return job;
    },
    original: async () => {
      const [record] = (await service.call('mineru.history.list', {})).records;
      return service.call('materials.document.get', { documentId: record.documentId });
    },
  };
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work, books]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return h;
}

test('a book converted from a path gets that file as its original, by reference', async t => {
  const h = await harness(t);
  const file = join(h.books, 'Textbook.pdf');
  await writeFile(file, await makePdf({ pages: 3 }));
  await h.call('mineru.import', { path: file });
  await h.finished();
  const document = await h.original();
  assert.equal(document.original.mode, 'reference');
  assert.equal(document.original.status, 'ok');
  assert.equal(document.original.path, file);
  assert.equal(document.originalAvailable, true, 'a file within the reader limit is opened by the reader as any original');
  assert.equal(document.original.bytes, (await readFile(file)).length);
  assert.deepEqual(await readdir(join(h.root, 'attachments')).catch(() => []), [], 'nothing was copied into the library');
});

test('a book converted from an upload keeps today\'s behaviour: no original, and the history has no path', async t => {
  const h = await harness(t);
  await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 }), 'Upload.pdf') });
  await h.finished();
  const document = await h.original();
  assert.equal(document.original.mode, null);
  assert.equal(document.originalAvailable, false);
  const [file] = await readdir(historyDir(h.root));
  const record = JSON.parse(await readFile(join(historyDir(h.root), file), 'utf8'));
  assert.equal(record.sourcePath, undefined);
});

test('the history remembers the path and the hash of the file, and the list the panel reads shows neither', async t => {
  const h = await harness(t);
  const file = join(h.books, 'Textbook.pdf');
  await writeFile(file, await makePdf({ pages: 3 }));
  await h.call('mineru.import', { path: file });
  await h.finished();
  const [name] = await readdir(historyDir(h.root));
  const stored = JSON.parse(await readFile(join(historyDir(h.root), name), 'utf8'));
  assert.equal(stored.sourcePath, file);
  assert.match(stored.sourceHash, /^[a-f0-9]{64}$/);
  const listed = JSON.stringify(await h.call('mineru.history.list', {}));
  assert.ok(!listed.includes(h.books) && !listed.includes(stored.sourceHash), 'the learner\'s folder is not in the list');
});

test('a file that moved away before the end is not made the original; the book is saved all the same, with a plain warning', async t => {
  const h = await harness(t, { hold: true });
  const file = join(h.books, 'Textbook.pdf');
  await writeFile(file, await makePdf({ pages: 3 }));
  await h.call('mineru.import', { path: file });
  await unlink(file);
  await h.release();
  const job = await h.finished();
  const document = await h.original();
  assert.equal(document.original.mode, null);
  assert.ok(document.sourceIds.length > 0, 'the text was imported');
  const listed = (await h.call('snapshot')).jobs.find(entry => entry.id === job.id);
  assert.ok(listed.warnings.some(text => text.includes('补全原文件')), 'the learner is told what to do');
});
