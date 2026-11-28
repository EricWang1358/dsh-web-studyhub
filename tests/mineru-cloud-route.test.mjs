import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { makePdf } from './helpers/pdf.mjs';
import { zipStored } from './helpers/zip.mjs';
import { patientCli, until } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';

/* Issue #1765: optional MinerU cloud / third-party route with custom baseUrl + Key,
   default remains local (no upload), upload consent required before cloud upload,
   and failed cloud jobs can switch cleanly to local ("改用本机"). */

const FAKE_CLI = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));

async function startFakeCloudServer(t, behavior = {}) {
  const requests = [];
  const state = { failAuth: false, failServer: false, failConversion: false, ...behavior };
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = Buffer.concat(parts);
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });

    if (req.url.startsWith('/v4/') && state.failAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'A0202', msg: 'invalid token' }));
      return;
    }
    if (req.url.startsWith('/v4/') && state.failServer) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 503, msg: 'service unavailable' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v4/file-urls/batch') {
      const parsed = JSON.parse(body.toString('utf8'));
      const dataId = parsed.files?.[0]?.data_id || 'd1';
      state.lastDataId = dataId;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { batch_id: 'batch-1', file_urls: [`http://127.0.0.1:${port}/upload/1`] } }));
      return;
    }
    if (req.method === 'PUT' && req.url === '/upload/1') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/v4/extract-results/batch/batch-1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (state.failConversion) {
        res.end(JSON.stringify({ code: 0, data: { extract_result: [{ file_name: 'Book.pdf', data_id: state.lastDataId || 'd1', state: 'failed', err_msg: 'boom' }] } }));
        return;
      }
      res.end(JSON.stringify({ code: 0, data: { extract_result: [{ file_name: 'Book.pdf', data_id: state.lastDataId || 'd1', state: 'done', full_zip_url: `http://127.0.0.1:${port}/result.zip` }] } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/result.zip') {
      const content = [
        { type: 'text', text: 'Cloud page 1 body text.', page_idx: 0 },
        { type: 'text', text: 'Cloud page 2 body text.', page_idx: 1 },
        { type: 'text', text: 'Cloud page 3 body text.', page_idx: 2 },
      ];
      const zip = zipStored({ 'book_content_list.json': JSON.stringify(content) });
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(zip);
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v4/extract-results/batch/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: -60012, msg: 'not found' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${port}/v4`, requests, state };
}

async function setup(t, { runtime = false, localReady = true, limits = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-cloud-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-cloud-lib-'));
  const work = await mkdtemp(join(tmpdir(), 'study-cloud-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home;
  delete process.env.MINERU_API_KEY;
  delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.12', mode: 'managed', tier: 'basic', running: true, total: 3, modelsReady: true }));
  await writeFile(logPath, '');
  const cli = localReady ? patientCli({ file: process.execPath, prefix: [FAKE_CLI], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } }) : null;
  const { starts: _s, ...managed } = managedRuntimeOptions({ paths: runtime ? ['pdfConvert'] : [] });
  const service = new StudyService(root, {
    ...(runtime ? managed : {}),
    mineru: {
      sleep: async () => {},
      limits: { windowPages: 50, livenessMs: 0, ...limits },
      local: { cli, home: work },
    },
  });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  const upload = async (bytes, name = 'Book.pdf') => {
    const { uploadId, chunkBytes } = await call('mineru.upload.start', { name, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    }
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  const jobs = async () => (await call('snapshot')).jobs.filter(job => job.type === 'pdf-convert');
  const settled = async id => {
    const job = await until(async () => {
      const entry = (await jobs()).find(item => item.id === id);
      return entry && !['queued', 'running', 'cancelling'].includes(entry.status) && entry;
    }, 'pdf convert job to settle');
    await call('job.wait', { jobId: id, timeoutSeconds: 30 });
    return (await jobs()).find(item => item.id === id) || job;
  };
  const parses = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.argv[0] === 'parse');
  return { home, root, work, service, call, upload, jobs, settled, parses };
}

test('default route is local (zero cloud uploads), even when a cloud Key is saved unless cloud mode/route is chosen', async t => {
  const cloud = await startFakeCloudServer(t);
  const h = await setup(t);
  await h.call('mineru.settings.set', { baseUrl: cloud.baseUrl, token: 'sk-custom-key-123456', acknowledge: true });
  const settings = await h.call('mineru.settings.get');
  assert.equal(settings.mode, 'local', 'mode stays local by default');

  const started = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  const done = await h.settled(started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.route, 'local');
  assert.equal(cloud.requests.length, 0, 'nothing was uploaded to cloud');
});

test('cloud conversion requires both Key and upload acknowledgement, then converts through custom baseUrl + Key without leaking Key', async t => {
  const cloud = await startFakeCloudServer(t);
  const h = await setup(t, { localReady: false });
  const secret = 'sk-third-party-secret-998877';

  // Refused without token
  await assert.rejects(
    h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'cloud' }),
    error => error.code === 'no-token',
  );

  // Set baseUrl + token without acknowledge -> refused with no-ack
  await h.call('mineru.settings.set', { mode: 'cloud', baseUrl: cloud.baseUrl, token: secret });
  assert.equal((await h.call('mineru.test')).ok, true);
  await assert.rejects(
    h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'cloud' }),
    error => error.code === 'no-ack',
  );
  assert.equal(cloud.requests.filter(r => r.method === 'POST').length, 0, 'no upload before acknowledgement');

  // Acknowledge and run cloud conversion (even with no local MinerU installed!)
  await h.call('mineru.settings.set', { acknowledge: true });
  const started = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })) });
  const done = await h.settled(started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.route, 'cloud');
  assert.equal(done.sourceIds.length, 3);
  assert.equal(done.env.kind, 'cloud');
  assert.ok(done.env.endpoint.startsWith('127.0.0.1:'));

  // Secret must NEVER leak into snapshot jobs or history
  const snapshotJson = JSON.stringify(await h.call('snapshot'));
  const historyJson = JSON.stringify(await h.call('mineru.history.list'));
  assert.ok(!snapshotJson.includes(secret), 'secret never appears in snapshot');
  assert.ok(!historyJson.includes(secret), 'secret never appears in history');
});

for (const runtime of [false, true]) {
  test(`cloud failure -> switch to local ("改用本机") via mineru.retry({ route: "local" }) completes locally and receipt reports cloud (runtime=${runtime})`, async t => {
    const cloud = await startFakeCloudServer(t, { failAuth: true });
    const h = await setup(t, { runtime, localReady: true });
    await h.call('mineru.settings.set', { mode: 'cloud', baseUrl: cloud.baseUrl, token: 'sk-bad-token-000000', acknowledge: true });

    const started = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'cloud' });
    assert.equal(started.route, 'cloud', 'import receipt must report route: cloud');
    assert.match(started.next, /MinerU 云端/, 'import receipt must name MinerU 云端');
    assert.doesNotMatch(started.next, /MinerU 本机/, 'import receipt must not say MinerU 本机');

    const failed = await h.settled(started.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.route, 'cloud');
    assert.equal(failed.errorCode, 'invalid-token');
    assert.equal((await h.parses()).length, 0);

    // Switch this failed cloud job to local!
    const switched = await h.call('mineru.retry', { jobId: failed.id, route: 'local' });
    const done = await h.settled(switched.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.equal(done.route, 'local');
    assert.equal(done.sourceIds.length, 3);
    assert.equal((await h.parses()).length, 1, 'local MinerU actually parsed the PDF');
    const [row] = (await h.call('mineru.history.list')).records;
    assert.equal(row.route, 'local');
    assert.equal(row.status, 'complete');
  });

  test(`cloud page-too-large failure keeps source.pdf and switches cleanly to local via mineru.retry({ route: "local" }) (runtime=${runtime})`, async t => {
    const cloud = await startFakeCloudServer(t);
    // maxBytes: 100 guarantees a single page exceeds cloud piece limit during splitPdf -> PdfChunkError('page-too-large').
    const h = await setup(t, { runtime, localReady: true, limits: { maxBytes: 100 } });
    await h.call('mineru.settings.set', { mode: 'cloud', baseUrl: cloud.baseUrl, token: 'sk-valid-token-123456', acknowledge: true });

    const started = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 3 })), route: 'cloud' });
    assert.equal(started.route, 'cloud');
    const failed = await h.settled(started.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.route, 'cloud');
    assert.equal(failed.errorCode, 'page-too-large');

    // Plain cloud retry on page-too-large is refused clearly instead of looping on cloud.
    await assert.rejects(h.call('mineru.retry', { jobId: failed.id }), /改用本机/);

    // Switching to local succeeds under both runtime=false and runtime=true!
    const switched = await h.call('mineru.retry', { jobId: failed.id, route: 'local' });
    const done = await h.settled(switched.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.equal(done.route, 'local');
    assert.equal(done.sourceIds.length, 3);
    assert.equal((await h.parses()).length, 1);
  });
}
