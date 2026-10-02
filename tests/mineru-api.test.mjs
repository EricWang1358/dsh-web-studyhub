import test from 'node:test';
import assert from 'node:assert/strict';
import { MINERU, MineruError, createMineruClient, mapMineruFailure } from '../lib/mineru-api.js';
import { FAKE_TOKEN, startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';

/* The MinerU precision API client, against a local fake built from the official documentation. */

const BAD_TOKEN = 'eyJ0eXBlIjoiSldUIn0.WRONG_wrong_wrong_0000000000000.sig';

async function withServer(t, options) {
  const fake = await startFakeMineru(options);
  t.after(() => fake.close());
  return fake;
}
const clientFor = (fake, token = fake.token, extra = {}) => createMineruClient({ token, baseUrl: fake.baseUrl, ...extra });

test('the documented constants live in one place', () => {
  assert.equal(MINERU.baseUrl, 'https://mineru.net/api/v4');
  assert.equal(MINERU.docsUrl, 'https://mineru.net/apiManage/docs');
  assert.equal(MINERU.modelVersion, 'vlm');
  assert.equal(MINERU.maxPages, 200);
  assert.equal(MINERU.maxBytes, 200 * 1024 * 1024);
  assert.ok(MINERU.pollMs >= 3000 && MINERU.pollMs <= 5000, 'polls politely, every few seconds');
});

test('the test-token call is one harmless authenticated request and reports a valid token', async t => {
  const fake = await withServer(t);
  const result = await clientFor(fake).check();
  assert.deepEqual(result, { ok: true });
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].method, 'GET');
  assert.match(fake.requests[0].path, /\/extract-results\/batch\//);
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(fake.batches.size, 0, 'nothing is created or uploaded by a check');
});

test('an invalid token (A0202, or HTTP 401) and an expired one (A0211) are told apart', async t => {
  const wrong = await withServer(t);
  await assert.rejects(clientFor(wrong, BAD_TOKEN).check(), error => error instanceof MineruError && error.code === 'invalid-token');
  const http = await withServer(t, { authStyle: 'http' });
  await assert.rejects(clientFor(http, BAD_TOKEN).check(), error => error.code === 'invalid-token');
  const expired = await withServer(t, { expired: true });
  await assert.rejects(clientFor(expired, BAD_TOKEN).check(), error => error.code === 'expired' && /过期/.test(error.message));
});

test('an unreachable service is reported as a network problem, not as a bad token', async () => {
  const client = createMineruClient({ token: FAKE_TOKEN, baseUrl: 'http://127.0.0.1:9/api/v4' });
  await assert.rejects(client.check(), error => error.code === 'network' && error.retryable === true && /网络/.test(error.message));
});

test('no message or error object ever carries the token', async t => {
  const fake = await withServer(t);
  const failures = [];
  for (const client of [clientFor(fake, BAD_TOKEN), createMineruClient({ token: BAD_TOKEN, baseUrl: 'http://127.0.0.1:9/api/v4' })]) {
    try { await client.check(); } catch (error) { failures.push(error); }
  }
  assert.equal(failures.length, 2);
  for (const error of failures) {
    const dump = JSON.stringify({ message: error.message, code: error.code, own: Object.getOwnPropertyNames(error).map(name => String(error[name])) });
    assert.ok(!dump.includes(BAD_TOKEN) && !dump.includes('WRONG_wrong'), dump);
  }
});

test('asking for upload addresses sends the documented body and returns the batch and one address per file', async t => {
  const fake = await withServer(t);
  const result = await clientFor(fake).requestUploads([{ name: 'book-part-1.pdf', dataId: 'sh-job-0001' }], { language: 'ch' });
  assert.match(result.batchId, /^batch-/);
  assert.equal(result.urls.length, 1);
  const call = fake.requests.find(item => item.method === 'POST');
  assert.equal(call.path, '/api/v4/file-urls/batch');
  assert.equal(call.headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.match(call.headers['content-type'], /application\/json/);
  const body = JSON.parse(call.body);
  assert.deepEqual(body.files, [{ name: 'book-part-1.pdf', data_id: 'sh-job-0001', is_ocr: true }]);
  assert.equal(body.model_version, 'vlm');
  assert.equal(body.enable_formula, true);
  assert.equal(body.enable_table, true);
  assert.equal(body.language, 'ch');
  assert.ok(!('page_ranges' in body.files[0]), 'chunking never relies on page_ranges');
});

test('the file goes up as raw bytes, without the token and without a JSON content type', async t => {
  const fake = await withServer(t);
  const client = clientFor(fake);
  const { batchId, urls } = await client.requestUploads([{ name: 'a.pdf', dataId: 'sh-a' }]);
  const bytes = await makePdf({ pages: 2 });
  await client.upload(urls[0], bytes);
  assert.equal(fake.uploads.length, 1);
  assert.equal(fake.uploads[0].bytes, bytes.length);
  assert.equal(fake.uploads[0].headers.authorization, undefined, 'the storage address is pre-signed: no token goes there');
  assert.ok(!/json/.test(fake.uploads[0].headers['content-type'] || ''));
  assert.equal(fake.batches.get(batchId).files[0].pages, 2);
});

test('a status poll maps the documented states and the extracted-pages progress', async t => {
  const fake = await withServer(t, { steps: 2 });
  const client = clientFor(fake);
  const { batchId, urls } = await client.requestUploads([{ name: 'a.pdf', dataId: 'sh-a' }]);
  let status = await client.status(batchId);
  assert.equal(status[0].state, 'waiting', 'nothing uploaded yet');
  await client.upload(urls[0], await makePdf({ pages: 30 }));
  const seen = [];
  for (let i = 0; i < 6; i++) { status = await client.status(batchId); seen.push(status[0]); if (status[0].state === 'done') break; }
  assert.deepEqual(seen.map(item => item.state), ['pending', 'running', 'running', 'done']);
  assert.equal(seen[1].extractedPages, 10);
  assert.equal(seen[1].totalPages, 30);
  assert.ok(seen[2].extractedPages > seen[1].extractedPages);
  assert.equal(seen[3].dataId, 'sh-a');
  assert.match(seen[3].zipUrl, /\/zip\//);
});

test('the result ZIP is downloaded as bytes', async t => {
  const fake = await withServer(t, { steps: 0 });
  const client = clientFor(fake);
  const { batchId, urls } = await client.requestUploads([{ name: 'a.pdf', dataId: 'sh-a' }]);
  await client.upload(urls[0], await makePdf({ pages: 2 }));
  let item;
  for (let i = 0; i < 5 && item?.state !== 'done'; i++) item = (await client.status(batchId))[0];
  const zip = await client.download(item.zipUrl);
  assert.ok(Buffer.isBuffer(zip));
  assert.equal(zip.subarray(0, 2).toString('latin1'), 'PK');
  assert.equal(fake.requests.at(-1).headers.authorization, undefined, 'the result address is pre-signed too');
});

test('failure reports from the service become plain messages with a stable code', () => {
  const cases = [
    [{ code: 'A0202', msg: 'invalid token' }, 'invalid-token', /令牌/],
    [{ code: 'A0211', msg: 'token expired' }, 'expired', /过期/],
    [{ code: -60005, msg: 'file too large' }, 'too-large', /200 ?MB|大/],
    [{ code: -60006, msg: 'too many pages' }, 'too-many-pages', /200/],
    [{ code: -60012, msg: 'task not found' }, 'task-not-found', /找不到|不存在/],
    [{ code: -60015, msg: 'conversion failed' }, 'conversion-failed', /转换/],
    [{ httpStatus: 429 }, 'rate-limited', /稍后|等/],
    [{ httpStatus: 503 }, 'unavailable', /暂时/],
    [{ httpStatus: 401 }, 'invalid-token', /令牌/],
    [{ code: -10002, msg: 'something new' }, 'unexpected', /something new/],
  ];
  for (const [input, code, message] of cases) {
    const error = mapMineruFailure(input);
    assert.ok(error instanceof MineruError);
    assert.equal(error.code, code, JSON.stringify(input));
    assert.match(error.message, message);
  }
  assert.equal(mapMineruFailure({ httpStatus: 429 }).retryable, true);
  assert.equal(mapMineruFailure({ httpStatus: 503 }).retryable, true);
  assert.equal(mapMineruFailure({ code: 'A0202' }).retryable, false);
  assert.equal(mapMineruFailure({ code: -60015 }).retryable, true, 'a failed chunk can be tried again');
});

test('a rate limit carries how long to wait when the service says so', async t => {
  const fake = await withServer(t);
  fake.inject((method, path) => method === 'GET', { code: 'rate' }, { status: 429, headers: { 'retry-after': '7' } });
  await assert.rejects(clientFor(fake).status('batch-x'), error => error.code === 'rate-limited' && error.retryAfterMs === 7000);
});

test('a reply that is not the documented JSON is a bad response, not a crash', async t => {
  const fake = await withServer(t);
  fake.inject(() => true, '<html>gateway</html>', { status: 200 });
  await assert.rejects(clientFor(fake).status('batch-x'), error => error instanceof MineruError && ['bad-response', 'unexpected'].includes(error.code));
});

test('an aborted request stops at once with the abort reason', async t => {
  const fake = await withServer(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled by learner'));
  await assert.rejects(clientFor(fake).status('batch-x', { signal: controller.signal }), /cancelled by learner/);
});
