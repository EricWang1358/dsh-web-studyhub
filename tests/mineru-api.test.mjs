import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MINERU, MineruError, createMineruClient, endpointHost, mapMineruFailure, normalizeBaseUrl } from '../lib/contexts/audio/mineru-api.js';

/* The MinerU cloud / third-party compatible API client: URL normalization & scheme safety, Authorization header hygiene,
   custom baseUrl + Key support, upload/poll/download flow, and error mapping without ever leaking the Key. */

test('normalizeBaseUrl accepts blank (default), strips trailing slashes, and rejects unsafe schemes or credentials', () => {
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl('   '), '');
  assert.equal(normalizeBaseUrl(undefined), '');
  assert.equal(normalizeBaseUrl('https://mineru.net/api/v4/'), 'https://mineru.net/api/v4');
  assert.equal(normalizeBaseUrl('https://parser.example.com/custom/v4///'), 'https://parser.example.com/custom/v4');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/api/v4/'), 'http://127.0.0.1:8080/api/v4');
  assert.equal(endpointHost(''), 'mineru.net');
  assert.equal(endpointHost('https://parser.example.com/api/v4'), 'parser.example.com');
  assert.equal(endpointHost('http://127.0.0.1:8080/api/v4'), '127.0.0.1:8080');

  for (const bad of [
    'ftp://files.example.com/api',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'not-a-url',
    'https://user:pass@example.com/api/v4',
    'https://example.com/api/v4?token=secret',
    'https://example.com/api/v4#frag',
  ]) {
    assert.throws(() => normalizeBaseUrl(bad), error => error instanceof MineruError && error.code === 'invalid-base-url', `rejected: ${bad}`);
  }
});

test('createMineruClient routes requests to custom baseUrl with Bearer Key, and never sends Key to pre-signed URLs', async t => {
  const seen = [];
  const secret = 'sk-third-party-super-secret-9999';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', contentType: req.headers['content-type'] || '', body });
    if (req.method === 'POST' && req.url === '/custom/v4/file-urls/batch') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { batch_id: 'b-42', file_urls: [`http://127.0.0.1:${port}/presigned-put`] } }));
      return;
    }
    if (req.method === 'PUT' && req.url === '/presigned-put') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/custom/v4/extract-results/batch/b-42') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { extract_result: [{ file_name: 'book.pdf', data_id: 'd1', state: 'done', full_zip_url: `http://127.0.0.1:${port}/presigned-zip` }] } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/presigned-zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(Buffer.from('PK-fake-zip'));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/custom/v4/extract-results/batch/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: -60012, msg: 'task not found' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => server.close());

  const client = createMineruClient({ token: secret, baseUrl: `http://127.0.0.1:${port}/custom/v4/` });
  assert.deepEqual(await client.check(), { ok: true });
  const { batchId, urls } = await client.requestUploads([{ name: 'book.pdf', dataId: 'd1' }]);
  assert.equal(batchId, 'b-42');
  await client.upload(urls[0], Buffer.from('%PDF-1.7'));
  const items = await client.status(batchId);
  assert.equal(items[0].state, 'done');
  const downloaded = await client.download(items[0].zipUrl);
  assert.equal(downloaded.toString('utf8'), 'PK-fake-zip');

  const apiCalls = seen.filter(entry => entry.url.startsWith('/custom/v4/'));
  const presignedCalls = seen.filter(entry => entry.url.startsWith('/presigned-'));
  assert.equal(apiCalls.length, 3);
  assert.ok(apiCalls.every(entry => entry.auth === `Bearer ${secret}`), 'Bearer Key sent to API endpoint');
  assert.equal(presignedCalls.length, 2);
  assert.ok(presignedCalls.every(entry => entry.auth === ''), 'Key NEVER sent to pre-signed upload/download URLs');
});

test('createMineruClient falls back to MINERU.baseUrl when baseUrl is blank and never leaks Key in errors', async () => {
  const secret = 'sk-leak-check-secret-token-12345';
  const requestedUrls = [];
  const fakeFetch = async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify({ code: 9999, msg: `echoed ${secret}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  };
  const client = createMineruClient({ token: secret, baseUrl: '', fetch: fakeFetch });
  await assert.rejects(
    client.requestUploads([{ name: 'a.pdf', dataId: '1' }]),
    error => error instanceof MineruError && !error.message.includes(secret),
    'secret token must never appear in thrown error messages',
  );
  assert.equal(requestedUrls[0], `${MINERU.baseUrl}/file-urls/batch`);
});

test('mapMineruFailure classifies auth, rate limit, server errors and API error codes cleanly', () => {
  assert.equal(mapMineruFailure({ code: 'A0202' }).code, 'invalid-token');
  assert.equal(mapMineruFailure({ code: 'A0211' }).code, 'expired');
  assert.equal(mapMineruFailure({ httpStatus: 401 }).code, 'invalid-token');
  assert.equal(mapMineruFailure({ httpStatus: 403 }).code, 'invalid-token');
  assert.equal(mapMineruFailure({ httpStatus: 429, retryAfter: '12' }).retryAfterMs, 12000);
  assert.equal(mapMineruFailure({ httpStatus: 503 }).code, 'unavailable');
  assert.equal(mapMineruFailure({ httpStatus: 503 }).retryable, true);
  assert.equal(mapMineruFailure({ code: -60005 }).code, 'too-large');
  assert.equal(mapMineruFailure({ code: -60006 }).code, 'too-many-pages');
});
