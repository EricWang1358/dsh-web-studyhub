/* global document, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { readMaterialFolders } from '../lib/contexts/materials/material-folders.js';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export * from './ui/material-facets.js';
      export * from './ui/use-material-classify.js';
      export { default as MaterialCategoryBar } from './ui/MaterialCategoryBar.jsx';
      export { TokenEstimateView } from './ui/TokenUsage.jsx';
      export { estimateSummary, stageLabel } from './ui/token-usage.js';
      export { default as SourcePicker, documentSearchText } from './ui/SourcePicker.jsx';
      export { default as Generate } from './ui/Generate.jsx';
      export { default as CaseCreate } from './ui/CaseCreate.jsx';
      export { default as Sources } from './ui/Sources.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, uiMod, uiMod.exports);
const {
  ALL_FACET,
  UNFILED_FACET,
  buildSourceFlags,
  materialKindOf,
  materialFormatBucket,
  buildMaterialTypeOptions,
  buildMaterialCategoryOptions,
  hasFacetOption,
  filterMaterialsByFacets,
  runBatchedFolderSuggest,
  buildProposalGroups,
  buildApplyAssignments,
  canApplyProposalGroups,
  MaterialCategoryBar,
  TokenEstimateView,
  estimateSummary,
  stageLabel,
  SourcePicker,
  documentSearchText,
  Generate,
  CaseCreate,
  Sources,
  StudyServicesContext,
  setUiLanguage,
} = uiMod.exports;

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;

/* ---------- 1. Deterministic Type & Format Facets ---------- */

test('materialKindOf and materialFormatBucket classify real 300+ repository shapes accurately with zero tokens', () => {
  const rawSources = [
    {
      id: 'net-1',
      title: '计算机网络常见面试题总结（上）',
      text: 'TCP/IP 与 HTTP 详解。'.repeat(1500),
      chars: 22362,
      courses: ['Java 八股'],
      document: { materialId: 'doc-net-1', format: 'md', filename: 'network-summary-1.md' },
    },
    {
      id: 'cw-1',
      title: '实验课课件 · 第一章：竞态与并发容器 [ch1].md',
      text: 'ConcurrentHashMap 实验步骤',
      chars: 4200,
      courses: ['Java 八股'],
      document: { materialId: 'doc-cw-1', format: 'md', filename: 'ch1.md' },
    },
    {
      id: 'cw-comp',
      title: '并发内存模型交互页',
      text: 'JMM happens-before',
      chars: 1800,
      companionId: 'comp-1',
      courses: ['Java 八股'],
    },
    {
      id: 'qb-1',
      title: 'JSON 导入：Java 并发 · JavaGuide 原题',
      text: '[{"q":"什么是 CAS"}]',
      chars: 3100,
      provenance: 'json-card-self-reference',
      courses: ['Java 八股'],
      document: { materialId: 'doc-qb-1', format: 'json', filename: 'concurrent.json' },
    },
    {
      id: 'book-1',
      title: 'Java架构师指南',
      text: '架构导论',
      chars: 599000,
      courses: ['Java 八股'],
      document: { id: 'sha-book', filename: 'architect.pdf', page: 1, totalPages: 415, origin: 'converted', converter: 'mineru', format: 'pdf' },
    },
    {
      id: 'note-1',
      title: '补充笔记 · B+树聚簇索引',
      text: 'InnoDB 二级索引回表。',
      chars: 180,
      courses: ['Java 八股'],
    },
    {
      id: 'note-live',
      title: 'AI全栈与Agent开发 · 课堂实录',
      text: '课堂记录正文'.repeat(400),
      chars: 4000,
      live: true,
      courses: ['AI全栈与Agent开发'],
    },
    {
      id: 'audio-1',
      title: 'AI全栈与Agent开发 · 中英对照逐字稿',
      text: 'Speaker 1: Welcome.',
      chars: 6500,
      courses: ['AI全栈与Agent开发'],
      audio: { batchId: 'b1' },
      document: { format: 'audio' },
    },
    {
      id: 'exam-1',
      title: '2025 操作系统期末真题试卷.docx',
      text: '第一大题',
      chars: 5200,
      courses: ['Java 八股'],
      document: { materialId: 'doc-exam-1', format: 'docx', filename: 'os-past-paper.docx' },
    },
  ];

  const grouped = groupSourcesByDocument(rawSources);
  const flags = buildSourceFlags(rawSources);
  const byId = new Map(grouped.map(item => [item.sourceIds[0], item]));

  // Long 22k-char Markdown interview article with "总结" in title MUST stay 'article', not 'note'!
  assert.equal(materialKindOf(byId.get('net-1'), flags), 'article');
  assert.equal(materialKindOf(byId.get('cw-1'), flags), 'courseware');
  assert.equal(materialKindOf(byId.get('cw-comp'), flags), 'courseware');
  assert.equal(materialKindOf(byId.get('qb-1'), flags), 'question-bank');
  assert.equal(materialKindOf(byId.get('book-1'), flags), 'book');
  assert.equal(materialKindOf(byId.get('note-1'), flags), 'note');
  assert.equal(materialKindOf(byId.get('note-live'), flags), 'note');
  assert.equal(materialKindOf(byId.get('audio-1'), flags), 'transcript');
  assert.equal(materialKindOf(byId.get('exam-1'), flags), 'exam');

  assert.equal(materialFormatBucket(byId.get('net-1')), 'md');
  assert.equal(materialFormatBucket(byId.get('book-1')), 'pdf');
  assert.equal(materialFormatBucket(byId.get('exam-1')), 'office');
  assert.equal(materialFormatBucket(byId.get('qb-1')), 'json');
  assert.equal(materialFormatBucket(byId.get('note-1')), 'text');
  assert.equal(materialFormatBucket(byId.get('audio-1')), 'audio');

  setUiLanguage('zh');
  const typeOpts = buildMaterialTypeOptions(grouped, flags);
  assert.equal(typeOpts[0].value, ALL_FACET);
  assert.equal(typeOpts[0].label, '全部类型');
  const formatGroup = typeOpts.find(entry => entry.group === '按文件格式');
  assert.ok(formatGroup, 'includes file format group when >= 2 formats exist');
  assert.ok(formatGroup.options.some(opt => opt.value === 'fmt:md' && opt.label === '格式：Markdown (2)'));

  // Single-format scope omits the format sub-group
  const mdOnly = grouped.filter(item => item.format === 'md');
  const singleFmtOpts = buildMaterialTypeOptions(mdOnly, flags);
  assert.equal(singleFmtOpts.some(entry => entry.group), false, 'omits format group when only 1 format exists');
});

/* ---------- 2. Content Category Facets, Filtering, Scope Reset & Search ---------- */

test('buildMaterialCategoryOptions, filterMaterialsByFacets, hasFacetOption, and documentSearchText work together', () => {
  setUiLanguage('zh');
  const items = [
    { key: 'doc:n1', title: 'TCP 三次握手', format: 'md', chars: 5000, courses: ['Java 八股'], sourceIds: ['n1'], pages: [], warnings: [] },
    { key: 'doc:n2', title: 'HTTP 常见面试题', format: 'md', chars: 6000, courses: ['Java 八股'], sourceIds: ['n2'], pages: [], warnings: [] },
    { key: 'doc:c1', title: 'ReentrantLock 源码分析', format: 'md', chars: 7000, courses: ['Java 八股'], sourceIds: ['c1'], pages: [], warnings: [] },
    { key: 'source:q1', title: 'JSON 导入：网络题库', format: 'json', provenance: 'json-card-self-reference', chars: 2000, courses: ['Java 八股'], sourceIds: ['q1'], pages: [], warnings: [] },
  ];
  const folders = readMaterialFolders({
    materialFolders: {
      folders: ['Java 并发编程', '计算机网络', '空文件夹'],
      items: {
        'doc:n1': '计算机网络',
        'doc:n2': '计算机网络',
        'source:q1': '计算机网络',
      },
    },
  });

  const catOptions = buildMaterialCategoryOptions(items, folders);
  assert.deepEqual(catOptions, [
    { value: '*', label: '全部分类' },
    { value: '计算机网络', label: '计算机网络 (3)' },
    { value: UNFILED_FACET, label: '未归类 (1)' },
  ]);
  assert.equal(hasFacetOption(catOptions, '计算机网络'), true);
  assert.equal(hasFacetOption(catOptions, 'Java 并发编程'), false, 'zero-count folder in current scope is omitted and triggers reset');

  // Combined type + category filtering
  const netArticles = filterMaterialsByFacets(items, {
    typeScope: 'kind:article',
    categoryScope: '计算机网络',
    materialFolders: folders,
  });
  assert.deepEqual(netArticles.map(item => item.key), ['doc:n1', 'doc:n2']);

  const unfiled = filterMaterialsByFacets(items, {
    typeScope: '*',
    categoryScope: UNFILED_FACET,
    materialFolders: folders,
  });
  assert.deepEqual(unfiled.map(item => item.key), ['doc:c1']);

  // documentSearchText includes folder name so keyword search matches category names
  assert.match(documentSearchText(items[0], folders), /计算机网络/);
});

/* ---------- 3. Batched AI Suggest (<= 60 auto vs > 60 taxonomy + concurrency-2 batches) & Proposal Grouping ---------- */

test('runBatchedFolderSuggest uses single auto call for <= 60 items and 2-stage concurrency-2 batches for 249 items', async () => {
  // Small set (<= 60): 1 call with mode: 'auto', maxFolders: 12
  const smallCalls = [];
  const smallRes = await runBatchedFolderSuggest({
    keys: ['doc:1', 'doc:2', 'doc:3'],
    course: 'Python基础',
    call: async (action, args) => {
      smallCalls.push({ action, args });
      return {
        folders: ['基础语法'],
        suggestions: [
          { key: 'doc:1', title: '变量', currentFolder: null, suggestedFolder: '基础语法' },
          { key: 'doc:2', title: '循环', currentFolder: null, suggestedFolder: '基础语法' },
          { key: 'doc:3', title: '函数', currentFolder: null, suggestedFolder: '基础语法' },
        ],
        unmatchedKeys: [],
      };
    },
  });
  assert.equal(smallCalls.length, 1);
  assert.deepEqual(smallCalls[0], {
    action: 'source.folder.suggest',
    args: { keys: ['doc:1', 'doc:2', 'doc:3'], course: 'Python基础', mode: 'auto', maxFolders: 12 },
  });
  assert.equal(smallRes.suggestions.length, 3);

  // Large set (249 items, matching Java 八股): 1 taxonomy call + 5 batch calls (60,60,60,60,9) with concurrency <= 2
  const keys249 = Array.from({ length: 249 }, (_, i) => `doc:m${i + 1}`);
  const largeCalls = [];
  const progressEvents = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const largeRes = await runBatchedFolderSuggest({
    keys: keys249,
    course: 'Java 八股',
    onProgress: p => progressEvents.push(p),
    call: async (action, args) => {
      largeCalls.push({ action, mode: args.mode, count: args.keys.length, maxFolders: args.maxFolders, targetFolders: args.targetFolders });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 8));
      inFlight -= 1;
      if (args.mode === 'taxonomy') {
        return { folders: ['计算机网络', 'Java 并发编程', 'MySQL 与 Redis'], itemCount: args.keys.length };
      }
      return {
        folders: args.targetFolders,
        suggestions: args.keys.map((key, idx) => ({
          key,
          title: `文档 ${key}`,
          currentFolder: null,
          suggestedFolder: args.targetFolders[idx % args.targetFolders.length],
        })),
        unmatchedKeys: [],
      };
    },
  });

  assert.equal(largeCalls[0].mode, 'taxonomy');
  assert.equal(largeCalls[0].count, 249);
  assert.equal(largeCalls[0].maxFolders, 14);
  assert.equal(largeCalls.length, 6, '1 taxonomy call + 5 batch calls for 249 items');
  assert.ok(maxInFlight <= 2, `concurrency stayed <= 2 (got ${maxInFlight})`);
  assert.equal(largeRes.suggestions.length, 249);
  assert.equal(progressEvents.at(-1).done, 249);

  // Proposal grouping, renaming, toggling, and atomic apply payload
  const groups = buildProposalGroups(largeRes.suggestions, largeRes.folders);
  assert.equal(groups.length, 3, '249 items become 3 clean category rows instead of 249 dropdowns');
  assert.equal(canApplyProposalGroups(groups), true);

  // Uncheck group 2 and rename group 0
  const edited = groups.map((g, idx) =>
    idx === 0 ? { ...g, name: '  计算机网络核心  ' } : idx === 1 ? { ...g, include: false } : g,
  );
  const assignments = buildApplyAssignments(edited);
  assert.equal(assignments.length, groups[0].items.length + groups[2].items.length);
  assert.equal(assignments[0].folder, '计算机网络核心');
  assert.equal(canApplyProposalGroups(edited.map(g => ({ ...g, include: false }))), false);
  assert.equal(canApplyProposalGroups(edited.map(g => ({ ...g, name: '   ' }))), false);

  // Cancellation mid-run halts further batches and returns null
  let cancelled = false;
  let cancelCalls = 0;
  const cancelledRes = await runBatchedFolderSuggest({
    keys: keys249,
    isCancelled: () => cancelled,
    call: async (_action, args) => {
      cancelCalls += 1;
      if (args.mode === 'taxonomy') {
        cancelled = true;
        return { folders: ['计算机网络'], itemCount: 249 };
      }
      return { folders: [], suggestions: [], unmatchedKeys: [] };
    },
  });
  assert.equal(cancelledRes, null);
  assert.equal(cancelCalls, 1, 'stopped immediately after cancellation');
});

/* ---------- 4. SSR, Guardrails & English Zero-Han Across Generate, CaseCreate, SourcePicker & Sources ---------- */

test('SSR mounts MaterialCategoryBar in Generate, CaseCreate, and Sources, skips short pickers, and has zero Han in English', () => {
  const sources = [
    {
      id: 's1',
      title: 'TCP Handshake Overview.md',
      text: 'SYN, SYN-ACK, ACK.',
      chars: 420,
      createdAt: '2026-10-01T08:00:00.000Z',
      courses: ['Networks'],
      document: { materialId: 'doc-s1', format: 'md', filename: 'tcp.md' },
    },
    {
      id: 's2',
      title: 'Lecture 2 Slides.pptx',
      text: 'Routing tables.',
      chars: 680,
      createdAt: '2026-10-02T08:00:00.000Z',
      courses: ['Networks'],
      document: { materialId: 'doc-s2', format: 'pptx', filename: 'lec2.pptx' },
    },
    // A course long enough for the list's filter line (more than 6 materials): the type and category filters come with it (#1182).
    ...Array.from({ length: 6 }, (_, at) => ({
      id: `n${at + 3}`,
      title: `Routing note ${at + 3}.md`,
      text: 'Routing tables and hops.',
      chars: 300,
      createdAt: '2026-10-03T08:00:00.000Z',
      courses: ['Networks'],
    })),
  ];
  const data = {
    root: 'lib-classify',
    decks: [],
    drafts: [],
    jobs: [],
    sources,
    courses: [{ id: 'c1', name: 'Networks' }],
    focus: { course: 'Networks', courses: [{ name: 'Networks' }] },
    materialFolders: { folders: ['Transport Layer'], items: { 'doc:doc-s1': 'Transport Layer' } },
    modelReady: true,
    model: { ready: true, reason: 'ok' },
  };

  setUiLanguage('zh');
  // Compact picker without onScopeChange does NOT render MaterialCategoryBar
  const compactHtml = renderToStaticMarkup(h(SourcePicker, { sources, selected: [], onChange: noop }));
  assert.doesNotMatch(compactHtml, /data-material-category-bar/);
  // Nor does a course scope of a few materials (no filter line, nothing to narrow, #1182)
  const shortHtml = renderToStaticMarkup(withStudy(StudyServicesContext,
    h(SourcePicker, { sources: sources.slice(0, 2), selected: [], onChange: noop, courses: data.focus.courses, scope: 'Networks', onScopeChange: noop }),
    { act: noop, call: noop, busy: false }));
  assert.doesNotMatch(shortHtml, /data-material-category-bar|data-material-filters-toggle/);

  // Generate 01 / 选择资料 renders MaterialCategoryBar under the list's filter line, behind its button, shut (#1182)
  const genZh = renderToStaticMarkup(
    withStudy(
      StudyServicesContext,
      h(Generate, {
        data,
        running: false,
        openDraft: noop,
        setPage: noop,
        genSource: 'files',
        setGenSource: noop,
        gen: { kind: 'mixed', count: 5, difficulty: 'mixed', language: '中文', focus: '', role: '' },
        setGen: noop,
        selectedSources: ['s1'],
        setSelectedSources: noop,
        setModal: noop,
        openModelSettings: noop,
      }),
      { act: noop, call: noop, busy: false },
    ),
  );
  assert.match(genZh, /data-material-category-bar/);
  assert.match(genZh, /Transport Layer \(1\)/);
  assert.match(genZh, /未归类 \(7\)/);
  assert.match(genZh, /AI 智能分类/);
  const filtersPos = genZh.indexOf('source-picker__filters');
  const barPos = genZh.indexOf('source-picker__bar');
  const togglePos = genZh.indexOf('data-material-filters-toggle');
  const linePos = genZh.indexOf('sh-scroll__filter');
  assert.ok(barPos > 0 && linePos > barPos && togglePos > linePos && filtersPos > togglePos,
    'the filters button is on the filter line of the list, after .source-picker__bar, and the filters follow it');
  assert.match(genZh, /<button[^>]*aria-expanded="false"[^>]*data-material-filters-toggle/, 'the filters start shut');
  assert.match(genZh, /<div[^>]*class="material-category-bar source-picker__filters"[^>]*hidden=""/, 'shut, the filters draw nothing');

  // CaseCreate 01 / 课程与资料 also renders MaterialCategoryBar
  const caseZh = renderToStaticMarkup(
    withStudy(StudyServicesContext, h(CaseCreate, { data, onStarted: noop, openImport: noop, openSettings: noop }), {
      act: noop,
      call: noop,
      busy: false,
    }),
  );
  assert.match(caseZh, /data-material-category-bar/);

  // Model disconnected disables AI classify button cleanly and does NOT render usage estimate (#1184)
  const disconnectedBar = renderToStaticMarkup(
    withStudy(
      StudyServicesContext,
      h(MaterialCategoryBar, { items: groupSourcesByDocument(sources), modelReady: false }),
      { act: noop, call: noop, busy: false },
    ),
  );
  assert.match(disconnectedBar, /data-ai-classify[^>]*disabled|<button[^>]*disabled[^>]*data-ai-classify/);
  assert.doesNotMatch(disconnectedBar, /data-token-estimate/, 'no usage estimate when model is unavailable');

  // Shut bar (open={false}, e.g. collapsed SourcePicker drawer) does NOT render or request usage estimate (#1182, #1184)
  const shutBar = renderToStaticMarkup(
    withStudy(
      StudyServicesContext,
      h(MaterialCategoryBar, { items: groupSourcesByDocument(sources), modelReady: true, open: false }),
      { act: noop, call: noop, busy: false },
    ),
  );
  assert.doesNotMatch(shutBar, /data-token-estimate/, 'no usage estimate while drawer is shut');

  // Open bar with ready model renders the classify usage estimate slot before clicking AI 智能分类 (#1184)
  const openBar = renderToStaticMarkup(
    withStudy(
      StudyServicesContext,
      h(MaterialCategoryBar, { items: groupSourcesByDocument(sources), modelReady: true, open: true }),
      { act: noop, call: noop, busy: false },
    ),
  );
  assert.match(openBar, /data-classify-estimate/);
  assert.match(openBar, /data-token-estimate/);

  // Single-number upper-bound classify estimate renders without a range dash in zh and en (#1184)
  const singleEst = {
    feature: 'classify',
    uncachedInputTokens: { low: 4800, high: 4800 },
    cacheReadTokens: { low: 0, high: 0 },
    outputTokens: { low: 400, high: 400 },
    inputTokens: { low: 4800, high: 4800 },
    totalTokens: { low: 5200, high: 5200 },
    calls: { low: 1, high: 1 },
    stages: [{ id: 'classify', calls: 1, inputTokens: { low: 4800, high: 4800 }, outputTokens: { low: 400, high: 400 } }],
    notes: ['retries'],
  };
  assert.equal(estimateSummary(singleEst), '预计 5.2K tok · 1 次模型调用');
  assert.doesNotMatch(estimateSummary(singleEst), /–/, 'single upper-bound number has no range dash');
  assert.equal(stageLabel('classify', 'classify'), '内容分类');
  assert.equal(stageLabel('taxonomy', 'classify'), '归纳主题目录');
  assert.equal(stageLabel('classifyBatch', 'classify'), '分批内容分类');
  const estViewZh = renderToStaticMarkup(h(TokenEstimateView, { state: { status: 'ready', estimate: singleEst }, defaultOpen: true }));
  assert.match(estViewZh, /预计 5\.2K tok/);
  assert.match(estViewZh, /内容分类/);

  // English mode: zero untranslated Han characters across Generate and Sources!
  try {
    setUiLanguage('en');
    const genEn = renderToStaticMarkup(
      withStudy(
        StudyServicesContext,
        h(Generate, {
          data,
          running: false,
          openDraft: noop,
          setPage: noop,
          genSource: 'files',
          setGenSource: noop,
          gen: { kind: 'mixed', count: 5, difficulty: 'mixed', language: 'English', focus: '', role: '' },
          setGen: noop,
          selectedSources: ['s1'],
          setSelectedSources: noop,
          setModal: noop,
          openModelSettings: noop,
        }),
        { act: noop, call: noop, busy: false },
      ),
    );
    assert.match(genEn, /AI classify/);
    assert.match(genEn, /All types/);
    assert.match(genEn, /All categories/);
    assert.match(genEn, /Unfiled \(7\)/);
    assert.doesNotMatch(genEn.replace(/<[^>]+>/g, ' '), han, 'English Generate picker has zero Han characters');

    const sourcesEn = renderToStaticMarkup(
      withStudy(StudyServicesContext, h(Sources, { data, setModal: noop, onGenerate: noop }), {
        act: noop,
        call: noop,
        busy: false,
      }),
    );
    assert.match(sourcesEn, /AI classify/);
    assert.match(sourcesEn, /data-classify-estimate/);
    assert.doesNotMatch(sourcesEn.replace(/<[^>]+>/g, ' '), han, 'English Sources page has zero Han characters');

    assert.equal(estimateSummary(singleEst), 'Estimated 5.2K tok · 1 model call');
    assert.doesNotMatch(stageLabel('classify', 'classify'), han);
    assert.doesNotMatch(stageLabel('taxonomy', 'classify'), han);
    assert.doesNotMatch(stageLabel('classifyBatch', 'classify'), han);
  } finally {
    setUiLanguage('zh');
  }
});

/* ---------- 5. Browser E2E: Type & Category Narrowing + One-Click Select Scope + AI Classify Review/Apply ---------- */

test('Browser E2E: narrowing 01 / 选择资料 by type & category selects only matching items, and AI classify review applies cleanly', { timeout: 180000 }, async t => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    if (!/Executable doesn't exist|no Chromium/i.test(error.message)) throw error;
    t.skip('Chromium unavailable');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'study-classify-ui-'));
  const service = new StudyService(join(root, 'library'));
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(
      {
        id: 'net1',
        title: 'TCP 三次握手详解.md',
        text: 'SYN 与 ACK 状态机。'.repeat(20),
        createdAt: '2026-10-01T08:00:00.000Z',
        courses: ['Java 八股'],
        document: { materialId: 'doc-net1', format: 'md', filename: 'tcp.md' },
      },
      {
        id: 'net2',
        title: 'HTTP 缓存与状态码.md',
        text: 'ETag 与 Cache-Control。'.repeat(20),
        createdAt: '2026-10-02T08:00:00.000Z',
        courses: ['Java 八股'],
        document: { materialId: 'doc-net2', format: 'md', filename: 'http.md' },
      },
      {
        id: 'qb1',
        title: 'JSON 导入：并发原题',
        text: '[{"q":"volatile"}]',
        createdAt: '2026-10-03T08:00:00.000Z',
        provenance: 'json-card-self-reference',
        courses: ['Java 八股'],
        document: { materialId: 'doc-qb1', format: 'json', filename: 'qb.json' },
      },
      // Four more notes, so the course is long enough for the list's filter line and the type and category filters with it (more than 6, #1182).
      ...['集合', '线程池', 'JVM', 'Spring'].map((topic, at) => ({
        id: `java${at + 1}`,
        title: `Java ${topic} 笔记`,
        text: `${topic} 要点。`.repeat(10),
        createdAt: `2026-10-0${at + 5}T08:00:00.000Z`,
        courses: ['Java 八股'],
      })),
      {
        id: 'py1',
        title: 'Python 装饰器笔记',
        text: '补充笔记',
        createdAt: '2026-10-04T08:00:00.000Z',
        courses: ['Python基础'],
      },
    );
    state.courses = [{ id: 'c-java', name: 'Java 八股' }, { id: 'c-py', name: 'Python基础' }];
    state.focus = { ...(state.focus || {}), course: 'Java 八股', courses: state.courses };
    state.settings = {
      ...(state.settings || {}),
      materialFolders: {
        folders: ['计算机网络'],
        items: { 'doc:doc-net1': '计算机网络', 'doc:doc-net2': '计算机网络' },
      },
    };
  });

  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({
    libraryRoot: service.store.root,
    home: join(root, 'home'),
    port: 0,
    model: createFakeModel({ latencyMs: 10 }),
    distDir,
  });

  t.after(async () => {
    await browser?.close();
    await server.close();
    await service.dispose?.();
    await rm(root, { recursive: true, force: true });
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  // Intercept RPC for AI classify (`source.folder.classify`, `source.folder.suggest` & `source.folder.apply`) so browser test verifies full review/apply loop deterministically
  let appliedPayload = null;
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (req.method() === 'POST' && url.pathname.includes('/api/call')) {
      const body = JSON.parse(req.postData() || '{}');
      if (body.action === 'source.folder.classify') {
        await service.store.update(state => {
          state.settings = {
            ...(state.settings || {}),
            materialClassifyPending: {
              jobId: 'job-classify-e2e',
              createdAt: '2026-10-05T08:00:00.000Z',
              course: 'Java 八股',
              folders: ['计算机网络', '并发题库'],
              suggestions: [
                { key: 'doc:doc-net1', title: 'TCP 三次握手详解.md', currentFolder: '计算机网络', suggestedFolder: '计算机网络' },
                { key: 'doc:doc-net2', title: 'HTTP 缓存与状态码.md', currentFolder: '计算机网络', suggestedFolder: '计算机网络' },
                { key: 'doc:doc-qb1', title: 'JSON 导入：并发原题', currentFolder: null, suggestedFolder: '并发题库' },
              ],
              unmatchedKeys: [],
            },
          };
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            value: {
              job: { id: 'job-classify-e2e', type: 'material-classify', status: 'complete', done: 3, total: 3 },
              reused: false,
            },
          }),
        });
      }
      if (body.action === 'source.folder.suggest') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            value: {
              folders: ['计算机网络', '并发题库'],
              suggestions: [
                { key: 'doc:doc-net1', title: 'TCP 三次握手详解.md', currentFolder: '计算机网络', suggestedFolder: '计算机网络' },
                { key: 'doc:doc-net2', title: 'HTTP 缓存与状态码.md', currentFolder: '计算机网络', suggestedFolder: '计算机网络' },
                { key: 'doc:doc-qb1', title: 'JSON 导入：并发原题', currentFolder: null, suggestedFolder: '并发题库' },
              ],
              unmatchedKeys: [],
            },
          }),
        });
      }
      if (body.action === 'source.folder.apply') {
        appliedPayload = body.args;
        await service.store.update(state => {
          const folders = [...new Set(body.args.assignments.map(a => a.folder).filter(Boolean))];
          const items = Object.fromEntries(body.args.assignments.filter(a => a.folder).map(a => [a.key, a.folder]));
          const nextSettings = { ...(state.settings || {}), materialFolders: { folders, items } };
          delete nextSettings.materialClassifyPending;
          state.settings = nextSettings;
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: { updated: body.args.assignments.length } }),
        });
      }
    }
    return route.continue();
  });

  await page.addInitScript(() => {
    localStorage.setItem('study-ui-language', 'zh');
    localStorage.setItem('study-autopilot', 'off');
  });

  await page.goto(server.url);
  await page.locator('aside, nav').first().waitFor();
  await (await revealNavRow(page, 'generate')).click();
  // The filters are behind one button on the list's filter line, shut by default (#1182): open them first.
  const filtersToggle = page.locator('[data-tour="generate-sources"] [data-material-filters-toggle]');
  await filtersToggle.waitFor();
  assert.equal(await filtersToggle.getAttribute('aria-expanded'), 'false');
  await filtersToggle.click();
  await page.locator('[data-tour="generate-sources"] .material-category-bar__controls').waitFor();
  // #1184: opening the bar shows a single-number upper-bound usage estimate before clicking AI 智能分类
  await page.locator('[data-tour="generate-sources"] [data-classify-estimate] [data-token-estimate][data-status="ready"]').waitFor();
  const estLine = await page.locator('[data-tour="generate-sources"] [data-classify-estimate]').innerText();
  assert.match(estLine, /预计 .+ tok/);
  assert.doesNotMatch(estLine, /–/, 'single upper-bound number without range dash');

  // Clear initial auto-selection, filter by 内容分类 -> 计算机网络 (2), and click 选择当前范围
  const clearBtn = page.locator('[data-tour="generate-sources"] .source-picker__actions button', { hasText: '清空选择' });
  if (await clearBtn.count()) await clearBtn.click();
  assert.match(await page.locator('[data-tour="generate-sources"] .source-picker__count').innerText(), /已选择 0 \/ 8 份资料/);

  const categoryTrigger = page.locator('[data-tour="generate-sources"] .material-category-bar__field').nth(1).locator('button[role="combobox"]');
  await categoryTrigger.click();
  await page.locator('[role="option"]', { hasText: '计算机网络 (2)' }).click();
  await page.waitForFunction(() => document.querySelector('[data-tour="generate-sources"]')?.innerText.includes('共 2 项'));

  await page.locator('[data-tour="generate-sources"] .source-picker__actions button', { hasText: '选择当前范围' }).click();
  assert.match(await page.locator('[data-tour="generate-sources"] .source-picker__count').innerText(), /已选择 2 \/ 8 份资料/);
  assert.equal(await page.locator('[data-tour="generate-sources"] .source-picker__actions button').count(), 2, 'keeps exact 2 buttons in .source-picker__actions');

  // Switching course scope to Python基础 resets unavailable category back to 全部分类
  await page.locator('[data-tour="generate-sources"] .page-scope__select').click();
  await page.locator('[role="option"]', { hasText: 'Python基础' }).click();
  await page.waitForFunction(() => document.querySelector('[data-tour="generate-sources"] [data-document-key="source:py1"]') !== null);

  // Switch back to Java 八股, run AI 智能分类, rename a category in review panel, and click 确认应用分类
  await page.locator('[data-tour="generate-sources"] .page-scope__select').click();
  await page.locator('[role="option"]', { hasText: 'Java 八股' }).click();
  if ((await filtersToggle.getAttribute('aria-expanded')) !== 'true') await filtersToggle.click();
  await page.locator('[data-tour="generate-sources"] [data-ai-classify]').click();
  await page.locator('[data-tour="generate-sources"] [data-classify-phase="review"]').waitFor();
  assert.match(
    await page.locator('[data-tour="generate-sources"] [data-classify-phase="review"]').innerText(),
    /建议尚未保存，可先调整分类名称或勾选分组，再确认应用。/,
  );

  // Expand <details> on 计算机网络 group to inspect titles, rename 并发题库 -> Java 并发题库, and apply
  const netGroup = page.locator('[data-tour="generate-sources"] [data-classify-group="计算机网络"]');
  await netGroup.locator('summary').click();
  assert.match(await netGroup.innerText(), /TCP 三次握手详解/);

  const qbGroup = page.locator('[data-tour="generate-sources"] [data-classify-group="并发题库"]');
  await qbGroup.locator('input[type="text"]').fill('Java 并发题库');
  await page.locator('[data-tour="generate-sources"] [data-apply-classify]').click();
  await page.locator('[data-tour="generate-sources"] [data-classify-phase="review"]').waitFor({ state: 'detached' });

  assert.ok(appliedPayload, 'source.folder.apply was called');
  assert.ok(
    appliedPayload.assignments.some(entry => entry.key === 'doc:doc-qb1' && entry.folder === 'Java 并发题库'),
    'renamed category was applied in source.folder.apply',
  );

  // Verify newly applied category appears in 内容分类 selector
  await categoryTrigger.click();
  await page.locator('[role="option"]', { hasText: 'Java 并发题库 (1)' }).waitFor();
  await page.keyboard.press('Escape');

  assert.deepEqual(errors, []);
});
