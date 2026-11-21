import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { Store } from '../lib/store.js';
import { canonicalPathKey } from '../lib/store-lock.js';
import { atomicJson, atomicWriteFile } from '../lib/atomic-json.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { originalStatus, readOriginal, rehashStats } from '../lib/contexts/materials/original-file.js';
import { sectionsOf } from '../lib/sections.js';
import { createLocator, locateQuote } from '../lib/quote-locate.js';
import { StudyRuntime } from '../lib/runtime.js';
import { validate } from '../lib/runtime/schema.js';
import { jobArchive } from '../lib/job-archive.js';
import { saveBinding } from '../lib/host.js';
import { retrievalRootId, saveRetrievalSettings, readRetrievalSettings } from '../lib/retrieval-settings.js';
import {
  INDEX_LOCK_DEFAULTS,
  INDEX_TOOLS,
  buildIndex,
  indexLockPath,
  manifestPath,
  readManifest,
  retrievalHome,
  withIndexLock,
  writeManifest,
} from '../lib/retrieval-index.js';

async function materialsFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'docs-store-p0-mat-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new Store(root);
  const ops = createMaterialsOperations({
    root,
    read: async () => {
      const state = await store.read();
      return structuredClone({ sources: state.sources, documents: state.documents || [] });
    },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own);
      state.sources = own.sources;
      state.documents = own.documents;
      return result;
    }),
  });
  return { root, store, call: (action, args = {}) => ops.handlers[action](args, {}) };
}

/* ---------- 1. Plain .md import preserves headings, code fences & LaTeX ---------- */

test('plain .md import preserves headings, code fences, tables, and LaTeX formulas with md2 revision tag', async t => {
  const { call } = await materialsFixture(t);
  const markdown = [
    '\uFEFF# Chapter 1: Linear Algebra',
    '',
    'Inline formula \\(x + y = z\\) and display formula \\[E = mc^2\\].',
    '',
    '## Matrix & Set Notation',
    '',
    '$$',
    '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}, \\quad \\{x \\in \\mathbb{R} \\mid a_i * b_j > 0\\}',
    '$$',
    '',
    '```python',
    'def dot(u, v):',
    '    return sum(a * b for a, b in zip(u, v))',
    '```',
    '',
  ].join('\r\n');

  const imported = await call('materials.document.import', {
    filename: 'linear-algebra.md',
    dataBase64: Buffer.from(markdown, 'utf8').toString('base64'),
  });
  assert.ok(imported.revision.endsWith('-md-md2'), 'plain .md uses upgraded md2 revision suffix');

  const doc = await call('materials.document.get', { id: imported.documentId });
  const text = doc.sources[0].text;
  assert.ok(text.startsWith('# Chapter 1: Linear Algebra\n\n'), 'H1 heading and blank lines preserved');
  assert.ok(text.includes('## Matrix & Set Notation'), 'H2 heading preserved');
  assert.ok(text.includes('\\(x + y = z\\)'), 'inline \\(...\\) delimiters preserved');
  assert.ok(text.includes('\\[E = mc^2\\]'), 'display \\[...\\] delimiters preserved');
  assert.ok(text.includes('\\\\'), 'double-backslash matrix newline preserved');
  assert.ok(text.includes('\\{x \\in \\mathbb{R} \\mid a_i * b_j > 0\\}'), 'set braces and math underscores/asterisks preserved');
  assert.ok(text.includes('```python\ndef dot(u, v):'), 'fenced code block preserved');

  // Heading structure enables real Markdown sectioning instead of fixed-window slicing.
  const sections = sectionsOf([doc.sources[0]]);
  assert.ok(sections.length >= 2 && sections.every(s => s.kind === 'heading'), 'extracts Markdown heading sections instead of fixed windows');
  assert.deepEqual(sections.map(s => s.title), ['Chapter 1: Linear Algebra', 'Matrix & Set Notation']);

  // Idempotent re-import produces the exact same revision and adds 0 new sources.
  const again = await call('materials.document.import', {
    filename: 'linear-algebra.md',
    dataBase64: Buffer.from(markdown, 'utf8').toString('base64'),
  });
  assert.equal(again.revision, imported.revision);
  assert.equal(again.added, 0);
});

/* ---------- 2. Copy original stat/LRU/queue & single-pass readOriginal ---------- */

test('library copy status respects deep: false, caches mtime re-hashes via serial queue, and readOriginal hashes once', async t => {
  const { root, store, call } = await materialsFixture(t);
  const docs = [];
  for (let i = 0; i < 6; i++) {
    const body = Buffer.from(`# Lecture ${i}\n\n${'Material content line. '.repeat(200)}\n`, 'utf8');
    docs.push(await call('materials.document.import', {
      filename: `lecture-${i}.md`,
      dataBase64: body.toString('base64'),
    }));
  }

  // Listing all retained copies must NOT trigger full-file SHA-256 hashes (deep: false).
  const beforeList = rehashStats().hashes;
  const listed = await call('materials.document.list', { limit: 50 });
  assert.equal(listed.documents.length, 6);
  assert.ok(listed.documents.every(d => d.originalAvailable && d.original.mode === 'copy' && d.original.status === 'ok'));
  assert.equal(rehashStats().hashes - beforeList, 0, 'listMaterialDocuments uses stat-only check for copies');

  // Touching mtime on two copies triggers at most 1 rehash per file (serialized, deduplicated across concurrent calls).
  const state = await store.read();
  const v0 = state.documents[0].versions[0];
  const v1 = state.documents[1].versions[0];
  const p0 = join(root, v0.attachment.path);
  const p1 = join(root, v1.attachment.path);
  const future = new Date(Date.now() + 60_000);
  await utimes(p0, future, future);
  await utimes(p1, future, future);

  const beforeTouch = rehashStats().hashes;
  const results = await Promise.all([
    originalStatus(root, v0),
    originalStatus(root, v0),
    originalStatus(root, v1),
    originalStatus(root, v1),
  ]);
  assert.ok(results.every(r => r.status === 'ok'));
  assert.equal(rehashStats().hashes - beforeTouch, 2, 'one queued hash per mtime-changed copy');
  assert.equal(rehashStats().peak, 1, 'copies are never hashed in parallel');

  // Subsequent checks hit the LRU cache without re-hashing.
  assert.equal((await originalStatus(root, v0)).status, 'ok');
  assert.equal(rehashStats().hashes - beforeTouch, 2);

  // readOriginal verifies bytes in a single pass (does NOT invoke copyIntact full hash first).
  const beforeRead = rehashStats().hashes;
  const readRes = await readOriginal(root, v0);
  assert.equal(readRes.status, 'ok');
  assert.equal(readRes.mode, 'copy');
  assert.equal(rehashStats().hashes - beforeRead, 0, 'readOriginal does not double-hash via copyIntact');

  // Same-size tampering with updated mtime is detected by both deep: false and deep: true, and rejected by readOriginal.
  const originalBytes = await readFile(p0);
  const tampered = Buffer.from(originalBytes);
  tampered[tampered.length - 5] ^= 0x01;
  await writeFile(p0, tampered);
  await utimes(p0, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
  assert.equal((await originalStatus(root, v0, { deep: false })).status, 'missing');
  assert.equal((await originalStatus(root, v0, { deep: true })).status, 'missing');
  assert.equal((await readOriginal(root, v0)).status, 'unavailable');
});

/* ---------- 3. quote-locate.js UTF-16 alignment with non-BMP chars ---------- */

test('quote-locate aligns UTF-16 offsets across CJK Extension B and Emoji without drift or end:NaN', () => {
  // Non-BMP CJK Ext B (𠮷 U+20BB7, 𠀀 U+20000) + Emoji (🚀🎉) before, inside, and at the end.
  const text = '前缀🚀𠮷测试𠀀中间段落：虚拟内存分页机制非常关键，结尾字𠮷';
  const locator = createLocator(text);

  // 1. Quote AFTER non-BMP characters (with whitespace forcing key index lookup).
  const after = locator('虚拟内存 分页机制 非常关键');
  assert.ok(after);
  assert.equal(Number.isNaN(after.end), false);
  assert.equal(text.slice(after.start, after.end), '虚拟内存分页机制非常关键');

  // 2. Quote CONTAINING and ENDING on a trailing non-BMP surrogate pair (previously produced end: NaN).
  const tail = locator('非常关键 结尾字 𠮷');
  assert.ok(tail);
  assert.equal(Number.isInteger(tail.start) && Number.isInteger(tail.end), true);
  assert.equal(text.slice(tail.start, tail.end), '非常关键，结尾字𠮷');

  // 3. Quote STARTING with a non-BMP character.
  const head = locator('𠮷 测试 𠀀 中间段落');
  assert.ok(head);
  assert.equal(text.slice(head.start, head.end), '𠮷测试𠀀中间段落');

  // 4. Elided quote spanning across Emoji and CJK Extension B characters.
  const elided = locator('𠮷 测试 𠀀 中间段落 … 非常关键 结尾字 𠮷');
  assert.ok(elided);
  assert.equal(text.slice(elided.start, elided.end), '𠮷测试𠀀中间段落：虚拟内存分页机制非常关键，结尾字𠮷');

  // 5. MIN_KEY counts Unicode code points (3 non-BMP chars != 6 chars).
  assert.equal(locateQuote('abc 𠮷𠀀𠀁 def', '𠮷 𠀀 𠀁'), null);
});

/* ---------- 4. atomic-json, Store safe reuse, dynamic GC & path normalization ---------- */

test('atomicWriteFile supports fsync, retries Windows EPERM/EBUSY, and cleans up .tmp on failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'docs-store-p0-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'nested', 'data.json');

  // Retries transient EBUSY twice then succeeds with fsync.
  let attempts = 0;
  const { rename } = await import('node:fs/promises');
  await atomicJson(target, { ok: true, n: 1 }, {
    ensureDir: true,
    sync: true,
    space: 2,
    trailingNewline: true,
    wait: async () => {},
    rename: async (from, to) => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return rename(from, to);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { ok: true, n: 1 });
  assert.deepEqual(await readdir(join(dir, 'nested')), ['data.json'], 'no .tmp left behind after retry success');

  // Cleans up temp file when rename permanently fails.
  await assert.rejects(
    atomicWriteFile(target, 'broken', {
      sync: true,
      tries: 2,
      wait: async () => {},
      rename: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
    }),
    /locked/,
  );
  assert.deepEqual(await readdir(join(dir, 'nested')), ['data.json'], 'no .tmp left behind after failure');
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { ok: true, n: 1 }, 'original file untouched');
});

test('Store safe shard reuse handles reordering and never silently drops updates omitted from changed hint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-store-p0-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update(state => {
    state.decks = [
      { id: 'd1', title: 'First', cards: [] },
      { id: 'd2', title: 'Second', cards: [] },
      { id: 'd3', title: 'Third', cards: [] },
    ];
  });

  // 1. Reorder + replace d3 even though changed hint only names d1: d3 update must NOT be dropped.
  await store.update(
    state => {
      const [d1, d2, d3] = state.decks;
      d1.title = 'First-Updated';
      state.decks = [{ ...d3, title: 'Third-Replaced' }, d2, d1];
    },
    { decks: new Set(['d1']) },
    { reads: ['decks'], writes: ['decks'] },
  );
  const after = await new Store(root).read();
  assert.deepEqual(after.decks.map(d => [d.id, d.title]), [
    ['d3', 'Third-Replaced'],
    ['d2', 'Second'],
    ['d1', 'First-Updated'],
  ]);

  // 2. Under STUDY_STORE_PRIVATE=1 (mutable copies), mutating d2 without listing d2 in `changed` still persists.
  const prevPrivate = process.env.STUDY_STORE_PRIVATE;
  process.env.STUDY_STORE_PRIVATE = '1';
  t.after(() => { if (prevPrivate === undefined) delete process.env.STUDY_STORE_PRIVATE; else process.env.STUDY_STORE_PRIVATE = prevPrivate; });
  await store.update(
    state => {
      state.decks.find(d => d.id === 'd2').title = 'Second-Private-Mutated';
    },
    { decks: new Set(['d1']) },
    { reads: ['decks'], writes: ['decks'] },
  );
  const afterPrivate = await new Store(root).read();
  assert.equal(afterPrivate.decks.find(d => d.id === 'd2').title, 'Second-Private-Mutated');
});

test('Store.collect sweeps orphan shards in dynamically registered collections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-store-p0-gc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.registerCollection('customNotes', { mode: 'item' });
  await store.update(state => {
    state.customNotes = [{ id: 'n1', body: 'live note' }];
  });

  const orphanDir = join(root, 'shards', 'customNotes');
  const orphanFile = join(orphanDir, 'ghost.0123456789abcdef0123.json');
  await writeFile(orphanFile, '{"id":"ghost"}', 'utf8');
  assert.ok((await readdir(orphanDir)).includes('ghost.0123456789abcdef0123.json'));

  const current = await store.load();
  await store.collect(current.files, current, { sweep: true });
  const remaining = await readdir(orphanDir);
  assert.equal(remaining.includes('ghost.0123456789abcdef0123.json'), false, 'orphan shard in dynamic collection was swept');
  assert.equal(remaining.length, 1, 'live shard remains untouched');
});

test('Windows path normalization unifies Store cache, jobArchive, host binding, and retrieval settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-store-p0-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const altRoot = process.platform === 'win32'
    ? root.toUpperCase().replaceAll('\\', '/') + '/'
    : `${root}/./`;
  assert.equal(canonicalPathKey(root), canonicalPathKey(altRoot));
  assert.equal(jobArchive(root), jobArchive(altRoot), 'jobArchive shares one instance across path variants');
  assert.equal(retrievalRootId(root), retrievalRootId(altRoot), 'retrievalRootId matches across path variants');

  // Store cache is unified across path casing/separator variants.
  const storeA = new Store(root);
  const storeB = new Store(altRoot);
  await storeA.update(state => { state.sources.push({ id: 's1', title: 'T', text: 'Body' }); });
  assert.equal(storeB.cacheStats().cached, true, 'second Store with variant path hits the same cache entry');

  // Converged atomic writers leave no .tmp files.
  const savedBinding = await saveBinding(root, { root, provider: '', model: '' });
  assert.equal(savedBinding.root, root);
  assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp')));

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh-home');
  t.after(() => { if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome; });
  await saveRetrievalSettings({ provider: 'builtin' });
  assert.equal((await readRetrievalSettings()).provider, 'builtin');
});

/* ---------- 5. Symmetric .index.lock mutex in lib/retrieval-index.js ---------- */

test('retrieval-index coordinates writes/updates/deletes with <studyHome>/retrieval/.index.lock', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'docs-store-p0-index-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  t.after(() => { if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome; });

  const expectedLock = join(retrievalHome(), '.index.lock');
  assert.equal(indexLockPath(), expectedLock);
  assert.equal(INDEX_LOCK_DEFAULTS.stale, 30_000);
  assert.equal(INDEX_LOCK_DEFAULTS.update, 10_000);
  assert.ok(INDEX_LOCK_DEFAULTS.retries.retries >= 30);

  // Hold the exact same .index.lock as Desktop does via proper-lockfile.
  await mkdir(retrievalHome(), { recursive: true });
  const release = await lockfile.lock(retrievalHome(), {
    lockfilePath: expectedLock,
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: 0,
  });

  const port = {
    tools: () => Object.values(INDEX_TOOLS).map(name => ({ name })),
    call: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  };
  const libRoot = join(dir, 'library');
  const shortRetry = { retries: { retries: 1, minTimeout: 10, maxTimeout: 20 } };

  try {
    await assert.rejects(
      buildIndex({
        port,
        sources: [{ id: 'p1', title: 'P1', text: 'content for indexing' }],
        library: ['p1'],
        manifest: { sources: {} },
        lockOptions: shortRetry,
      }),
      error => error?.code === 'retrieval-index-locked',
    );
    await assert.rejects(
      writeManifest(libRoot, { sources: {} }, { lockOptions: shortRetry }),
      error => error?.code === 'retrieval-index-locked',
    );
  } finally {
    await release();
  }

  // Once released, buildIndex + re-entrant writeManifest inside save succeeds without deadlocking.
  const manifest = { sources: {} };
  const summary = await buildIndex({
    port,
    sources: [{ id: 'p1', title: 'P1', text: 'content for indexing' }],
    library: ['p1'],
    manifest,
    save: value => writeManifest(libRoot, value),
  });
  assert.equal(summary.added, 1);
  assert.ok((await readManifest(libRoot)).sources.p1);
  assert.ok((await stat(manifestPath(libRoot))).isFile());

  // Concurrent withIndexLock calls serialize cleanly without overlapping.
  let active = 0, peak = 0;
  await Promise.all([1, 2, 3].map(() => withIndexLock(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
  })));
  assert.equal(peak, 1);
});

/* ---------- 6. Runtime isDeepStrictEqual & Schema omitted-type enforcement ---------- */

test('StudyRuntime uses node:util isDeepStrictEqual (no key-order false positives, catches undefined/NaN changes)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-store-p0-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prevPrivate = process.env.STUDY_STORE_PRIVATE;
  process.env.STUDY_STORE_PRIVATE = '1';
  t.after(() => { if (prevPrivate === undefined) delete process.env.STUDY_STORE_PRIVATE; else process.env.STUDY_STORE_PRIVATE = prevPrivate; });

  const runtime = new StudyRuntime(root);
  t.after(() => runtime.dispose());

  runtime.register({
    id: 'probe',
    version: 1,
    fields: ['settings', 'notes'],
    writes: {
      reorderOnly: ['notes'],
      addUndefined: ['notes'],
    },
    mutate(op, state) {
      if (op === 'reorderOnly') {
        // Reconstruct read-only object with identical values in different key order: must NOT throw.
        const entries = Object.entries(state.settings).reverse();
        state.settings = Object.fromEntries(entries);
        state.notes.push({ id: 'n1' });
        return { ok: true };
      }
      if (op === 'addUndefined') {
        // Adding an explicit undefined key is a real mutation (JSON.stringify previously missed this!).
        state.settings.sneaky = undefined;
        return { ok: true };
      }
      return { ok: false };
    },
    operations: {
      testReorder: {
        execute: (_args, ctx) => ctx.transaction(state => ctx.mutate('probe.v1', 'reorderOnly', state, {}), [], ['notes']),
      },
      testUndefined: {
        execute: (_args, ctx) => ctx.transaction(state => ctx.mutate('probe.v1', 'addUndefined', state, {}), [], ['notes']),
      },
      testTxReorder: {
        execute: (_args, ctx) => ctx.transaction(state => {
          state.settings = Object.fromEntries(Object.entries(state.settings).reverse());
          state.notes.push({ id: 'n2' });
          return { ok: true };
        }, [], ['notes']),
      },
    },
  });

  assert.deepEqual(await runtime.invoke('probe.v1', 'testReorder', {}), { ok: true });
  assert.deepEqual(await runtime.invoke('probe.v1', 'testTxReorder', {}), { ok: true });
  await assert.rejects(
    runtime.invoke('probe.v1', 'testUndefined', {}),
    /State field settings is read-only/,
  );
});

test('runtime schema enforces required, properties, additionalProperties and items even when type is omitted', () => {
  const objSchema = {
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };
  assert.doesNotThrow(() => validate({ id: 'ok' }, objSchema));
  assert.doesNotThrow(() => validate('non-object-passes-kind-scoped-rule', objSchema));
  assert.throws(() => validate({}, objSchema), /arguments\.id is required/);
  assert.throws(() => validate({ id: 123 }, objSchema), /arguments\.id must be string/);
  assert.throws(() => validate({ id: 'ok', extra: true }, objSchema), /arguments\.extra is not supported/);

  const arrSchema = { items: { type: 'integer', minimum: 1 } };
  assert.doesNotThrow(() => validate([1, 2, 3], arrSchema));
  assert.doesNotThrow(() => validate('not-array', arrSchema));
  assert.throws(() => validate([1, 'bad'], arrSchema), /arguments\[1\] must be integer/);
  assert.throws(() => validate([0], arrSchema), /arguments\[0\] must be at least 1/);
});
