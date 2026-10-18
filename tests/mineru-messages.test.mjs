import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localizeAppMessage } from '../lib/application-messages.js';
import { INBOX_KINDS } from '../lib/inbox.js';
import { JOB_TEXT, convertHome, jobDir, planFile } from '../lib/mineru-job.js';
import { MineruResultError, mergeChunkResults } from '../lib/mineru-merge.js';
import { LOCAL_MESSAGES } from '../lib/mineru-local.js';
import { MINERU_INSTALL_JOB_TEXT, MINERU_INSTALL_MESSAGES, MINERU_STAGE_NAMES } from '../lib/mineru-install-text.js';
import { MINERU_FAILURE_TEXT } from '../lib/mineru-install.js';
import { PdfChunkError, inspectPdf } from '../lib/pdf-chunker.js';
import { CONVERT_TEXT } from '../lib/contexts/audio/convert-support.js';
import { NO_MATERIALS, stageText } from '../lib/contexts/audio/convert.js';
import { mineruStageText } from '../lib/contexts/audio/install/mineru-install-job.js';
import { makeEncryptedPdf, makePdf } from './helpers/pdf.mjs';

/* PDF conversion on this computer and the one-click MinerU install: every sentence a learner can see from the server side has an English form, with its
   numbers kept. */

const han = /[㐀-鿿]/;
const english = text => localizeAppMessage(text, 'en');

async function collected() {
  const found = [];
  const note = async run => { try { await run(); } catch (error) { found.push(error.message); } };
  const home = await mkdtemp(join(tmpdir(), 'mineru-msg-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    found.push(NO_MATERIALS, ...Object.values(JOB_TEXT), ...Object.values(LOCAL_MESSAGES), ...Object.values(MINERU_STAGE_NAMES), ...Object.values(MINERU_FAILURE_TEXT),
      ...Object.values(MINERU_INSTALL_MESSAGES).filter(value => typeof value === 'string'), MINERU_INSTALL_MESSAGES.noSpace('D:', '900 MB', '3.9 GB'), MINERU_INSTALL_MESSAGES.wrongVersion('3.1.0'),
      MINERU_INSTALL_JOB_TEXT.title, MINERU_INSTALL_JOB_TEXT.done, MINERU_INSTALL_JOB_TEXT.cancelled, MINERU_INSTALL_JOB_TEXT.failed,
      ...['tools', 'python', 'package', 'models', 'enable', 'check'].map(mineruStageText),
      CONVERT_TEXT.cloudGone, CONVERT_TEXT.serviceFailed, CONVERT_TEXT.started({ converter: 'mineru' }), CONVERT_TEXT.started({ converter: 'marker' }));
    await note(() => jobDir('x', 'bad id'));
    await note(() => inspectPdf(Buffer.from('not a pdf')));
    await note(() => inspectPdf(Buffer.from('%PDF-1.7\n' + 'garbage '.repeat(60))));
    await note(async () => inspectPdf(await makeEncryptedPdf()));
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

test('every message a learner can see from PDF conversion and the MinerU install has an English form', async () => {
  const messages = await collected();
  assert.ok(messages.length >= 60, `collected ${messages.length} messages`);
  for (const message of messages) assert.doesNotMatch(english(message), han, message);
});

test('job stages, with the piece they are on, translate and keep their numbers', () => {
  assert.equal(english(stageText('local', { index: 2, count: 3 })), 'Piece 2/3 · converting locally');
  assert.equal(english(stageText('start-service')), 'Starting the local MinerU service (about a minute the first time)');
  for (const phase of ['split', 'merge', 'save', 'queued', 'local', 'start-service', 'other']) assert.doesNotMatch(english(stageText(phase)), han, phase);
  assert.equal(english('已存为 450 页资料'), 'Saved as 450 pages of material');
  assert.equal(english(mineruStageText('models')), 'Step 4/6: Downloading the models');
  // An old cloud job's stage still reads in English.
  assert.equal(english('第 2/3 段 · 正在上传'), 'Piece 2/3 · uploading');
});

test('messages that carry numbers keep them in English', () => {
  assert.match(english('缺少第 201–400 页的解析结果，没法合并成整本书。请重试没完成的分段。'), /201–400/);
  assert.match(english('解析结果合起来有 55 MB，超过了 40 MB 的导入上限。请把这本书分成两份 PDF 再导入。'), /55 MB.*40 MB/);
  assert.equal(english(MINERU_INSTALL_MESSAGES.noSpace('D:', '900 MB', '3.9 GB')), 'D: has 900 MB free; at least 3.9 GB is needed. Choose a disk with more room.');
  assert.match(english(`${CONVERT_TEXT.serviceFailed}（端口被占用）`), /could not start.*\(/);
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
