/* MINERU_TOKEN=<token> node scripts/qa/mineru-cloud-smoke.mjs <file.pdf> [--base-url https://mineru.net/api/v4] [--keep]
   One real run of the optional MinerU cloud route (#1765) against the real API, through StudyHub's own code: the client of
   lib/contexts/audio/mineru-api.js, the job of lib/mineru-job.js (cut -> ask for an upload address -> PUT -> poll -> download -> pick the
   content list -> merge) and the importer's parser (lib/converted-document.js). It UPLOADS the PDF and spends the account's pages: use a
   short PDF. It prints each request's shape (method, host, path, whether it carried a Content-Type or a token, the HTTP status), every
   state the batch reports, the files of the result zip, which content list was read and the page count StudyHub would import. It never
   prints the token or a pre-signed address's query string, and it never touches the owner's library or DSH home: the job's files go to a
   private temporary DSH_HOME, removed at the end unless --keep. Not part of npm test. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

function parse(argv) {
  const options = { file: '', baseUrl: '', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--base-url') options.baseUrl = argv[++i] ?? '';
    else if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  return options;
}

const options = parse(process.argv.slice(2));
const token = String(process.env.MINERU_TOKEN || '').trim();
if (!options.file || !token) {
  console.error('Usage: MINERU_TOKEN=<token> node scripts/qa/mineru-cloud-smoke.mjs <file.pdf> [--base-url <url>] [--keep]');
  process.exit(2);
}
const redact = text => String(text ?? '').split(token).join('[token]');
const say = (...parts) => console.log(redact(parts.join(' ')));

// A private DSH home before any StudyHub module reads it: the job folder, its pieces and results live there, never in ~/.dsh.
const home = await mkdtemp(join(tmpdir(), 'mineru-cloud-smoke-'));
process.env.DSH_HOME = home;
const { MINERU, MineruError, createMineruClient, endpointHost } = await import('../../lib/contexts/audio/mineru-api.js');
const { convertPdf, prepareJob } = await import('../../lib/mineru-job.js');
const { readResultZip } = await import('../../lib/mineru-merge.js');
const { readZip } = await import('../../lib/office/zip.js');
const { parseConvertedDocument } = await import('../../lib/converted-document.js');

/** fetch, recording the shape of each request and the raw state of each batch poll (values of headers are never kept). */
const requests = [], states = [];
async function recordingFetch(url, init = {}) {
  const target = new URL(url), headers = new Headers(init.headers || {});
  const entry = { method: init.method || 'GET', host: target.host, path: target.pathname, query: target.search ? '(signed)' : '',
    contentType: headers.has('content-type') ? headers.get('content-type') : '(none)', token: headers.has('authorization') ? 'yes' : 'no',
    bytes: init.body?.byteLength ?? (typeof init.body === 'string' ? init.body.length : 0) };
  const response = await globalThis.fetch(url, init);
  entry.status = response.status;
  requests.push(entry);
  say(`  ${entry.method} ${entry.host}${entry.path}${entry.query && ' ?' + entry.query} -> HTTP ${entry.status} · Content-Type sent: ${entry.contentType} · token sent: ${entry.token}${entry.bytes ? ` · ${entry.bytes} bytes` : ''}`);
  if (entry.method === 'GET' && /\/extract-results\/batch\//.test(entry.path)) {
    try {
      const body = await response.clone().json();
      for (const item of body?.data?.extract_result ?? []) {
        const progress = item.extract_progress ? ` (${item.extract_progress.extracted_pages}/${item.extract_progress.total_pages} pages)` : '';
        const zip = item.full_zip_url ? ` zip on ${new URL(item.full_zip_url).host}` : '';
        states.push(item.state);
        say(`    state: ${item.state}${progress}${zip}${item.err_msg ? ` · err_msg: ${item.err_msg}` : ''}`);
      }
      if (body?.code !== 0) say(`    code: ${body?.code} · msg: ${body?.msg}`);
    } catch { /* not JSON: the client reports it */ }
  }
  return response;
}

const controller = new AbortController();
process.once('SIGINT', () => { say('Stopping (Ctrl+C)…'); controller.abort(new Error('stopped by Ctrl+C')); });

let failed = false;
try {
  const source = resolve(options.file);
  const client = createMineruClient({ token, baseUrl: options.baseUrl || MINERU.baseUrl, fetch: recordingFetch });
  say(`Endpoint: ${client.baseUrl} (${endpointHost(client.baseUrl)})`);
  say(`Official limits StudyHub applies: ${MINERU.maxPages} pages and ${MINERU.maxBytes / 1024 / 1024} MB per file; ${MINERU.dailyPriorityPages} pages a day at top priority; tokens valid ${MINERU.tokenValidityDays} days.`);

  say('1. Checking the token (one request, no document):');
  await client.check({ signal: controller.signal });
  say('   token accepted.');

  // The download is wrapped to show the files of the archive and which content list the importer gets.
  const download = client.download;
  client.download = async (url, args) => {
    const bytes = await download(url, args);
    const names = readZip(bytes, { maxEntryBytes: 256 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxEntries: 5000 }).names();
    const picked = readResultZip(bytes);
    say(`    zip (${bytes.length} bytes): ${names.join(', ')}`);
    say(`    content list read: ${picked.entry} (${picked.format}, ${picked.content.length} entries)`);
    return bytes;
  };

  const library = await mkdtemp(join(home, 'library-'));
  const { dir, manifest } = await prepareJob({ root: library, source, filename: basename(source), route: 'cloud', baseUrl: client.baseUrl });
  say(`2. ${basename(source)}: ${manifest.totalPages} pages, ${manifest.sourceBytes} bytes. This UPLOADS it to ${endpointHost(client.baseUrl)} and uses ${manifest.totalPages} of the account's pages.`);

  let lastPhase = '';
  let imported = null;
  const result = await convertPdf({ dir, manifest, root: library, client, signal: controller.signal,
    onProgress: patch => {
      const line = `${patch.phase} · piece ${patch.chunk?.index ?? '?'}/${patch.chunk?.count || patch.chunks?.length || '?'} · ${patch.done}/${patch.total} pages${patch.note ? ` · ${patch.note}` : ''}`;
      if (line !== lastPhase) { lastPhase = line; say(`  [${new Date().toISOString().slice(11, 19)}] ${line}`); }
    },
    importMerged: async ({ bytes, filename, format }) => {
      const book = parseConvertedDocument(bytes.toString('utf8'), { filename });
      imported = { format, converter: book.converter, totalPages: book.totalPages, pagesWithText: book.pages.filter(page => page.text.trim()).length,
        first: book.pages.slice(0, 3).map(page => `p${page.page}: ${page.text.replace(/\s+/g, ' ').slice(0, 60)}`) };
      return { sourceIds: [] };
    } });

  say('3. Result:');
  say(`   states seen: ${[...new Set(states)].join(' -> ')}`);
  const puts = requests.filter(entry => entry.method === 'PUT');
  say(`   uploads: ${puts.length}, each without Content-Type: ${puts.every(entry => entry.contentType === '(none)')}, without token: ${puts.every(entry => entry.token === 'no')}`);
  say(`   pieces: ${result.chunks}; merged ${result.mergedBytes} bytes, ${result.chars} characters`);
  say(`   StudyHub would import: ${imported.totalPages} pages (${imported.pagesWithText} with text) of ${manifest.totalPages} in the PDF, as ${imported.converter} ${imported.format}`);
  for (const line of imported.first) say(`     ${line}`);
  if (imported.totalPages !== manifest.totalPages) { failed = true; say('   MISMATCH: the imported page count differs from the PDF.'); }
} catch (error) {
  failed = true;
  const kind = error instanceof MineruError ? `${error.code}${error.apiCode !== undefined ? ` (API code ${error.apiCode})` : ''}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}` : error?.code || error?.name || 'error';
  say(`FAILED: ${kind}: ${error?.message || error}`);
} finally {
  if (options.keep) say(`Kept the job files in ${home}`);
  else await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
process.exitCode = failed ? 1 : 0;
