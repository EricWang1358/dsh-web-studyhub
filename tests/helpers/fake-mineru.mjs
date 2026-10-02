import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { zipStored } from './zip.mjs';

/* A fake MinerU precision API on a local HTTP server, built from the official documentation (https://mineru.net/apiManage/docs):
   POST /api/v4/file-urls/batch -> { batch_id, file_urls }, PUT of the raw bytes to each file url (no auth header),
   GET /api/v4/extract-results/batch/{id} polled until `done`, then GET of full_zip_url (a ZIP with content_list.json).
   Nothing here talks to the real service. */

export const FAKE_TOKEN = 'eyJ0eXBlIjoiSldUIn0.fake_MINERU_token_0000000000000001.sig-test';

const json = (response, body, status = 200, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};
const ok = data => ({ code: 0, msg: 'ok', data });

async function pdfPages(bytes) {
  try { return (await PDFDocument.load(bytes)).getPageCount(); } catch { return 1; }
}

/**
 * options:
 *  token                accepted bearer token (default FAKE_TOKEN)
 *  authStyle            'json' (HTTP 200 with code A0202/A0211, default) or 'http' (HTTP 401)
 *  expired              answer A0211 instead of A0202 for a wrong token
 *  steps                running polls before `done` (default 2)
 *  contentList(file)    custom content_list items for a finished file
 *  listName             name of the content list inside the ZIP (default `${stem}_content_list.json`)
 *  v2                   write content_list_v2-style pages instead of the flat list
 *  failWhen(file)       return an err_msg to make that file `failed`
 *  holdWhen(file, poll) return true to keep a file `pending` on that poll (a slow or queued task)
 *  onPoll(file, poll)   observe each status request
 */
export async function startFakeMineru(options = {}) {
  const token = options.token ?? FAKE_TOKEN, steps = options.steps ?? 2;
  const batches = new Map(), requests = [], uploads = [], injected = [];
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const authorised = request => request.headers.authorization === `Bearer ${token}`;
  const rejected = response => {
    if (options.authStyle === 'http') return json(response, { code: 'A0202', msg: 'invalid token' }, 401);
    return json(response, { code: options.expired ? 'A0211' : 'A0202', msg: options.expired ? 'token expired' : 'invalid token' });
  };

  const zipOf = file => {
    const stem = file.name.replace(/\.[^.]+$/, '');
    const list = options.contentList ? options.contentList(file) : Array.from({ length: file.pages }, (_, index) => ({ index }))
      .flatMap(({ index }) => [
        { type: 'text', text: `${file.data_id} local page ${index + 1}`, page_idx: index },
        { type: 'image', img_path: `images/page-${index + 1}.jpg`, image_caption: [`Figure ${file.data_id} ${index + 1}`], page_idx: index },
      ]);
    const entries = { 'full.md': `# ${stem}\n`, 'layout.json': '{}' };
    const flat = options.v2 ? Array.from({ length: file.pages }, (_, index) => list.filter(item => item.page_idx === index).map(({ page_idx, ...rest }) => rest)) : list;
    entries[options.listName ?? `${stem}_content_list.json`] = JSON.stringify(flat);
    if (options.v2) entries[`${stem}_content_list_v2.json`] = JSON.stringify(flat);
    for (let page = 1; page <= file.pages; page++) entries[`images/page-${page}.jpg`] = Buffer.from([0xff, 0xd8, page & 0xff]);
    return zipStored(entries);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, origin());
    const chunks = [];
    for await (const part of request) chunks.push(part);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, path: url.pathname, headers: { ...request.headers }, body: request.method === 'PUT' ? undefined : body.toString('utf8') });
    const hook = injected.find(item => item.times > 0 && item.match(request.method, url.pathname));
    if (hook) { hook.times--; return json(response, hook.body, hook.status ?? 200, hook.headers); }

    if (url.pathname.startsWith('/upload/')) {
      const [, , batchId, index] = url.pathname.split('/');
      const batch = batches.get(batchId), file = batch?.files[Number(index)];
      if (!file) return json(response, { code: -1, msg: 'unknown upload' }, 404);
      uploads.push({ batchId, index: Number(index), bytes: body.length, headers: { ...request.headers } });
      file.data = body; file.pages = await pdfPages(body); file.polls = 0;
      response.writeHead(200); return response.end();
    }
    if (url.pathname.startsWith('/zip/')) {
      const [, , batchId, index] = url.pathname.split('/');
      const file = batches.get(batchId)?.files[Number(index)];
      if (!file?.data) return json(response, { code: -1, msg: 'no result' }, 404);
      response.writeHead(200, { 'content-type': 'application/zip' }); return response.end(zipOf(file));
    }
    if (!authorised(request)) return rejected(response);

    if (request.method === 'POST' && url.pathname === '/api/v4/file-urls/batch') {
      const payload = JSON.parse(body.toString('utf8'));
      const batchId = `batch-${randomUUID().slice(0, 8)}`;
      const files = payload.files.map(entry => ({ ...entry, state: 'waiting-file' }));
      batches.set(batchId, { id: batchId, payload, files });
      return json(response, ok({ batch_id: batchId, file_urls: files.map((_, index) => `${origin()}/upload/${batchId}/${index}`) }));
    }
    const status = /^\/api\/v4\/extract-results\/batch\/(.+)$/.exec(url.pathname);
    if (request.method === 'GET' && status) {
      const batch = batches.get(status[1]);
      if (!batch) return json(response, { code: -60012, msg: 'task not found' });
      const results = batch.files.map((file, index) => {
        const base = { file_name: file.name, data_id: file.data_id };
        if (!file.data) return { ...base, state: 'waiting-file' };
        const poll = ++file.polls;
        options.onPoll?.(file, poll);
        const failure = options.failWhen?.(file);
        if (failure) return { ...base, state: 'failed', err_msg: failure };
        if (options.holdWhen?.(file, poll)) return { ...base, state: 'pending' };
        if (poll === 1) return { ...base, state: 'pending' };
        if (poll <= 1 + steps) return { ...base, state: 'running', extract_progress: { extracted_pages: Math.ceil(file.pages * (poll - 1) / (steps + 1)), total_pages: file.pages, start_time: '2026-10-02 10:00:00' } };
        return { ...base, state: 'done', full_zip_url: `${origin()}/zip/${batch.id}/${index}` };
      });
      return json(response, ok({ batch_id: batch.id, extract_result: results }));
    }
    return json(response, { code: -1, msg: `unexpected ${request.method} ${url.pathname}` }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `${origin()}/api/v4`, token, batches, requests, uploads,
    /** Answer the next `times` requests matching (method, path) with this body instead. */
    inject(match, body, { status = 200, times = 1, headers } = {}) { injected.push({ match, body, status, times, headers }); },
    statusRequests: () => requests.filter(item => item.method === 'GET' && item.path.includes('/extract-results/')),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
