import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { LATEST_VERSION } from '../lib/store.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { changesLibrary } from '../lib/library-usage.js';
import { groupSourcesByDocument, sanitizePathHint } from '../lib/source-groups.js';
import {
  MAX_FOLDERS,
  MAX_FOLDER_NAME_CHARS,
  materialFormatGroup,
  materialKindOf,
} from '../lib/contexts/materials/material-folders.js';
import {
  FOLDER_SUGGEST_BATCH,
  buildCompactDescriptor,
  normalizeMaxFolders,
  parseBatchReply,
  parseTaxonomyReply,
} from '../lib/contexts/materials/folder-suggest.js';

const HAN_RE = /[\u3400-\u9fff]/;

async function createTempService(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-classify-backend-'));
  const service = new StudyService(root, options);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, service };
}

/* ---------- 1. Path sanitization, source-groups optional fields & deterministic facets ---------- */

test('sanitizePathHint strips OS usernames, drive roots, UNC shares, and system dirs while preserving 1–2 topic segments', () => {
  assert.equal(
    sanitizePathHint('D:\\A\\1NUS\\resume-workshop\\八股项目\\javaguide\\docs\\cs-basics\\network\\tcp.md'),
    'cs-basics/network',
  );
  assert.equal(
    sanitizePathHint('/Users/ericsecret/workspace/advanced-java/docs/high-concurrency/redis-lock.md'),
    'advanced-java/high-concurrency',
  );
  assert.equal(
    sanitizePathHint('C:\\Users\\Eric1\\Desktop\\notes.md'),
    '',
    'never leaks OS username or Desktop',
  );
  assert.equal(
    sanitizePathHint('C:\\Users\\Eric1\\AppData\\Local\\Temp\\draft.md'),
    '',
    'never leaks AppData or Temp',
  );
  assert.equal(
    sanitizePathHint('/home/alice/Downloads/paper.pdf'),
    '',
    'never leaks Linux home username',
  );
  assert.equal(
    sanitizePathHint('\\\\fileserver\\share\\Users\\bob\\Documents\\secret.docx'),
    '',
    'never leaks UNC server/share or username',
  );
  assert.equal(
    sanitizePathHint('D:\\workspace\\.dsh-study\\attachments\\' + 'a'.repeat(64) + '\\doc.pdf'),
    'workspace',
  );
  assert.equal(
    sanitizePathHint('Python基础/交互课件/02-环境搭建/_source.md'),
    '交互课件/02-环境搭建',
  );
  assert.equal(sanitizePathHint('standalone-file.md'), '');
  assert.equal(sanitizePathHint(''), '');
});

test('groupSourcesByDocument exposes optional live, companion, and sanitized pathHint without altering plain items', () => {
  const plain = { id: 's-plain', title: 'TCP Handshake', text: '# TCP\nSYN, SYN-ACK, ACK.', courses: ['Net'] };
  const liveNote = { id: 's-live', title: 'AI全栈 · 课堂笔记', text: 'live notes', live: true, courses: ['AI'] };
  const companionSrc = { id: 's-comp', title: '环境搭建课件', text: 'slides', companionId: 'comp-1', courses: ['Py'] };
  const docId = 'document-' + 'd'.repeat(64) + '-md';
  const extSource = {
    id: `${docId}-s1`,
    title: 'mysql-index.md',
    text: '# B+Tree 索引\n聚簇索引与二级索引。',
    courses: ['Java 八股'],
    document: { materialId: docId, materialRevision: 'rev1', format: 'md', filename: 'mysql-index.md' },
  };
  const documents = [
    {
      id: docId,
      format: 'md',
      filename: 'mysql-index.md',
      title: 'mysql-index.md',
      currentRevision: 'rev1',
      externalPath: 'C:\\Users\\SecretUser\\javaguide\\docs\\database\\mysql\\mysql-index.md',
      versions: [{ revision: 'rev1', sourceIds: [extSource.id] }],
    },
  ];

  const grouped = groupSourcesByDocument([plain, liveNote, companionSrc, extSource], { documents });
  assert.equal(grouped.length, 4);
  assert.equal('live' in grouped[0], false);
  assert.equal('companion' in grouped[0], false);
  assert.equal('pathHint' in grouped[0], false);

  assert.equal(grouped[1].live, true);
  assert.equal(materialKindOf(grouped[1]), 'note');

  assert.equal(grouped[2].companion, true);
  assert.equal(materialKindOf(grouped[2]), 'courseware');

  assert.equal(grouped[3].pathHint, 'database/mysql');
  assert.ok(!grouped[3].pathHint.includes('SecretUser'));
  assert.equal(materialKindOf(grouped[3]), 'article');
  assert.equal(materialFormatGroup(grouped[3]), 'md');

  assert.equal(
    materialKindOf({ format: 'json', title: 'JSON 导入：Java 并发', provenance: 'json-card-self-reference' }),
    'question-bank',
  );
  assert.equal(
    materialKindOf({ format: 'pdf', title: 'Java架构师指南', converted: 'mineru', totalPages: 415 }),
    'book',
  );
  assert.equal(
    materialKindOf({ format: 'audio', title: '中英对照逐字稿' }),
    'transcript',
  );
  assert.equal(
    materialKindOf({ format: 'pdf', title: '2025 期末真题试卷', totalPages: 8 }),
    'exam',
  );
});

/* ---------- 2. Domain contracts, read-only invariants & model readiness ---------- */

test('domain contracts: source.folder.apply writes only settings; source.folder.suggest is strictly read-only and supports offline estimate', async (t) => {
  assert.deepEqual(writesFor('materials', 'source.folder.apply'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.folder.suggest'), []);
  assert.equal(changesLibrary('source.folder.apply'), true);
  assert.equal(changesLibrary('source.folder.suggest'), false);
  assert.equal(normalizeMaxFolders(undefined), 12);
  assert.equal(normalizeMaxFolders(1), 3);
  assert.equal(normalizeMaxFolders(99), 24);

  const { service } = await createTempService(t);
  await service.call('source.add', { id: 's1', title: 'JVM 垃圾回收', text: '# GC\nG1 与 ZGC', courses: ['Java 八股'] });
  await service.call('source.add', { id: 's2', title: 'Redis 持久化', text: '# RDB 与 AOF\n持久化对比', courses: ['Java 八股'] });

  // Without a model connected, non-estimate suggest returns model_unavailable
  const refused = await service.call('source.folder.suggest', { course: 'Java 八股' });
  assert.equal(refused.available, false);
  assert.equal(refused.reason, 'model_unavailable');

  // With estimate:true, suggest runs without a model and leaves revision unchanged
  const beforeSnap = await service.call('snapshot');
  const estimate = await service.call('source.folder.suggest', { course: 'Java 八股', estimate: true });
  assert.equal(estimate.itemCount, 2);
  assert.equal(estimate.batchCount, 1);
  assert.ok(Number.isInteger(estimate.estimatedInputTokens) && estimate.estimatedInputTokens > 0);
  assert.ok(Number.isInteger(estimate.estimatedOutputTokens) && estimate.estimatedOutputTokens > 0);

  // #1184: usage.estimate { feature: 'classify' } returns a single-number upper-bound estimate without calling any model
  const usageEst = await service.call('usage.estimate', { feature: 'classify', course: 'Java 八股' });
  assert.equal(usageEst.feature, 'classify');
  assert.equal(usageEst.itemCount, 2);
  assert.equal(usageEst.calls.low, 1);
  assert.equal(usageEst.calls.high, 1);
  assert.equal(usageEst.inputTokens.low, estimate.estimatedInputTokens);
  assert.equal(usageEst.inputTokens.high, estimate.estimatedInputTokens);
  assert.equal(usageEst.outputTokens.low, estimate.estimatedOutputTokens);
  assert.equal(usageEst.outputTokens.high, estimate.estimatedOutputTokens);
  assert.equal(usageEst.totalTokens.low, estimate.estimatedInputTokens + estimate.estimatedOutputTokens);
  assert.equal(usageEst.totalTokens.high, usageEst.totalTokens.low, 'single upper-bound number (low === high)');
  assert.equal(usageEst.stages.length, 1);
  assert.equal(usageEst.stages[0].id, 'classify');

  const emptyUsageEst = await service.call('usage.estimate', { feature: 'classify', course: 'NoSuchCourse' });
  assert.equal(emptyUsageEst.calls.high, 0);
  assert.equal(emptyUsageEst.totalTokens.high, 0);

  const afterSnap = await service.call('snapshot');
  assert.equal(afterSnap.revision, beforeSnap.revision);
});

/* ---------- 3. source.folder.apply atomic multi-folder commit, validation & English i18n ---------- */

test('source.folder.apply atomically creates folders, updates/clears items in one commit, enforces limits, and localizes errors in English', async (t) => {
  const { service } = await createTempService(t);
  await service.call('source.add', { id: 's1', title: 'Doc 1', text: 'content 1', courses: ['CS'] });
  await service.call('source.add', { id: 's2', title: 'Doc 2', text: 'content 2', courses: ['CS'] });
  await service.call('source.add', { id: 's3', title: 'Doc 3', text: 'content 3', courses: ['CS'] });
  await service.call('source.folder.create', { name: '计算机网络' });

  const before = await service.call('snapshot');
  const applied = await service.call('source.folder.apply', {
    assignments: [
      { key: 'source:s1', folder: '  计算机网络  ' },
      { key: 'source:s2', folder: '  Java   并发编程 ' },
      { key: 'source:s3', folder: 'MySQL 与存储' },
    ],
  });

  assert.deepEqual(applied, {
    updated: 3,
    createdFolders: ['Java 并发编程', 'MySQL 与存储'],
    folders: ['计算机网络', 'Java 并发编程', 'MySQL 与存储'],
    items: {
      'source:s1': '计算机网络',
      'source:s2': 'Java 并发编程',
      'source:s3': 'MySQL 与存储',
    },
  });

  const mid = await service.call('snapshot');
  assert.equal(mid.revision, before.revision + 1, 'committed in one single store transaction');
  assert.deepEqual(mid.materialFolders, {
    folders: ['计算机网络', 'Java 并发编程', 'MySQL 与存储'],
    items: {
      'source:s1': '计算机网络',
      'source:s2': 'Java 并发编程',
      'source:s3': 'MySQL 与存储',
    },
  });

  // Clearing folders via null and ""
  const cleared = await service.call('source.folder.apply', {
    assignments: [
      { key: 'source:s1', folder: null },
      { key: 'source:s2', folder: '   ' },
    ],
  });
  assert.equal(cleared.updated, 2);
  assert.deepEqual(cleared.createdFolders, []);
  assert.deepEqual(cleared.items, { 'source:s3': 'MySQL 与存储' });

  // Validation atomicity: if a second item is missing, the first item is NOT mutated
  await assert.rejects(
    service.call('source.folder.apply', {
      assignments: [
        { key: 'source:s1', folder: 'Should Not Persist' },
        { key: 'source:does-not-exist', folder: '计算机网络' },
      ],
    }),
    /找不到这份资料/,
  );
  const unchanged = await service.call('snapshot');
  assert.equal(unchanged.materialFolders.folders.includes('Should Not Persist'), false);
  assert.equal(unchanged.materialFolders.items['source:s1'], undefined);

  // English localization check (zero Han characters in localized error messages!)
  for (const badArgs of [
    { assignments: [] },
    { assignments: [{ key: 'source:s1', folder: 'A' }, { key: 'source:s1', folder: 'B' }] },
    { assignments: [{ key: 'source:missing', folder: 'A' }] },
    { assignments: [{ key: 'source:s1', folder: 'x'.repeat(MAX_FOLDER_NAME_CHARS + 5) }] },
  ]) {
    await assert.rejects(
      service.call('source.folder.apply', { ...badArgs, uiLanguage: 'en' }),
      (err) => {
        assert.equal(HAN_RE.test(err.message), false, `Expected English error without Han chars, got: ${err.message}`);
        return true;
      },
    );
  }

  // MAX_FOLDERS (200) cap enforcement
  await service.store.update((s) => {
    s.settings.materialFolders = {
      folders: Array.from({ length: MAX_FOLDERS }, (_, idx) => `Topic ${idx + 1}`),
      items: {},
    };
  });
  await assert.rejects(
    service.call('source.folder.apply', {
      assignments: [{ key: 'source:s1', folder: 'Overflow Folder 201' }],
      uiLanguage: 'en',
    }),
    /At most 200 folders are allowed/,
  );
  assert.equal((await service.store.read()).version, LATEST_VERSION);
});

/* ---------- 4. Compact descriptor safety (never leaks full document text!) ---------- */

test('source.folder.suggest sends compact metadata/headings/excerpt only and NEVER sends full document body', async (t) => {
  const seenPrompts = [];
  const { service } = await createTempService(t, {
    complete: async (_system, prompt) => {
      seenPrompts.push(prompt);
      return JSON.stringify({
        folders: ['JVM 与内存'],
        assignments: [{ id: 'm1', folder: 'JVM 与内存' }],
      });
    },
  });

  const hugeTail = 'FULL_TEXT_TAIL_SECRET_MARKER '.repeat(3000);
  const fullBody = `# JVM 内存区域\n\nJava 虚拟机在执行程序时会把内存划分为运行时数据区。\n\n## 程序计数器\n线程私有。\n\n${'正文铺垫内容。'.repeat(500)}\n${hugeTail}`;
  await service.call('source.add', {
    id: 'huge-doc',
    title: 'JVM 内存区域详解',
    text: fullBody,
    format: 'md',
    courses: ['Java 八股'],
  });

  const desc = buildCompactDescriptor(
    groupSourcesByDocument((await service.store.read()).sources)[0],
    'm1',
    new Map([['huge-doc', { id: 'huge-doc', text: fullBody }]]),
  );
  assert.equal(desc.id, 'm1');
  assert.ok(desc.excerpt.length <= 160);
  assert.ok(desc.title.length <= 120);
  assert.ok(Array.isArray(desc.headings) && desc.headings.includes('程序计数器'));
  assert.equal(JSON.stringify(desc).includes('FULL_TEXT_TAIL_SECRET_MARKER'), false);

  const beforeSnap = await service.call('snapshot');
  const result = await service.call('source.folder.suggest', { course: 'Java 八股' });
  const afterSnap = await service.call('snapshot');

  assert.equal(seenPrompts.length, 1);
  assert.equal(seenPrompts[0].includes('FULL_TEXT_TAIL_SECRET_MARKER'), false, 'prompt must never carry full source text');
  assert.ok(seenPrompts[0].length < 2500, `compact prompt was ${seenPrompts[0].length} chars`);
  assert.equal(afterSnap.revision, beforeSnap.revision, 'suggest is strictly read-only');
  assert.deepEqual(result, {
    folders: ['JVM 与内存'],
    suggestions: [
      {
        key: 'source:huge-doc',
        title: 'JVM 内存区域详解',
        currentFolder: null,
        suggestedFolder: 'JVM 与内存',
      },
    ],
    unmatchedKeys: [],
  });
});

/* ---------- 5. Scalability: 350+ items ("八股项目" scale) 2-stage taxonomy + batched classification ---------- */

test('source.folder.suggest scales to 350 items via 1 taxonomy call + 6 batched calls and applies cleanly', async (t) => {
  const TOPIC_SPECS = [
    { dir: 'cs-basics/network', label: '计算机网络', keyword: 'TCP与HTTP网络协议' },
    { dir: 'cs-basics/operating-system', label: '操作系统', keyword: '进程线程与虚拟内存' },
    { dir: 'java/concurrent', label: 'Java 并发编程', keyword: '线程池与AQS并发锁' },
    { dir: 'java/jvm', label: 'JVM 虚拟机', keyword: '类加载与垃圾回收器' },
    { dir: 'database/mysql', label: 'MySQL 数据库', keyword: 'InnoDB事务与B+树索引' },
    { dir: 'database/redis', label: 'Redis 缓存', keyword: '缓存穿透雪崩与持久化' },
    { dir: 'advanced-java/high-concurrency', label: '分布式与高并发', keyword: '消息队列与分布式锁' },
  ];

  const modelCalls = [];
  const { service } = await createTempService(t, {
    complete: async (_system, prompt) => {
      const jsonLine = prompt.split('\n\n')[0];
      const payload = JSON.parse(jsonLine);
      const isTaxonomy = !prompt.includes('"assignments"');
      modelCalls.push({ isTaxonomy, itemCount: payload.items.length, hasTargets: Boolean(payload.targetFolders?.length) });

      if (isTaxonomy) {
        return JSON.stringify({ folders: TOPIC_SPECS.map(s => s.label) });
      }
      const assignments = payload.items.map((item) => {
        const matched = TOPIC_SPECS.find(
          spec => (item.dir && item.dir.includes(spec.dir.split('/')[1])) || item.title.includes(spec.keyword),
        ) || TOPIC_SPECS[0];
        return { id: item.id, folder: matched.label };
      });
      return JSON.stringify({ assignments });
    },
  });

  // Seed 350 grouped materials across 7 topics (50 each), mixing external md docs, json banks, notes, and a converted PDF book
  await service.store.update((s) => {
    s.sources ||= [];
    s.documents ||= [];
    for (let i = 0; i < 350; i++) {
      const spec = TOPIC_SPECS[i % TOPIC_SPECS.length];
      if (i % 10 === 9) {
        s.sources.push({
          id: `json-${i}`,
          title: `JSON 导入：${spec.keyword} 题库 ${i}`,
          text: `{"topic":"${spec.label}"}`,
          provenance: 'json-card-self-reference',
          createdAt: '2026-10-01T00:00:00.000Z',
          courses: ['Java 八股'],
        });
      } else {
        const docId = `document-${String(i).padStart(64, '0')}-md`;
        const srcId = `${docId}-s1`;
        s.sources.push({
          id: srcId,
          title: `${spec.keyword} · 专题 ${i}.md`,
          text: `# ${spec.keyword}\n核心八股考点详解 ${i}。`,
          createdAt: '2026-10-01T00:00:00.000Z',
          courses: ['Java 八股'],
          document: { materialId: docId, materialRevision: 'r1', format: 'md', filename: `topic-${i}.md` },
        });
        s.documents.push({
          id: docId,
          format: 'md',
          filename: `topic-${i}.md`,
          title: `${spec.keyword} · 专题 ${i}.md`,
          currentRevision: 'r1',
          externalPath: `D:\\Users\\Learner\\八股项目\\javaguide\\docs\\${spec.dir}\\topic-${i}.md`,
          versions: [{ revision: 'r1', sourceIds: [srcId] }],
        });
      }
    }
  });

  // Offline token estimate for 350 items in auto mode -> 1 taxonomy + ceil(350/60)=6 batches = 7 calls
  const est = await service.call('source.folder.suggest', { course: 'Java 八股', estimate: true });
  assert.equal(est.itemCount, 350);
  assert.equal(est.batchCount, 1 + Math.ceil(350 / FOLDER_SUGGEST_BATCH));
  assert.equal(modelCalls.length, 0);

  // #1184: usage.estimate { feature: 'classify' } splits 2-stage (>60 items) into taxonomy + classifyBatch stages with upper-bound single totals
  const largeUsageEst = await service.call('usage.estimate', { feature: 'classify', course: 'Java 八股' });
  assert.equal(largeUsageEst.calls.low, est.batchCount);
  assert.equal(largeUsageEst.calls.high, est.batchCount);
  assert.equal(largeUsageEst.totalTokens.low, est.estimatedInputTokens + est.estimatedOutputTokens);
  assert.equal(largeUsageEst.totalTokens.high, largeUsageEst.totalTokens.low);
  assert.deepEqual(largeUsageEst.stages.map(s => [s.id, s.calls]), [['taxonomy', 1], ['classifyBatch', Math.ceil(350 / FOLDER_SUGGEST_BATCH)]]);
  assert.equal(
    largeUsageEst.stages.reduce((sum, s) => sum + s.inputTokens.high + s.outputTokens.high, 0),
    largeUsageEst.totalTokens.high,
  );
  assert.equal(modelCalls.length, 0);

  // Taxonomy-only call (1 compact call over all 350 items!)
  const tax = await service.call('source.folder.suggest', { course: 'Java 八股', mode: 'taxonomy', maxFolders: 10 });
  assert.equal(tax.itemCount, 350);
  assert.deepEqual(tax.folders, TOPIC_SPECS.map(s => s.label));
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].isTaxonomy, true);
  assert.equal(modelCalls[0].itemCount, 350);

  // Full end-to-end auto mode over 350 items: 1 taxonomy call + 6 concurrent batch calls = 7 calls total
  modelCalls.length = 0;
  const full = await service.call('source.folder.suggest', { course: 'Java 八股', mode: 'auto', maxFolders: 12 });
  assert.equal(modelCalls.length, 7);
  assert.equal(modelCalls[0].isTaxonomy, true);
  assert.equal(modelCalls.slice(1).every(c => !c.isTaxonomy && c.hasTargets), true);
  assert.equal(full.suggestions.length, 350);
  assert.deepEqual(full.unmatchedKeys, []);
  assert.deepEqual(full.folders, TOPIC_SPECS.map(s => s.label));

  // Commit all 350 suggestions in ONE atomic `source.folder.apply` call
  const committed = await service.call('source.folder.apply', {
    assignments: full.suggestions.map(s => ({ key: s.key, folder: s.suggestedFolder })),
  });
  assert.equal(committed.updated, 350);
  assert.equal(committed.createdFolders.length, 7);
  assert.equal(Object.keys(committed.items).length, 350);

  // Subsequent `onlyUnfiled: true` sees 0 unfiled items and makes 0 LLM calls!
  modelCalls.length = 0;
  const unfiledCheck = await service.call('source.folder.suggest', { course: 'Java 八股', onlyUnfiled: true });
  assert.equal(modelCalls.length, 0);
  assert.deepEqual(unfiledCheck, { folders: [], suggestions: [], unmatchedKeys: [] });
});

/* ---------- 6. Cutoff salvage, 1 retry for missing alias IDs, deterministic sibling fallback & unmatchedKeys ---------- */

test('parseBatchReply/parseTaxonomyReply salvage truncated JSON, retry missing IDs once, fallback sensibly, and report unmatchedKeys on empty reply', async (t) => {
  // Direct unit check on truncated JSON stream salvage
  const truncatedTax = '{"folders":["计算机网络","操作系统","Java 并发';
  assert.deepEqual(parseTaxonomyReply(truncatedTax, 10), ['计算机网络', '操作系统']);

  const truncatedBatch = '{"assignments":[{"id":"m1","folder":"计算机网络"},{"id":"m2","folder":"操作系统"},{"id":"m3","folder":"Java ';
  const salvaged = parseBatchReply(truncatedBatch, new Set(['m1', 'm2', 'm3']));
  assert.deepEqual([...salvaged.assignments.entries()], [
    ['m1', '计算机网络'],
    ['m2', '操作系统'],
  ]);

  let attempt = 0;
  const { service } = await createTempService(t, {
    complete: async (_system, prompt) => {
      attempt += 1;
      if (attempt === 1) {
        // Cut off mid-JSON: m1 & m2 complete, m3 & m4 missing!
        return '{"folders":["计算机网络","Redis 缓存"],"assignments":[{"id":"m1","folder":"计算机网络"},{"id":"m2","folder":"Redis 缓存"},{"id":"m3","fol';
      }
      // Retry prompt asks only for m3, m4; model answers m3 (with case/space variant "redis缓存") and STILL omits m4!
      assert.match(prompt, /m3, m4/);
      return '{"assignments":[{"id":"m3","folder":"redis缓存"}]}';
    },
  });

  // Seed 4 items: m1 & m4 share dir `cs-basics/network` so omitted m4 deterministically inherits `计算机网络`!
  await service.store.update((s) => {
    s.sources ||= [];
    s.documents ||= [];
    const mkDoc = (n, title, extPath) => {
      const docId = `document-${String(n).padStart(64, 'a')}-md`;
      const srcId = `${docId}-s1`;
      s.sources.push({
        id: srcId,
        title,
        text: `# ${title}\n内容 ${n}`,
        courses: ['CS'],
        document: { materialId: docId, materialRevision: 'r1', format: 'md', filename: `${n}.md` },
      });
      s.documents.push({
        id: docId,
        format: 'md',
        filename: `${n}.md`,
        title,
        currentRevision: 'r1',
        externalPath: extPath,
        versions: [{ revision: 'r1', sourceIds: [srcId] }],
      });
      return `doc:${docId}`;
    };
    mkDoc(1, 'TCP 拥塞控制', '/repo/docs/cs-basics/network/tcp.md');
    mkDoc(2, 'Redis 哨兵机制', '/repo/docs/database/redis/sentinel.md');
    mkDoc(3, 'AOF 重写机制', '/repo/docs/database/redis/aof.md');
    mkDoc(4, 'ARP 地址解析', '/repo/docs/cs-basics/network/arp.md');
  });

  const keys = groupSourcesByDocument((await service.store.read()).sources).map(i => i.key);
  const res = await service.call('source.folder.suggest', {
    keys: [...keys, 'source:ghost-key'],
    course: 'CS',
    mode: 'auto',
  });

  assert.equal(attempt, 2, '1 initial call + 1 targeted retry for missing alias IDs');
  assert.deepEqual(res.folders, ['计算机网络', 'Redis 缓存']);
  assert.equal(res.suggestions.length, 4);
  assert.equal(res.suggestions[2].suggestedFolder, 'Redis 缓存', 'canonicalized "redis缓存" -> "Redis 缓存"');
  assert.equal(res.suggestions[3].suggestedFolder, '计算机网络', 'omitted m4 inherited sibling dir folder');
  assert.deepEqual(res.unmatchedKeys, ['source:ghost-key']);

  // Now simulate completely empty/broken model replies on both attempts -> reports all keys in unmatchedKeys without inventing folders!
  service.complete = async () => '{}';
  const emptyRes = await service.call('source.folder.suggest', { keys, mode: 'batch', targetFolders: ['计算机网络'] });
  assert.deepEqual(emptyRes.folders, []);
  assert.deepEqual(emptyRes.suggestions, []);
  assert.deepEqual(emptyRes.unmatchedKeys, keys);
});
