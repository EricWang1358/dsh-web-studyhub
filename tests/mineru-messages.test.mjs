import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localizeAppMessage } from '../lib/application-messages.js';
import { INBOX_KINDS } from '../lib/inbox.js';
import { MINERU_MESSAGES, mapMineruFailure } from '../lib/mineru-api.js';
import { JOB_TEXT, convertHome, jobDir, planFile } from '../lib/mineru-job.js';
import { MineruResultError, mergeChunkResults, readResultZip } from '../lib/mineru-merge.js';
import { NO_MINERU_ACK, NO_MINERU_TOKEN, saveMineruSettings } from '../lib/mineru-settings.js';
import { PdfChunkError, inspectPdf, splitPdf } from '../lib/pdf-chunker.js';
import { NO_MATERIALS, stageText } from '../lib/contexts/audio/convert.js';
import { makeEncryptedPdf, makePdf } from './helpers/pdf.mjs';

/* Cloud PDF conversion: every sentence a learner can see from the server side has an English form, with its numbers kept. */

const han = /[㐀-鿿]/;
const english = text => localizeAppMessage(text, 'en');

async function collected() {
  const found = [];
  const note = async run => { try { await run(); } catch (error) { found.push(error.message); } };
  const home = await mkdtemp(join(tmpdir(), 'mineru-msg-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    found.push(NO_MINERU_TOKEN, NO_MINERU_ACK, NO_MATERIALS, ...Object.values(JOB_TEXT));
    await note(() => saveMineruSettings({ token: 'short token' }));
    await note(() => saveMineruSettings({ acknowledge: 'yes' }));
    await note(() => saveMineruSettings(null));
    await note(() => jobDir('x', 'bad id'));
    for (const failure of [{ code: 'A0202' }, { code: 'A0211' }, { code: -60005 }, { code: -60006 }, { code: -60012 }, { code: -60015 }, { httpStatus: 429 }, { httpStatus: 503 },
      { code: -10002, msg: 'something new' }, { code: -10002 }]) found.push(mapMineruFailure(failure).message);
    found.push(...Object.values(MINERU_MESSAGES));
    await note(() => inspectPdf(Buffer.from('not a pdf')));
    await note(() => inspectPdf(Buffer.from('%PDF-1.7\n' + 'garbage '.repeat(60))));
    await note(async () => inspectPdf(await makeEncryptedPdf()));
    await note(async () => splitPdf({ bytes: await makePdf({ pages: 3, padBytes: 30000 }), maxBytes: 10_000, writeChunk: async () => {} }));
    await note(() => readResultZip(Buffer.from('nope')));
    await note(async () => readResultZip((await import('./helpers/zip.mjs')).zipStored({ 'a.md': 'x' })));
    await note(async () => readResultZip((await import('./helpers/zip.mjs')).zipStored({ 'a_content_list.json': '{x' })));
    const chunk = (index, startPage, endPage, content, format = 'v1') => ({ index, startPage, endPage, format, content });
    await note(() => mergeChunkResults({ totalPages: 450, chunks: [chunk(0, 1, 200, []), chunk(2, 401, 450, [])] }));
    await note(() => mergeChunkResults({ totalPages: 10, chunks: [chunk(0, 1, 5, [])] }));
    await note(() => mergeChunkResults({ totalPages: 4, chunks: [chunk(0, 1, 3, []), chunk(1, 3, 4, [])] }));
    await note(() => mergeChunkResults({ totalPages: 2, chunks: [chunk(0, 1, 1, [], 'v1'), chunk(1, 2, 2, [[]], 'v2')] }));
    await note(() => mergeChunkResults({ totalPages: 2, chunks: [chunk(0, 1, 1, [{ type: 'text', text: 'x', page_idx: 5 }]), chunk(1, 2, 2, [])] }));
    await note(() => mergeChunkResults({ totalPages: 3, chunks: [chunk(0, 1, 5, [])] }));
    await note(async () => { const file = join(home, 'empty.pdf'); await writeFile(file, await makePdf({ pages: 1 })); await planFile({ source: join(home, 'missing.pdf') }); });
    void convertHome;
  } finally { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); }
  return found.filter(text => typeof text === 'string' && han.test(text));
}

test('every message a learner can see from cloud conversion has an English form', async () => {
  const messages = await collected();
  assert.ok(messages.length >= 25, `collected ${messages.length} messages`);
  for (const message of messages) assert.doesNotMatch(english(message), han, message);
});

test('job stages, with the piece they are on, translate and keep their numbers', () => {
  assert.equal(english(stageText('upload', { index: 2, count: 3 })), 'Piece 2/3 · uploading');
  assert.equal(english(stageText('parse', { index: 2, count: 3 })), 'Piece 2/3 · converting');
  assert.equal(english(stageText('download', { index: 3, count: 3 })), 'Piece 3/3 · downloading the result');
  assert.equal(english(stageText('parse', { index: 1, count: 1 })), 'Converting');
  for (const phase of ['split', 'merge', 'save', 'queued', 'upload', 'parse', 'download', 'other']) assert.doesNotMatch(english(stageText(phase)), han, phase);
  assert.equal(english('已存为 450 页资料'), 'Saved as 450 pages of material');
});

test('messages that carry numbers keep them in English', () => {
  assert.match(english('缺少第 201–400 页的解析结果，没法合并成整本书。请重试没完成的分段。'), /201–400/);
  assert.match(english('这个 PDF 的第 3 页单独就有 31 MB，超过云端解析单个文件的上限，没法拆小。请先压缩这一页的图片，或用桌面客户端处理。'), /Page 3.*31 MB/);
  assert.match(english('解析结果合起来有 55 MB，超过了 40 MB 的导入上限。请把这本书分成两份 PDF 再导入。'), /55 MB.*40 MB/);
});

test('the inbox letters of a conversion have a label in both languages', () => {
  assert.equal(INBOX_KINDS['pdf-result'], 'PDF 转换完成');
  assert.equal(INBOX_KINDS['pdf-failed'], 'PDF 转换未完成');
  assert.equal(english(INBOX_KINDS['pdf-result']), 'PDF conversion finished');
  assert.equal(english(INBOX_KINDS['pdf-failed']), 'PDF conversion did not finish');
});

test('error classes carry their codes', () => {
  assert.equal(new PdfChunkError('x', 'm').code, 'x');
  assert.equal(new MineruResultError('y', 'm').code, 'y');
});
