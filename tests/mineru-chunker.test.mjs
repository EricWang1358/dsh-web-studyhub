import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfChunkError, inspectPdf } from '../lib/pdf-chunker.js';
import { makeEncryptedPdf, makePdf } from './helpers/pdf.mjs';

/* Reading a PDF before it is converted on this computer: its page count, and a plain message for a PDF that cannot be read. (Cutting a book into
   pieces for the MinerU cloud went with the cloud route in 3.5.5.) */

test('inspectPdf reads the page count and the size', async () => {
  const bytes = await makePdf({ pages: 12, outline: [{ title: 'One', page: 1 }, { title: 'Two', page: 5 }] });
  const info = await inspectPdf(bytes);
  assert.equal(info.pages, 12);
  assert.equal(info.bytes, bytes.length);
});

test('a password-protected PDF gets a plain message, not a crash', async () => {
  const bytes = await makeEncryptedPdf();
  await assert.rejects(inspectPdf(bytes), error => error instanceof PdfChunkError && error.code === 'encrypted' && /密码/.test(error.message) && !/上传/.test(error.message));
});

test('files that are not PDFs, or are damaged, are named as such', async () => {
  await assert.rejects(inspectPdf(Buffer.from('hello world, not a pdf')), error => error instanceof PdfChunkError && error.code === 'not-pdf');
  const good = await makePdf({ pages: 3 });
  const truncated = good.subarray(0, Math.floor(good.length / 3));
  await assert.rejects(inspectPdf(truncated), error => error instanceof PdfChunkError && ['damaged', 'not-pdf'].includes(error.code));
  const garbage = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('this is not a real body '.repeat(50))]);
  await assert.rejects(inspectPdf(garbage), error => error instanceof PdfChunkError && error.code === 'damaged');
});
