import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mount } from '../packages/studyhub-retrieval/index.js';
import { RESET_MARKER, healIndex, inspectFiles, inspectWithLanceDB, manifestVersion, stamp } from '../packages/studyhub-retrieval/heal.js';

/* The search extension checks its index before its server starts (2026-10-23: a crash while the index was being written left the newest
   files of the table full of zeros; LanceDB then read a table with no fields, the server stopped at every start on "Field path `text` not
   found", and StudyHub only said the search tool could not be found). A table the server could not use is moved aside, never deleted, and
   reset.json says so; a good table, a missing one, or a check that cannot decide leave everything as it is. The tables here are real
   LanceDB tables, written by the LanceDB the extension installs (packages/studyhub-retrieval/node_modules); without it those tests are skipped. */

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = join(root, 'packages', 'studyhub-retrieval');
let entry, lanceUrl, arrowUrl;
try {
  entry = createRequire(join(pkg, 'package.json')).resolve('mcp-local-rag');
  lanceUrl = pathToFileURL(createRequire(entry).resolve('@lancedb/lancedb')).href;
  arrowUrl = pathToFileURL(createRequire(join(pkg, 'package.json')).resolve('apache-arrow')).href;
} catch { lanceUrl = undefined; }
const real = lanceUrl ? {} : { skip: 'LanceDB is not installed next to the extension (npm install in packages/studyhub-retrieval)' };

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
  });
}

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-heal-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const data = join(dir, 'study', 'retrieval');
  await mkdir(join(data, 'lancedb'), { recursive: true });
  return { dir, data, db: join(data, 'lancedb'), table: join(data, 'lancedb', 'chunks.lance') };
}
const fixture = (where, kind) => run([join(root, 'tests', 'helpers', 'lance-fixture.mjs'), lanceUrl, arrowUrl, where.db, kind]);
const newest = async table => (await inspectFiles(table)).newest;
/** What a crash leaves: the newest manifest keeps its name and size, and every byte of it is zero. */
async function zeroNewest(table) {
  const { name, size } = await newest(table);
  const file = await open(join(table, '_versions', name), 'r+');
  try { await file.write(Buffer.alloc(size), 0, size, 0); } finally { await file.close(); }
}
const counting = () => { const calls = []; const check = async options => { calls.push(options); return inspectWithLanceDB(options); }; return { calls, check }; };
const exists = path => stat(path).then(() => true, () => false);
const marker = async where => JSON.parse(await readFile(join(where.data, RESET_MARKER), 'utf8'));

test('manifest names: the newer naming counts down from 2^64-1, the older one counts up; newest first either way', () => {
  assert.equal(manifestVersion('18446744073709545476.manifest'), 6139n);
  assert.equal(manifestVersion('18446744073709545483.manifest'), 6132n);
  assert.equal(manifestVersion('12.manifest'), 12n);
  assert.equal(manifestVersion('latest_version_hint.json'), null);
  assert.equal(stamp(new Date('2026-10-23T10:15:30.123Z')), '20261023T101530Z');
});

test('no index folder at all: nothing to check, nothing written', async t => {
  const where = await home(t);
  assert.deepEqual(await inspectFiles(where.table), { verdict: 'absent' });
  assert.deepEqual(await healIndex({ home: where.dir, lancedb: () => { throw new Error('not needed'); } }), {});
  assert.equal(await exists(join(where.data, RESET_MARKER)), false);
});

test('a table folder without any version manifest is moved aside without asking LanceDB', async t => {
  const where = await home(t);
  await mkdir(join(where.table, 'data'), { recursive: true });
  const { calls, check } = counting();
  const result = await healIndex({ home: where.dir, lancedb: () => lanceUrl ?? 'x', check, now: () => new Date('2026-10-23T10:00:00Z') });
  assert.equal(result.reset.reason, 'no-versions');
  assert.equal(calls.length, 0);
  assert.equal(await exists(where.table), false);
  assert.equal(result.reset.movedTo, `${where.table}.broken-20261023T100000Z`);
  assert.ok(await exists(join(result.reset.movedTo, 'data')), 'moved whole, nothing deleted');
});

test('a good table stays, and is not opened again while its newest manifest is the one that passed', real, async t => {
  const where = await home(t);
  await fixture(where, 'good');
  const { calls, check } = counting();
  assert.deepEqual(await healIndex({ home: where.dir, lancedb: () => lanceUrl, check }), {});
  assert.equal(calls.length, 1);
  assert.equal(await exists(where.table), true);
  assert.equal(await exists(join(where.data, RESET_MARKER)), false);
  assert.deepEqual(await healIndex({ home: where.dir, lancedb: () => lanceUrl, check }), {});
  assert.equal(calls.length, 1, 'the second start trusts the first check: same newest manifest');
});

test('the failure of 2026-10-12: the newest manifest is all zeros; the table is moved aside and reset.json says when, why and where', real, async t => {
  const where = await home(t);
  await fixture(where, 'good');
  await zeroNewest(where.table);
  const read = await inspectWithLanceDB({ dbPath: where.db, lancedb: lanceUrl });
  assert.notEqual(read.verdict, 'ok', `LanceDB cannot use it either: ${JSON.stringify(read)}`);
  const { calls, check } = counting();
  const warned = [];
  const result = await healIndex({ home: where.dir, lancedb: () => lanceUrl, check, warn: line => warned.push(line), now: () => new Date('2026-10-23T11:00:00Z') });
  assert.equal(calls.length, 0, 'the files alone say it is broken');
  assert.deepEqual(result.reset, { at: '2026-10-23T11:00:00.000Z', reason: 'torn-manifest', movedTo: `${where.table}.broken-20261023T110000Z` });
  assert.deepEqual(await marker(where), result.reset);
  assert.equal(await exists(where.table), false);
  assert.ok((await readdir(join(result.reset.movedTo, '_versions'))).length > 0, 'the broken table is kept as it was');
  assert.match(warned.join('\n'), /moved to/);
});

test('a table that opens with no text field (what LanceDB reads from that table) is moved aside', real, async t => {
  const where = await home(t);
  await fixture(where, 'empty');
  assert.equal((await inspectFiles(where.table)).verdict, 'ok', 'its files look whole');
  const verdict = await inspectWithLanceDB({ dbPath: where.db, lancedb: lanceUrl });
  assert.equal(verdict.verdict, 'no-text-field');
  const result = await healIndex({ home: where.dir, lancedb: () => lanceUrl });
  assert.equal(result.reset.reason, 'no-text-field');
  assert.equal(await exists(where.table), false);
  assert.equal(await exists(result.reset.movedTo), true);
});

test('when the check cannot decide (no LanceDB, or it fails), the table is left where it is', real, async t => {
  const where = await home(t);
  await fixture(where, 'empty');
  assert.deepEqual(await healIndex({ home: where.dir, lancedb: () => { throw new Error('cannot find LanceDB'); } }), {});
  assert.deepEqual(await healIndex({ home: where.dir, lancedb: () => 'file:///nowhere/lancedb.js' }), {});
  assert.deepEqual(await healIndex({ home: where.dir, lancedb: () => lanceUrl, check: async () => { throw new Error('boom'); } }), {}, 'never throws');
  assert.equal(await exists(where.table), true);
  assert.equal(await exists(join(where.data, RESET_MARKER)), false);
});

test('mount: the broken table is moved aside before the server is mounted, and the server is mounted as usual', real, async t => {
  const where = await home(t);
  await fixture(where, 'empty');
  const order = [];
  const ctx = { plugin: (client, config) => { order.push(['plugin', config.env.DB_PATH]); } };
  const result = await mount(ctx, { home: where.dir, execPath: process.execPath, node: '24.21.0', electron: false, loadClient: async () => ({ name: 'mcp' }),
    warn: line => order.push(['warn', line]) });
  assert.equal(result.mounted, true);
  assert.equal(result.reset.reason, 'no-text-field');
  assert.deepEqual(order.map(([kind]) => kind), ['warn', 'plugin'], 'checked first, then mounted');
  assert.equal(order[1][1], where.db, 'the server opens the same folder, now without the broken table');
  assert.equal(await exists(where.table), false);
  const healthy = await mount(ctx, { home: where.dir, execPath: process.execPath, node: '24.21.0', loadClient: async () => ({}), warn() {} });
  assert.deepEqual(healthy, { mounted: true }, 'nothing left to move');
});

test('the extension ships its check', async () => {
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  for (const file of ['heal.js', 'check-index.mjs']) assert.ok(manifest.files.includes(file), file);
});
