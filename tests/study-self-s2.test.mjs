import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import {
  AI_DRAFTED_SOURCE,
  INDEPENDENT_SOURCE,
  JSON_CARD_SOURCE,
  aiDraftedCitedCardCount,
  isAiDraftedSource,
  normalizeSourceProvenance,
  resolveSourceProvenance,
} from '../lib/source-provenance.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { hasCourseKnowledge } from '../lib/courses.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const ui = await loadUi(`
  export { documentNotes, default as SourcePicker } from './ui/SourcePicker.jsx';
  export { default as CitationDisclosure } from './ui/CitationDisclosure.jsx';
  export { default as Sources } from './ui/Sources.jsx';
  export {
    default as CourseMethodCard,
    stageNeedsMaterial,
    openCourseMaterialImport,
  } from './ui/CourseMethodCard.jsx';
  export { isVerifiableMaterialSource } from './ui/method-alternatives.js';
  export { NewCourse } from './ui/CourseSettings.jsx';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { deliverToChat } from './ui/hand-off/use-hand-off.js';
  export { buildHomePlan } from './ui/study-map/home-plan.js';
  export { default as TodayCard } from './ui/study-map/TodayCard.jsx';
  export { firstRunLine } from './ui/first-run/line.js';
  export { readPageScope } from './ui/PageScope.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const han = /[\u3400-\u9fff]/;
const plainText = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}

async function createLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-self-s2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  return { root, service };
}

test('source-provenance: AI_DRAFTED_SOURCE & INDEPENDENT_SOURCE validation, explicit vs legacy title inference, and cited card counting', () => {
  assert.equal(INDEPENDENT_SOURCE, 'independent-source');
  assert.equal(AI_DRAFTED_SOURCE, 'ai-drafted-unverified');
  assert.equal(normalizeSourceProvenance(undefined), undefined);
  assert.equal(normalizeSourceProvenance(null), undefined);
  assert.equal(normalizeSourceProvenance(''), undefined);
  assert.equal(normalizeSourceProvenance(INDEPENDENT_SOURCE), INDEPENDENT_SOURCE);
  assert.equal(normalizeSourceProvenance(AI_DRAFTED_SOURCE), AI_DRAFTED_SOURCE);
  assert.equal(normalizeSourceProvenance(JSON_CARD_SOURCE), JSON_CARD_SOURCE);
  assert.throws(() => normalizeSourceProvenance('guessed-by-llm'), /Invalid source provenance/);

  // Explicit provenance is authoritative (including INDEPENDENT_SOURCE overriding legacy AI-drafted titles)
  assert.equal(isAiDraftedSource({ id: 's1', title: 'Concurrency notes', provenance: AI_DRAFTED_SOURCE }), true);
  assert.equal(isAiDraftedSource({ id: 's2', title: 'Java 并发讲义（AI 撰写 · 未核对）' }), true);
  assert.equal(isAiDraftedSource({ id: 's3', title: '民法总则提纲 AI撰写-未核对' }), true);
  assert.equal(isAiDraftedSource({ id: 's4', title: 'AI 撰写 · 未核对（已人工核实）', provenance: INDEPENDENT_SOURCE }), false);
  assert.equal(isAiDraftedSource({ id: 's5', title: 'Official Lecture Slides Week 3' }), false);
  assert.equal(resolveSourceProvenance({ id: 's2', title: 'Java 并发讲义（AI 撰写 · 未核对）' }), AI_DRAFTED_SOURCE);
  assert.equal(resolveSourceProvenance({ id: 's4', title: 'AI 撰写 · 未核对（已人工核实）', provenance: INDEPENDENT_SOURCE }), INDEPENDENT_SOURCE);

  const sources = [
    { id: 'ai-1', title: 'Handout', provenance: AI_DRAFTED_SOURCE },
    { id: 'own-1', title: 'Textbook Ch.2' },
  ];
  const cards = [
    { id: 'c1', citations: [{ sourceId: 'own-1', quote: 'A' }] },
    { id: 'c2', citations: [{ sourceId: 'own-1', quote: 'A' }, { sourceId: 'ai-1', quote: 'B' }] },
    { id: 'c3', selections: [{ sourceId: 'ai-1', quote: 'C' }] },
  ];
  assert.equal(aiDraftedCitedCardCount(cards, sources), 2);
  assert.equal(aiDraftedCitedCardCount([cards[0]], sources), 0);
});

test('source.add, materials.document.import, and per-revision replacement persist and clear ai-drafted-unverified provenance cleanly without poisoning authentic revisions', async t => {
  const { root, service } = await createLibrary(t);
  await service.call('course.save', { name: 'Java 后端 + AI 求职' });

  await assert.rejects(
    () => service.call('source.add', { title: 'Bad provenance', text: 'Content', courses: ['Java 后端 + AI 求职'], provenance: 'bogus' }),
    /Invalid source provenance/,
  );

  // 1) source.add with explicit provenance, explicit independent-source override, and legacy title-only source
  const added = await service.call('source.add', {
    title: 'JVM 内存模型讲义',
    text: '# JVM 内存区域\n\n堆与线程私有的虚拟机栈分工明确。',
    courses: ['Java 后端 + AI 求职'],
    format: 'md',
    provenance: AI_DRAFTED_SOURCE,
  });
  assert.equal(added.provenance, AI_DRAFTED_SOURCE);

  const verifiedOverride = await service.call('source.add', {
    title: 'AI 撰写 · 未核对：已逐字核实版',
    text: '官方规范第 17 章明确规定先行发生关系。',
    courses: ['Java 后端 + AI 求职'],
    provenance: INDEPENDENT_SOURCE,
  });
  assert.equal(verifiedOverride.provenance, INDEPENDENT_SOURCE);

  const legacy = await service.call('source.add', {
    title: 'AI 撰写 · 未核对：线程池参数速查',
    text: '核心线程数、最大线程数与阻塞队列共同决定拒绝时机。',
    courses: ['Java 后端 + AI 求职'],
  });
  assert.equal(legacy.provenance, undefined);

  // 2) materials.document.import with provenance: 'ai-drafted-unverified' + refresh preservation
  const workDir = join(root, 'studyhub-work');
  await mkdir(workDir, { recursive: true });
  const mdPath = join(workDir, 'juc-stage1.md');
  await writeFile(mdPath, '# Java 集合与并发基础（AI 撰写 · 未核对）\n\nConcurrentHashMap 采用节点细粒度同步控制以降低锁竞争。\n', 'utf8');

  const imported = await service.call('materials.document.import', {
    path: mdPath,
    course: 'Java 后端 + AI 求职',
    title: 'Java 集合与并发基础（AI 撰写 · 未核对）',
    provenance: AI_DRAFTED_SOURCE,
  });
  assert.equal(imported.document.provenance, AI_DRAFTED_SOURCE);
  assert.ok(imported.sourceIds.length >= 1);
  assert.equal(imported.document.sources[0].provenance, AI_DRAFTED_SOURCE);

  // Refreshing from externalPath creates a new revision and preserves provenance on both current and historical revisions
  await writeFile(mdPath, '# Java 集合与并发基础（AI 撰写 · 未核对）\n\nConcurrentHashMap 采用节点细粒度同步控制以降低锁竞争，并避免整表锁。\n', 'utf8');
  const refreshed = await service.call('materials.document.get', { id: imported.documentId, refresh: true });
  assert.equal(refreshed.provenance, AI_DRAFTED_SOURCE);
  assert.equal(refreshed.sources[0].provenance, AI_DRAFTED_SOURCE);

  // 3) source.list (flat & groupBy:document), source.coverage, and compact snapshot report provenance & inferred legacy provenance
  const listed = await service.call('source.list', { course: 'Java 后端 + AI 求职' });
  const byId = new Map(listed.sources.map(item => [item.id, item]));
  assert.equal(byId.get(added.id)?.provenance, AI_DRAFTED_SOURCE);
  assert.equal(byId.get(added.id)?.provenanceInferred, undefined);
  assert.equal(byId.get(verifiedOverride.id)?.provenance, INDEPENDENT_SOURCE);
  assert.equal(byId.get(verifiedOverride.id)?.provenanceInferred, undefined);
  assert.equal(byId.get(legacy.id)?.provenance, AI_DRAFTED_SOURCE);
  assert.equal(byId.get(legacy.id)?.provenanceInferred, true);
  assert.equal(byId.get(refreshed.sourceIds[0])?.provenance, AI_DRAFTED_SOURCE);

  const groupedQuery = await service.call('source.list', { course: 'Java 后端 + AI 求职', groupBy: 'document' });
  const legacyGroup = groupedQuery.sources.find(g => g.group.id === legacy.id);
  assert.equal(legacyGroup?.provenance, AI_DRAFTED_SOURCE);
  assert.equal(legacyGroup?.provenanceInferred, true);

  const cov = await service.call('source.coverage', { course: 'Java 后端 + AI 求职' });
  assert.equal(cov.aiDraftedReferences.sources, 3);
  assert.equal(cov.aiDraftedReferences.unverified, true);

  const compact = await service.call('snapshot', { compact: true });
  assert.equal(compact.sources.find(s => s.id === added.id)?.provenance, AI_DRAFTED_SOURCE);
  assert.equal(compact.sources.find(s => s.id === legacy.id)?.provenance, AI_DRAFTED_SOURCE);
  assert.equal(compact.sources.find(s => s.id === legacy.id)?.provenanceInferred, true);
  assert.equal(compact.sources.find(s => s.id === refreshed.sourceIds[0])?.provenance, AI_DRAFTED_SOURCE);

  // 4) groupSourcesByDocument + documentNotes (lights up both Sources.jsx and SourcePicker.jsx)
  const full = await service.call('snapshot', {});
  const grouped = groupSourcesByDocument(full.sources);
  const importedDocItem = grouped.find(item => item.sourceIds.includes(refreshed.sourceIds[0]));
  assert.equal(importedDocItem?.provenance, AI_DRAFTED_SOURCE);

  ui.setUiLanguage('zh');
  assert.ok(ui.documentNotes(importedDocItem).includes('AI 撰写 · 未核对'));
  const pickerZh = renderToStaticMarkup(h(ui.SourcePicker, { sources: full.sources, selected: [], onChange: () => {} }));
  assert.match(pickerZh, /AI 撰写 · 未核对/);
  const sourcesPageZh = renderToStaticMarkup(inApp(ui, h(ui.Sources, {
    data: full,
    onAdd: () => {},
    onGenerateFrom: () => {},
    onOpenDocument: () => {},
  }), { data: full }));
  assert.match(sourcesPageZh, /AI 撰写 · 未核对/, 'Sources.jsx displays AI 撰写 · 未核对 badge on the document row');

  // 5) Replacing an AI-drafted document via materials.document.attach WITHOUT provenance clears AI-drafted on the new revision
  //    (even when existing.title still contains "AI 撰写 · 未核对") while preserving AI-drafted on historical revision sources!
  const authenticPath = join(workDir, 'juc-official-notes.md');
  await writeFile(authenticPath, '# Java 并发包权威讲义\n\nDoug Lea 设计的 AQS 通过 CLH 变体队列管理同步状态。\n', 'utf8');
  const attached = await service.call('materials.document.attach', {
    documentId: imported.documentId,
    path: authenticPath,
  });
  assert.equal(attached.document.provenance, INDEPENDENT_SOURCE, 'authentic replacement revision stamps independent-source so retained title never triggers AI-drafted');
  assert.equal(isAiDraftedSource(attached.document), false, 'described document is independent even before renaming title');
  assert.equal(isAiDraftedSource(attached.document.sources[0]), false, 'new revision source is independent even before renaming title');

  const afterAttachSnap = await service.call('snapshot', {});
  const afterAttachGrouped = groupSourcesByDocument(afterAttachSnap.sources);
  const replacedDocItem = afterAttachGrouped.find(item => item.sourceIds.includes(attached.sourceIds[0]));
  assert.equal(replacedDocItem?.provenance, INDEPENDENT_SOURCE);
  assert.equal(isAiDraftedSource(replacedDocItem), false);
  assert.equal(ui.documentNotes(replacedDocItem).includes('AI 撰写 · 未核对'), false, 'groupSourcesByDocument + documentNotes clear AI-drafted badge on Rev 2');

  // A second authentic attach (Rev 3) without provenance also keeps INDEPENDENT_SOURCE instead of resurrecting AI-drafted from retained title
  await writeFile(authenticPath, '# Java 并发包权威讲义（第 2 版）\n\nDoug Lea 设计的 AQS 通过 CLH 变体队列与 CAS 管理同步状态。\n', 'utf8');
  const attachedRev3 = await service.call('materials.document.attach', {
    documentId: imported.documentId,
    path: authenticPath,
  });
  assert.equal(attachedRev3.document.provenance, INDEPENDENT_SOURCE);
  assert.equal(isAiDraftedSource(attachedRev3.document), false);
  const afterRev3Snap = await service.call('snapshot', {});
  const rev3DocItem = groupSourcesByDocument(afterRev3Snap.sources).find(item => item.sourceIds.includes(attachedRev3.sourceIds[0]));
  assert.equal(rev3DocItem?.provenance, INDEPENDENT_SOURCE);
  assert.equal(ui.documentNotes(rev3DocItem).includes('AI 撰写 · 未核对'), false, 'Rev 3 also has zero AI 撰写 · 未核对 badge');

  const afterAttachList = await service.call('source.list', { course: 'Java 后端 + AI 求职' });
  const afterById = new Map(afterAttachList.sources.map(item => [item.id, item]));
  assert.equal(afterById.get(attachedRev3.sourceIds[0])?.provenance, INDEPENDENT_SOURCE);

  // Historical revisions retain their exact AI-drafted provenance for older citations
  const historicalDoc = await service.call('materials.document.get', { id: imported.documentId, revision: refreshed.revision });
  assert.equal(historicalDoc.provenance, AI_DRAFTED_SOURCE);
  const byHistoricalSource = await service.call('materials.document.get', { sourceId: refreshed.sourceIds[0] });
  assert.equal(byHistoricalSource.provenance, AI_DRAFTED_SOURCE);
  const historicalSourceSummary = await service.call('source.list', { sourceIds: [refreshed.sourceIds[0]] });
  assert.equal(historicalSourceSummary.sources[0]?.provenance, AI_DRAFTED_SOURCE);
  assert.equal(historicalSourceSummary.sources[0]?.historical, true);

  // 6) CitationDisclosure renders provenance badge (.citations__provenance) + warning Hint in both zh-CN and English
  ui.setUiLanguage('en');
  const asciiSources = [{ id: 'en-ai-1', title: 'Stage 1 Handout', text: 'ConcurrentHashMap synchronization.', courses: ['Systems'], provenance: AI_DRAFTED_SOURCE }];
  assert.ok(ui.documentNotes(importedDocItem).includes('AI-drafted · unverified'));
  const pickerEn = renderToStaticMarkup(h(ui.SourcePicker, { sources: asciiSources, selected: [], onChange: () => {} }));
  assert.match(pickerEn, /AI-drafted · unverified/);
  assert.doesNotMatch(pickerEn, han);

  const card = {
    id: 'card-1',
    citations: [{ sourceId: 'en-ai-1', quote: 'ConcurrentHashMap synchronization.' }],
  };
  for (const [lang, badgeText, hintText] of [
    ['zh', 'AI 撰写 · 未核对', '这些引用含「AI 撰写 · 未核对」讲义，请结合权威资料核实。'],
    ['en', 'AI-drafted · unverified', 'These citations include an AI-drafted, unverified handout; verify key claims against authoritative sources.'],
  ]) {
    ui.setUiLanguage(lang);
    const closedMarkup = renderToStaticMarkup(h(ui.CitationDisclosure, { card, sources: asciiSources, onOpenSource: () => {} }));
    assert.doesNotMatch(closedMarkup, /citations__provenance/, `${lang}: collapsed disclosure stays compact`);

    const openMarkup = renderToStaticMarkup(h(ui.CitationDisclosure, { card, sources: asciiSources, onOpenSource: () => {}, defaultOpen: true }));
    assert.match(openMarkup, /citations__provenance/, `${lang}: expanded disclosure carries citations__provenance badge`);
    const text = plainText(openMarkup);
    assert.ok(text.includes(badgeText), `${lang}: renders provenance badge (${text})`);
    assert.ok(text.includes(hintText), `${lang}: renders warning hint (${text})`);
    if (lang === 'en') assert.doesNotMatch(text, han, 'English CitationDisclosure has zero leftover Chinese');
  }

  // Independent source citation shows neither badge nor AI-drafted warning
  ui.setUiLanguage('zh');
  const independentMarkup = renderToStaticMarkup(h(ui.CitationDisclosure, {
    card: { id: 'card-2', citations: [{ sourceId: 'own-src', quote: 'Authoritative theorem.' }] },
    sources: [{ id: 'own-src', title: 'Textbook Chapter 4', text: 'Authoritative theorem.' }],
    onOpenSource: () => {},
    defaultOpen: true,
  }));
  assert.doesNotMatch(independentMarkup, /AI 撰写 · 未核对|citations__provenance/);
});

test('CourseMethodCard shows 还没有资料 · 导入，或请主会话起草 only on custom-method stages lacking material, rejects historical sources, scopes 导入 to course, and carries learner notes in method.draftMaterial', async () => {
  ui.setUiLanguage('zh');
  const emptyData = {
    root: '/lib/self-study',
    courses: [
      { id: 'c-default', name: '数据结构' },
      {
        id: 'c-custom',
        name: '民法总则考证',
        method: {
          version: 1,
          name: '法考三轮推进',
          targetDate: '2027-09-15',
          stages: [
            { name: '精读核心法条与请求权基础', activity: 'publish', alternatives: ['explain'], level: 'loose' },
            { name: '真题案例拆解与巩固', activity: 'practice', alternatives: ['review'], level: 'medium' },
          ],
        },
      },
    ],
    sources: [],
    decks: [],
    attempts: [],
  };

  // 1) Untouched default classroom course (!own) shows ZERO missing-material clutter
  const defaultHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: emptyData.courses[0],
    readout: { index: 0, total: 3, own: false },
    data: emptyData,
  }), { data: emptyData }));
  assert.doesNotMatch(defaultHtml, /还没有资料|请主会话起草/);

  // 2) Custom-method course with no materials (or only historical/archived sources) prompts on its active stage
  const customCourse = emptyData.courses[1];
  assert.equal(ui.isVerifiableMaterialSource({ id: 'hist-1', title: 'Old rev', text: 'Old text', historical: true }), false);
  assert.equal(ui.stageNeedsMaterial(emptyData, customCourse, customCourse.method.stages[0], { own: true, index: 0, current: 0 }), true);
  assert.equal(ui.stageNeedsMaterial({ ...emptyData, sources: [{ id: 'hist-1', title: 'Old', text: 'Old', historical: true, courses: ['民法总则考证'] }] }, customCourse, customCourse.method.stages[0], { own: true, index: 0, current: 0 }), true);
  assert.equal(ui.stageNeedsMaterial(emptyData, customCourse, customCourse.method.stages[1], { own: true, index: 1, current: 0 }), false);

  // Explicit stage.sourceIds checks per-stage verifiable sources (ignoring archived/historical/sample/empty)
  const stageWithIds = { name: '案例研习', activity: 'practice', alternatives: [], level: 'medium', sourceIds: ['src-missing'] };
  assert.equal(ui.stageNeedsMaterial({ ...emptyData, sources: [{ id: 'src-other', title: '总则讲义', text: '法条', courses: ['民法总则考证'] }] }, customCourse, stageWithIds, { own: true, index: 1, current: 0 }), true);
  assert.equal(ui.stageNeedsMaterial({ ...emptyData, sources: [{ id: 'src-missing', title: '已归档', text: '请求权', archived: true, courses: ['民法总则考证'] }] }, customCourse, stageWithIds, { own: true, index: 1, current: 0 }), true);
  assert.equal(ui.stageNeedsMaterial({ ...emptyData, sources: [{ id: 'src-missing', title: '历史版本', text: '请求权', historical: true, courses: ['民法总则考证'] }] }, customCourse, stageWithIds, { own: true, index: 1, current: 0 }), true);
  assert.equal(ui.stageNeedsMaterial({ ...emptyData, sources: [{ id: 'src-missing', title: '案例讲义', text: '请求权', courses: ['民法总则考证'] }] }, customCourse, stageWithIds, { own: true, index: 1, current: 0 }), false);

  // 3) CourseMethodCard markup renders the missing-material row (with .course-method__missing-import keeping comma flush) and method.draftMaterial hand-off
  const customHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: customCourse,
    readout: { index: 0, total: 2, own: true },
    data: emptyData,
    initialNote: '多结合法律行为效力与善意取得的对比案例',
  }), { data: emptyData, host: { capabilities: { chat: true } } }));
  assert.match(customHtml, /course-method__missing-import/);
  assert.match(customHtml, />导入<\/button>，或<\/span>/);
  assert.match(plainText(customHtml), /还没有资料 · 导入 ，或 请主会话起草/);
  assert.match(customHtml, /data-hand-off="method\.draftMaterial"/);
  assert.match(customHtml, /多结合法律行为效力与善意取得的对比案例/);

  // 4) Clicking 导入 scopes `sources` to course.name, clears sourceFocusId, navigates to 'sources', and closes with 'import-material'
  const navCalls = [];
  const closedReasons = [];
  const scopeCalls = [];
  let focusCleared = false;
  const scopeStorage = memoryStorage();

  ui.openCourseMaterialImport({
    data: emptyData,
    course: customCourse,
    navigate: page => navCalls.push(page),
    appSet: {
      setPageScopeCourse: name => scopeCalls.push(name),
      setSourceFocusId: value => { if (value === null) focusCleared = true; },
    },
    onClose: reason => closedReasons.push(reason),
    scopeStorage,
  });
  assert.equal(ui.readPageScope('/lib/self-study', 'sources', scopeStorage), '民法总则考证');
  assert.deepEqual(scopeCalls, ['民法总则考证']);
  assert.equal(focusCleared, true);
  assert.deepEqual(navCalls, ['sources']);
  assert.deepEqual(closedReasons, ['import-material']);

  // 5) method.draftMaterial prompt carries course, stage, methodName, and custom learner note into main chat
  const promptText = ui.handOffText('method.draftMaterial', {
    course: customCourse.name,
    stage: customCourse.method.stages[0].name,
    stageIndex: 1,
    methodName: customCourse.method.name,
    note: '多结合法律行为效力与善意取得的对比案例',
  }, 'zh');
  const sentChat = [];
  const outcome = await ui.deliverToChat({
    host: { askInChat: text => { sentChat.push(text); return 'filled'; } },
    prompt: promptText,
    notify: () => {},
    openSheet: () => {},
  });
  assert.equal(outcome, 'filled');
  assert.equal(sentChat.length, 1);
  assert.match(sentChat[0], /民法总则考证/);
  assert.match(sentChat[0], /精读核心法条与请求权基础/);
  assert.match(sentChat[0], /法考三轮推进/);
  assert.match(sentChat[0], /```request 我的补充说明\n多结合法律行为效力与善意取得的对比案例\n```/);
  assert.match(sentChat[0], /document\.import/);
  assert.match(sentChat[0], /ai-drafted-unverified/);
  assert.match(sentChat[0], /不要直接出题/);

  // 6) Once verifiable material is added to the course, the missing-material row disappears cleanly
  const withMaterial = {
    ...emptyData,
    sources: [{ id: 's-law-1', title: '民法总则讲义', text: '民事法律行为自成立时生效。', courses: ['民法总则考证'] }],
  };
  const populatedHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: customCourse,
    readout: { index: 0, total: 2, own: true },
    data: withMaterial,
  }), { data: withMaterial }));
  assert.doesNotMatch(populatedHtml, /还没有资料|请主会话起草/);

  // 7) English UI renders zero Chinese when course/stage names are English
  ui.setUiLanguage('en');
  const enCourse = {
    id: 'c-en',
    name: 'Clinical Pharmacology',
    method: {
      version: 1,
      name: 'Board Prep',
      targetDate: null,
      stages: [{ name: 'Autonomic receptor mechanisms', activity: 'publish', alternatives: [], level: 'medium' }],
    },
  };
  const enData = { ...emptyData, courses: [enCourse] };
  const enHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: enCourse,
    readout: { index: 0, total: 1, own: true },
    data: enData,
  }), { data: enData }));
  assert.match(enHtml, />Import<\/button>, or<\/span>/);
  assert.match(plainText(enHtml), /No sources yet · Import , or Ask main chat to draft/);
  assert.doesNotMatch(plainText(enHtml), han);
  ui.setUiLanguage('zh');
});

test('NewCourse entry, self.start prompt, SKILL.md, and libraryContracts stay aligned across both entry points', async () => {
  ui.setUiLanguage('zh');
  const zhNew = renderToStaticMarkup(inApp(ui, h(ui.NewCourse, { initial: { open: true, name: '临床执业医师二试冲刺' } })));
  assert.match(plainText(zhNew), /手上还没有资料？/);
  assert.match(plainText(zhNew), /自学目标（求职 \/ 考证 \/ 自学技能）/);

  ui.setUiLanguage('en');
  const enNew = renderToStaticMarkup(inApp(ui, h(ui.NewCourse, { initial: { open: true, name: 'Bar Exam Torts' } })));
  assert.match(plainText(enNew), /No material yet\?/);
  assert.match(plainText(enNew), /Self-study goal \(career \/ exams \/ skills\)/);
  assert.doesNotMatch(plainText(enNew), han);

  // self.start carries open-ended goal, focus.set instruction, and ai-drafted-unverified provenance
  const selfZh = ui.handOffText('self.start', { goal: 'Java 后端 + AI 求职' }, 'zh');
  assert.match(selfZh, /Java 后端 \+ AI 求职/);
  assert.match(selfZh, /focus\.set/);
  assert.match(selfZh, /ai-drafted-unverified/);
  assert.match(selfZh, /AI 撰写 · 未核对/);

  const skill = await readFile('skills/study-self/SKILL.md', 'utf8');
  assert.match(skill, /自学目标（求职 \/ 考证 \/ 自学技能）/);
  assert.match(skill, /focus\.set \{"mode": "class", "course": "<课程名>"\}/);
  assert.match(skill, /document\.import/);
  assert.match(skill, /ai-drafted-unverified/);
  assert.match(skill, /还没有资料 · 导入，或请主会话起草/);
  assert.match(skill, /不要把第 1 阶段实质内容标成 `publish`/);
  assert.match(skill, /开始第 ① 阶段/);

  assert.match(libraryContracts.sources, /source\.add \{[^}]*provenance\?:'ai-drafted-unverified'\|'independent-source'/);
  assert.match(libraryContracts.imports, /document\.import \{[^}]*provenance\?:'ai-drafted-unverified'\|'independent-source'/);
  ui.setUiLanguage('zh');
});

test('StudyService course.save { name, method } + focus.set works across full S2 lifecycle, publish Stage-1 auto-advance, and multi-course/system-deck open runs', async t => {
  ui.setUiLanguage('zh');
  const { root, service } = await createLibrary(t);
  const method = {
    name: '四阶段求职推进',
    targetDate: '2027-03-15',
    stages: [
      { name: '把 Java 集合和并发过一遍', activity: 'practice', alternatives: ['explain'], level: 'loose' },
      { name: 'JVM 与高并发实战练习', activity: 'review', alternatives: ['check'], level: 'medium' },
    ],
  };

  // 1) Empty library (no model / learner-imports-later): course with method is a real library course immediately
  const saved = await service.call('course.save', { name: 'Java 后端 + AI 求职', method });
  assert.equal(hasCourseKnowledge(saved.course ?? saved), true);
  await service.call('focus.set', { mode: 'class', course: 'Java 后端 + AI 求职' });

  const emptySnap = await service.call('snapshot', {});
  assert.equal(emptySnap.focus.course, 'Java 后端 + AI 求职');
  assert.equal(emptySnap.focus.method?.own, true);
  assert.equal(emptySnap.focus.method?.index, 0);
  assert.equal(ui.firstRunLine(emptySnap).show, false, 'empty library with a saved custom-method course renders Home desk instead of generic first-run line');

  const actionsUsed = [];
  const makeActions = () => ({
    start: args => actionsUsed.push(['start', args]),
    resume: id => actionsUsed.push(['resume', id]),
    openDraft: draft => actionsUsed.push(['openDraft', draft.id]),
    addSource: () => actionsUsed.push(['addSource']),
    importLibrary: () => actionsUsed.push(['importLibrary']),
    generateFromSources: ids => actionsUsed.push(['generateFromSources', ids]),
    onCourseSettings: id => actionsUsed.push(['onCourseSettings', id]),
  });

  const emptyMethodHome = ui.buildHomePlan({
    data: emptySnap,
    today: emptySnap.today,
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(emptyMethodHome.plan.eyebrow, '第 ① 阶段');
  assert.equal(emptyMethodHome.plan.action.label, '开始第 ① 阶段');
  emptyMethodHome.plan.action.run();
  assert.deepEqual(actionsUsed.at(-1), ['onCourseSettings', emptySnap.focus.courseId]);

  // Full S2 lifecycle against real StudyService: import AI-drafted handout -> generateFromSources -> draft ready -> publish deck -> practice Stage 1
  const s2WorkDir = join(root, 'studyhub-work');
  await mkdir(s2WorkDir, { recursive: true });
  const handoutPath = join(s2WorkDir, 'stage1-juc.md');
  await writeFile(handoutPath, '# 第 1 阶段讲义（AI 撰写 · 未核对）\n\nConcurrentHashMap 采用桶级 CAS 与细粒度同步。\n', 'utf8');
  const stage1Doc = await service.call('materials.document.import', {
    path: handoutPath,
    course: 'Java 后端 + AI 求职',
    title: '第 1 阶段讲义（AI 撰写 · 未核对）',
    provenance: AI_DRAFTED_SOURCE,
  });
  const afterMatSnap = await service.call('snapshot', {});
  assert.equal(afterMatSnap.focus.method?.index, 0, 'Stage 1 practice stays at index 0 after importing handout');
  const afterMatHome = ui.buildHomePlan({
    data: afterMatSnap,
    today: afterMatSnap.today,
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(afterMatHome.plan.action.label, '开始第 ① 阶段');
  assert.equal(Boolean(afterMatHome.plan.action.disabled), false);
  afterMatHome.plan.action.run();
  assert.deepEqual(actionsUsed.at(-1), ['generateFromSources', stage1Doc.sourceIds]);

  const importedDraft = await service.call('draft.import', {
    course: 'Java 后端 + AI 求职',
    text: JSON.stringify({
      title: 'Java 并发第 1 阶段草稿',
      course: 'Java 后端 + AI 求职',
      cards: [{
        kind: 'flashcard',
        prompt: 'ConcurrentHashMap 如何降低写竞争？',
        answer: '桶级 CAS 与细粒度同步',
        explanation: '采用桶级 CAS 与细粒度同步控制。',
        citations: [{ sourceId: stage1Doc.sourceIds[0], quote: 'ConcurrentHashMap 采用桶级 CAS 与细粒度同步。' }],
      }],
    }),
  });
  const afterDraftSnap = await service.call('snapshot', {});
  const afterDraftHome = ui.buildHomePlan({
    data: afterDraftSnap,
    today: afterDraftSnap.today,
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(afterDraftHome.plan.action.label, '开始第 ① 阶段');
  afterDraftHome.plan.action.run();
  assert.deepEqual(actionsUsed.at(-1), ['openDraft', importedDraft.id]);

  await service.store.update(state => {
    const published = state.drafts.find(d => d.id === importedDraft.id);
    state.drafts = state.drafts.filter(d => d.id !== importedDraft.id);
    state.decks.push({ ...published, id: 'd-s2-stage1', createdAt: '2026-11-08T00:00:00Z' });
  });
  const afterPubSnap = await service.call('snapshot', {});
  assert.equal(afterPubSnap.focus.method?.index, 0);
  assert.equal(afterPubSnap.today?.size, 1);
  const afterPubHome = ui.buildHomePlan({
    data: afterPubSnap,
    today: afterPubSnap.today,
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(afterPubHome.plan.eyebrow, '第 ① 阶段');
  assert.equal(afterPubHome.plan.action.label, '开始第 ① 阶段');
  assert.equal(Boolean(afterPubHome.plan.action.disabled), false);
  afterPubHome.plan.action.run();
  assert.equal(actionsUsed.at(-1)[0], 'start');

  // 1b) Custom method that explicitly uses `activity: 'publish'` for Stage 1: importing material advances index to 1,
  //     and buildHomePlan offers actionable `用这 1 份资料出题` / `检查草稿` instead of a disabled `开始今日学习`!
  const { root: pubRoot, service: pubService } = await createLibrary(t);
  await pubService.call('course.save', {
    name: '系统设计冲刺',
    method: {
      name: '先导资料再练',
      targetDate: null,
      stages: [
        { name: '收集并导入核心架构讲义', activity: 'publish', alternatives: [], level: 'loose' },
        { name: '缓存与限流专题练习', activity: 'practice', alternatives: ['explain'], level: 'medium' },
      ],
    },
  });
  await pubService.call('focus.set', { mode: 'class', course: '系统设计冲刺' });
  const pubMd = join(pubRoot, 'arch.md');
  await writeFile(pubMd, '# 架构讲义\n\n令牌桶支持突发流量平滑限流。\n', 'utf8');
  const pubDoc = await pubService.call('materials.document.import', { path: pubMd, course: '系统设计冲刺', title: '架构讲义' });
  const pubMatSnap = await pubService.call('snapshot', {});
  assert.equal(pubMatSnap.focus.method?.index, 1, 'publish Stage 1 auto-advances to Stage 2 once material is imported');
  const pubMatHome = ui.buildHomePlan({
    data: pubMatSnap,
    today: pubMatSnap.today,
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === '系统设计冲刺',
    actions: makeActions(),
  });
  assert.equal(pubMatHome.plan.action.label, '用这 1 份资料出题', 'publish Stage-1 auto-advance offers actionable generation instead of disabled 开始今日学习');
  assert.equal(Boolean(pubMatHome.plan.action.disabled), false);
  pubMatHome.plan.action.run();
  assert.deepEqual(actionsUsed.at(-1), ['generateFromSources', pubDoc.sourceIds]);

  const pubDraft = await pubService.call('draft.import', {
    course: '系统设计冲刺',
    text: JSON.stringify({
      title: '限流第一批草稿',
      course: '系统设计冲刺',
      cards: [{ kind: 'flashcard', prompt: '令牌桶特点？', answer: '支持突发流量平滑限流', citations: [{ sourceId: pubDoc.sourceIds[0], quote: '令牌桶支持突发流量平滑限流。' }] }],
    }),
  });
  const pubDraftSnap = await pubService.call('snapshot', {});
  const pubDraftHome = ui.buildHomePlan({
    data: pubDraftSnap,
    today: pubDraftSnap.today,
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === '系统设计冲刺',
    actions: makeActions(),
  });
  assert.equal(pubDraftHome.plan.action.label, '检查草稿');
  assert.equal(Boolean(pubDraftHome.plan.action.disabled), false);
  pubDraftHome.plan.action.run();
  assert.deepEqual(actionsUsed.at(-1), ['openDraft', pubDraft.id]);

  // 2) Plain course without custom method.own stays 100% unchanged
  const plainData = {
    root: '/lib/plain',
    focus: { mode: 'class', course: '数据结构', courseId: 'c-plain', method: { course: '数据结构', own: false, index: 0, total: 3, counts: { answered: 0 } } },
    courses: [{ id: 'c-plain', name: '数据结构' }],
    decks: [{ id: 'd-plain', title: '数组与链表', course: '数据结构', count: 10 }],
    sources: [{ id: 's-plain', title: '讲义 1', text: '链表', courses: ['数据结构'] }],
    drafts: [],
    jobs: [],
  };
  const plainHome = ui.buildHomePlan({
    data: plainData,
    today: { course: '数据结构', due: 0, weak: 0, new: 10, size: 10, scope: [{ deckId: 'd-plain', cardId: 'q1' }] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === '数据结构',
    actions: makeActions(),
  });
  assert.equal(plainHome.plan.action.label, '开始今日学习');
  assert.equal(plainHome.todayAction.label, '开始今日学习');
  assert.equal(ui.firstRunLine({ ...plainData, decks: [] }).show, true);

  // 3) Existing library with another course's open run (`lastOpen`): Stage 1 custom-method course keeps 开始第 ① 阶段 on main card
  //    while keeping the other course's open run reachable in `otherRuns`!
  const crossCourseRun = { id: 'run-ds-1', deckId: 'd-ds', title: '红黑树练习', total: 10, index: 3 };
  const multiCourseData = {
    root: '/lib/multi',
    focus: {
      mode: 'class',
      course: 'Java 后端 + AI 求职',
      courseId: 'c-java',
      method: {
        course: 'Java 后端 + AI 求职',
        own: true,
        index: 0,
        total: 4,
        stage: { name: '把 Java 集合和并发过一遍', activity: 'practice', alternatives: ['explain'], level: 'medium' },
        counts: { materials: 1, cards: 0, answered: 0, right: 0 },
      },
    },
    lastRun: { id: 'run-ds-1' },
    courses: [{ id: 'c-ds', name: '数据结构' }, { id: 'c-java', name: 'Java 后端 + AI 求职' }],
    decks: [{ id: 'd-ds', title: '红黑树练习', course: '数据结构', count: 10 }],
    sources: [{ id: 's-java', title: '并发讲义', text: 'ConcurrentHashMap', courses: ['Java 后端 + AI 求职'], provenance: AI_DRAFTED_SOURCE }],
    drafts: [{ id: 'draft-java-1', title: '第 1 阶段草稿', course: 'Java 后端 + AI 求职', cards: [{ id: 'c1' }, { id: 'c2' }] }],
    jobs: [],
  };
  const crossHome = ui.buildHomePlan({
    data: multiCourseData,
    today: { course: 'Java 后端 + AI 求职', due: 0, weak: 0, new: 0, size: 0, scope: [] },
    runs: [crossCourseRun],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(crossHome.plan.eyebrow, '第 ① 阶段', 'other course lastOpen does not hijack new Stage 1 course main card');
  assert.equal(crossHome.plan.action.label, '开始第 ① 阶段');
  assert.equal(crossHome.otherRuns.length, 1);
  assert.equal(crossHome.otherRuns[0].id, 'run-ds-1');
  crossHome.plan.action.run();
  assert.deepEqual(actionsUsed.at(-1), ['openDraft', 'draft-java-1']);

  // Multi-course `一起学` across two other courses AND `为你定制` system-deck runs also do not hijack Stage 1
  for (const foreignRun of [
    { id: 'run-multi-other', deckIds: ['d-ds', 'd-os'], title: '跨课一起学', total: 12, index: 4 },
    { id: 'run-coach-sys', deckId: 'd-coach', title: '为你定制', total: 6, index: 1 },
  ]) {
    const foreignHome = ui.buildHomePlan({
      data: {
        ...multiCourseData,
        lastRun: { id: foreignRun.id },
        decks: [
          { id: 'd-ds', title: '红黑树练习', course: '数据结构', count: 10 },
          { id: 'd-os', title: '进程调度', course: '操作系统', count: 10 },
          { id: 'd-coach', title: '为你定制', systemKind: 'coach', count: 6 },
        ],
      },
      today: { course: 'Java 后端 + AI 求职', due: 0, weak: 0, new: 0, size: 0, scope: [] },
      runs: [foreignRun],
      runFor: () => null,
      activeJobs: [],
      inFocus: c => c === 'Java 后端 + AI 求职',
      actions: makeActions(),
    });
    assert.equal(foreignHome.plan.eyebrow, '第 ① 阶段', `${foreignRun.id} does not hijack Stage 1`);
    assert.equal(foreignHome.plan.action.label, '开始第 ① 阶段');
  }

  // If `lastOpen` belongs to the SAME Stage 1 course, 接着上次 resumes it AND preserves 开始第 ① 阶段 in alternatives
  const sameCourseRun = { id: 'run-java-custom', deckId: 'd-java-1', title: '并发预热', total: 8, index: 2 };
  const sameRunHome = ui.buildHomePlan({
    data: {
      ...multiCourseData,
      lastRun: { id: 'run-java-custom' },
      decks: [{ id: 'd-java-1', title: '并发预热', course: 'Java 后端 + AI 求职', count: 8 }],
      drafts: [],
    },
    today: { course: 'Java 后端 + AI 求职', due: 0, weak: 0, new: 8, size: 8, scope: [{ deckId: 'd-java-1', cardId: 'q1' }] },
    runs: [sameCourseRun],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(sameRunHome.plan.eyebrow, '接着上次');
  assert.ok(sameRunHome.alternatives.some(([label]) => label === '开始第 ① 阶段'), 'preserves 开始第 ① 阶段 link when resuming same-course run');

  // 4) Custom-method course on Stage 1 with published questions ready (today.size > 0): TodayCard renders 开始第 ① 阶段 in zh & en
  const publishedStage1Data = {
    ...multiCourseData,
    lastRun: null,
    decks: [{ id: 'd-java-1', title: 'Java 并发第一批', course: 'Java 后端 + AI 求职', count: 8 }],
    drafts: [],
  };
  const readyHome = ui.buildHomePlan({
    data: publishedStage1Data,
    today: { course: 'Java 后端 + AI 求职', due: 0, weak: 0, new: 8, size: 8, scope: [{ deckId: 'd-java-1', cardId: 'q1' }] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(readyHome.plan.eyebrow, '第 ① 阶段');
  assert.equal(readyHome.plan.action.label, '开始第 ① 阶段');
  assert.equal(readyHome.todayAction.label, '开始第 ① 阶段');

  const todayCardHtml = renderToStaticMarkup(inApp(ui, h(ui.TodayCard, { plan: readyHome.plan, todayLabel: '11月8日周日' })));
  assert.match(plainText(todayCardHtml), /第 ① 阶段/);
  assert.match(plainText(todayCardHtml), /开始第 ① 阶段/);

  ui.setUiLanguage('en');
  const readyHomeEn = ui.buildHomePlan({
    data: { ...publishedStage1Data, focus: { ...publishedStage1Data.focus, course: 'Java Backend', method: { ...publishedStage1Data.focus.method, course: 'Java Backend' } } },
    today: { course: 'Java Backend', due: 0, weak: 0, new: 8, size: 8, scope: [{ deckId: 'd-java-1', cardId: 'q1' }] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java Backend',
    actions: makeActions(),
  });
  assert.equal(readyHomeEn.plan.eyebrow, 'Stage 1');
  assert.equal(readyHomeEn.plan.action.label, 'Start stage 1');
  assert.doesNotMatch(readyHomeEn.plan.action.label, han);
  ui.setUiLanguage('zh');

  // 5) Once the learner has answered at least 1 question, standard 今日学习 label resumes
  const startedData = {
    ...publishedStage1Data,
    focus: {
      ...publishedStage1Data.focus,
      method: { ...publishedStage1Data.focus.method, counts: { materials: 1, cards: 8, answered: 3, right: 2 } },
    },
  };
  const progressedHome = ui.buildHomePlan({
    data: startedData,
    today: { course: 'Java 后端 + AI 求职', due: 0, weak: 1, new: 5, size: 6, scope: [{ deckId: 'd-java-1', cardId: 'q4' }] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === 'Java 后端 + AI 求职',
    actions: makeActions(),
  });
  assert.equal(progressedHome.plan.action.label, '开始今日学习');
});
