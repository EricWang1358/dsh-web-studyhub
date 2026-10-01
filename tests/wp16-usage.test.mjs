import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WP16 item 2: how much disk the library uses, counted asynchronously.
const usage = await import('../lib/library-usage.js');
const host = await import('../lib/host.js');

const tmp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wp16u-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const put = async (root, path, size) => {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, Buffer.alloc(size, 1));
};
const byId = (result) => Object.fromEntries(result.parts.map((part) => [part.id, part]));

async function fixture(t) {
  const root = await tmp(t);
  await put(root, 'study-workspace.json', 100);
  await put(root, 'shards/sources/s1.hash.json', 200);
  await put(root, 'shards/decks/d1.hash.json', 300);
  await put(root, 'shards/misc/notes.hash.json', 50);
  await put(root, 'attachments/materials/abc.pdf', 1000);
  await put(root, 'audio-batches/b1/input.m4a', 400);
  await put(root, 'audio-cache/c1/part.json', 10);
  await put(root, 'audio-uploads/u1/file.mp3', 20);
  await put(root, 'live/session.json', 30);
  await put(root, 'backups/study-workspace-v1-1.json', 500);
  await put(root, 'notes.txt', 7);
  return root;
}

test('the library is split into the categories of the real store layout', async (t) => {
  const result = await usage.measureLibrary(await fixture(t));
  const parts = byId(result);
  assert.deepEqual(result.parts.map((part) => part.id), ['materials', 'audio', 'bank', 'backups', 'other']);
  assert.deepEqual(result.parts.map((part) => part.label), ['资料原文与提取文字', '音频与转写', '题库与复习记录', '备份', '其他']);
  assert.equal(parts.materials.bytes, 1200, 'attachments + extracted source text');
  assert.equal(parts.materials.files, 2);
  assert.equal(parts.audio.bytes, 460);
  assert.equal(parts.audio.files, 4);
  assert.equal(parts.bank.bytes, 450, 'manifest + every shard except sources');
  assert.equal(parts.backups.bytes, 500);
  assert.equal(parts.other.bytes, 7);
  assert.equal(result.total, 1200 + 460 + 450 + 500 + 7);
  assert.ok(!result.partial);
  assert.ok(Number.isFinite(Date.parse(result.computedAt)));
  assert.equal(result.paths.backups, join(result.root, 'backups'));
});

test('an empty or missing library is zero, never an error', async (t) => {
  const root = await tmp(t);
  const empty = await usage.measureLibrary(root);
  assert.equal(empty.total, 0);
  assert.equal(empty.parts.length, 5);
  const missing = await usage.measureLibrary(join(root, 'nope'));
  assert.equal(missing.total, 0);
});

test('a library that is the project workspace counts only its own folders', async (t) => {
  const root = await fixture(t);
  await put(root, 'package.json', 5000);
  await put(root, 'src/app.js', 7000);
  const result = await usage.measureLibrary(root);
  assert.equal(byId(result).other.bytes, 0, 'unknown files of a project are not the library');
  assert.equal(result.total, 1200 + 460 + 450 + 500);
});

test('symbolic links are never followed', async (t) => {
  const root = await tmp(t), outside = await tmp(t);
  await put(root, 'backups/b.json', 10);
  await put(outside, 'huge.bin', 100000);
  // A junction needs no privilege on Windows; a file symlink may be refused there and is then simply not part of the check.
  try { await symlink(outside, join(root, 'audio-cache'), 'junction'); }
  catch (error) { t.skip(`cannot create links here: ${error.code}`); return; }
  await symlink(join(outside, 'huge.bin'), join(root, 'live.bin'), 'file').catch(() => {});
  const result = await usage.measureLibrary(root);
  assert.equal(result.total, 10);
});

test('a huge tree stops at its entry budget and says so', async (t) => {
  const root = await tmp(t);
  for (let i = 0; i < 30; i++) await put(root, `backups/b${i}.json`, 10);
  const full = await usage.measureLibrary(root);
  assert.equal(full.total, 300);
  assert.ok(!full.partial);
  const cut = await usage.measureLibrary(root, { maxEntries: 12 });
  assert.equal(cut.partial, true);
  assert.ok(cut.total > 0 && cut.total < 300, `counted what it saw (${cut.total})`);
});

test('a slow walk stops at its time budget and says so', async (t) => {
  const root = await tmp(t);
  for (let i = 0; i < 30; i++) await put(root, `backups/b${i}.json`, 10);
  let clock = 0;
  const cut = await usage.measureLibrary(root, { budgetMs: 50, now: () => (clock += 20) });
  assert.equal(cut.partial, true);
});

test('measuring never blocks the event loop', async (t) => {
  const root = await tmp(t);
  for (let d = 0; d < 40; d++) await put(root, `shards/decks/d${d}/card.json`, 10);
  const order = [];
  const done = usage.measureLibrary(root).then(() => order.push('done'));
  setImmediate(() => order.push('tick'));
  await done;
  assert.equal(order[0], 'tick', 'other work ran while the walk was in progress');
});

const fake = (counter = { runs: 0 }, gate) => async (root) => {
  counter.runs++;
  if (gate) await gate;
  return { root, total: counter.runs, parts: [], computedAt: new Date().toISOString() };
};

test('concurrent requests for one library share one walk', async () => {
  const counter = { runs: 0 };
  let release;
  const service = usage.createUsageService({ measure: fake(counter, new Promise((resolve) => { release = resolve; })) });
  const first = service.usage('/lib'), second = service.usage('/lib');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(counter.runs, 1);
  assert.equal(a, b);
});

test('a result is cached until it is forced, invalidated or too old', async () => {
  const counter = { runs: 0 };
  let clock = 1000;
  const service = usage.createUsageService({ measure: fake(counter), ttlMs: 60000, now: () => clock });
  assert.equal((await service.usage('/lib')).total, 1);
  assert.equal((await service.usage('/lib')).total, 1, 'served from cache');
  assert.equal((await service.usage('/lib', { force: true })).total, 2, 'force measures again');
  assert.equal((await service.usage('/lib')).total, 2);
  service.invalidate('/lib');
  assert.equal((await service.usage('/lib')).total, 3, 'invalidated after a change');
  clock += 61000;
  assert.equal((await service.usage('/lib')).total, 4, 'expired');
  assert.equal((await service.usage('/other')).total, 5, 'each library has its own entry');
  assert.equal((await service.usage('/lib')).total, 4);
});

test('a failed walk is not cached and the next request tries again', async () => {
  let runs = 0;
  const service = usage.createUsageService({ measure: async () => { if (++runs === 1) throw new Error('disk gone'); return { total: 9, parts: [] }; } });
  await assert.rejects(service.usage('/lib'), /disk gone/);
  assert.equal((await service.usage('/lib')).total, 9);
});

test('invalidating while a walk is running drops that stale result', async () => {
  let runs = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = usage.createUsageService({ measure: async () => { const n = ++runs; if (n === 1) await gate; return { total: n, parts: [] }; } });
  const early = service.usage('/lib');
  service.invalidate('/lib');
  release();
  await early;
  assert.equal((await service.usage('/lib')).total, 2, 'the walk that began before the change is not trusted');
});

// -- host action -----------------------------------------------------------
const CWD = { value: '' };
const ctx = () => ({ sessions: { get: () => ({ header: { cwd: CWD.value } }) }, get: () => undefined });
const handler = host.createHostHandler(ctx(), {}, undefined);
const call = (action, args = {}) => handler('call', { sessionId: 's', action, args });

test('library.usage walks the bound library and reuses the answer until something changes', async (t) => {
  CWD.value = await tmp(t);
  const root = await host.workspaceLibrary(CWD.value);
  await put(root, 'backups/b.json', 40);
  const first = await call('library.usage');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.total, 40);
  assert.equal(first.value.root, root);
  await put(root, 'backups/c.json', 60);
  assert.equal((await call('library.usage')).value.total, 40, 'cached');
  assert.equal((await call('library.usage', { force: true })).value.total, 100, 'force recounts');
  await put(root, 'backups/d.json', 100);
  assert.equal((await call('library.usage')).value.total, 100, 'cached again');
  assert.equal((await call('settings', {})).ok, true);
  assert.equal((await call('library.usage')).value.total, 200, 'a change to the library invalidates the answer');
});
