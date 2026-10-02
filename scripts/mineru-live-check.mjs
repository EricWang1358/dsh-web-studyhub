#!/usr/bin/env node
/* One real, tiny round trip with the MinerU precision API, for the owner to run by hand with their own token:

     MINERU_API_KEY=<your token> node scripts/mineru-live-check.mjs            (whole round trip, a 2-page synthetic PDF)
     MINERU_API_KEY=<your token> node scripts/mineru-live-check.mjs --check-only  (only the harmless token check)

   Without MINERU_API_KEY it does NOTHING (no network, no files) and says so. It never prints the token. The PDF it uploads is
   generated here from two lines of text; no study material is read or sent. It reports each assumption StudyHub makes about
   the API that the tests can only check against a fake server, so a mismatch is visible at once:
     1. the harmless token check (status of a task that does not exist) tells a valid token apart from a bad one;
     2. POST /file-urls/batch -> upload URL; the raw PUT (no auth header, no content type) is accepted;
     3. the poll reports pending/running/done and `extract_progress`;
     4. the result ZIP holds a content_list.json whose items carry a 0-based page_idx;
     5. two pages in, two pages out. */

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { MINERU, MineruError, createMineruClient } from '../lib/mineru-api.js';
import { readResultZip } from '../lib/mineru-merge.js';
import { parseConvertedDocument } from '../lib/converted-document.js';

const token = String(process.env.MINERU_API_KEY || '').trim();
if (!token) {
  console.log('MINERU_API_KEY is not set: nothing was done. Set it to your own MinerU token to run one real round trip with a tiny synthetic PDF.');
  process.exit(0);
}
const checkOnly = process.argv.includes('--check-only');
const baseUrl = String(process.env.MINERU_BASE_URL || '').trim() || undefined;
const client = createMineruClient({ token, ...(baseUrl ? { baseUrl } : {}) });
const say = (ok, text) => console.log(`${ok === null ? '·' : ok ? 'OK ' : 'FAIL'} ${text}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The documented polling pace; only a test of this script against a fake server shortens it.
const pollMs = Number(process.env.MINERU_LIVE_POLL_MS) || MINERU.pollMs;

try {
  const check = await client.check();
  say(check.ok, 'token check: the status of a task that does not exist was answered like a valid token would be');
} catch (error) {
  say(false, `token check: ${error instanceof MineruError ? `${error.code}: ${error.message}` : error.message}`);
  process.exit(1);
}
if (checkOnly) process.exit(0);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (const [index, line] of ['StudyHub live check, page one.', 'StudyHub live check, page two.'].entries()) {
  const page = doc.addPage([300, 200]);
  page.drawText(line, { x: 20, y: 100, size: 14, font });
  void index;
}
const bytes = Buffer.from(await doc.save());

const { batchId, urls } = await client.requestUploads([{ name: 'studyhub-live-check.pdf', dataId: `studyhub-live-${Date.now()}` }]);
say(true, `upload address received for batch ${batchId.slice(0, 8)}…`);
await client.upload(urls[0], bytes);
say(true, 'raw PUT of the PDF accepted (no auth header, no content type)');

const seen = [];
const started = Date.now();
let item;
while (Date.now() - started < 10 * 60_000) {
  [item] = await client.status(batchId);
  if (seen.at(-1) !== item.state) seen.push(item.state);
  if (item.extractedPages !== undefined) say(null, `progress: ${item.extractedPages}/${item.totalPages ?? '?'} pages`);
  if (item.state === 'done' || item.state === 'failed') break;
  await sleep(pollMs);
}
say(item?.state === 'done', `poll states seen: ${seen.join(' -> ')}${item?.errMsg ? ` (${item.errMsg})` : ''}`);
if (item?.state !== 'done') process.exit(1);

const zip = await client.download(item.zipUrl);
const result = readResultZip(zip);
say(true, `result ZIP read: content list format ${result.format}, ${result.content.length} entries, ${result.images.length} image file(s)`);
const pages = result.format === 'v1'
  ? new Set(result.content.filter(entry => Number.isInteger(entry?.page_idx)).map(entry => entry.page_idx)).size : result.content.length;
say(pages === 2, `pages in the result: ${pages} (expected 2)`);
try {
  const book = parseConvertedDocument(JSON.stringify(result.content), { filename: 'studyhub-live-check.pdf' });
  say(book.totalPages === 2, `StudyHub's importer reads it as ${book.totalPages} pages, converter ${book.converter}`);
} catch (error) { say(false, `StudyHub's importer could not read it: ${error.message}`); }
