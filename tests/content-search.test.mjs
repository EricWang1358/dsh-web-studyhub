import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { markdownToPlainText, plainExcerpt, searchLibraryContent } from '../lib/contexts/library/content-search.js';
import { seedBookFixture, BOOK_COURSE } from './helpers/book-fixtures.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { default as FinderSheet } from './ui/finder/FinderSheet.jsx';
  export { useFinder } from './ui/finder/use-finder.js';
  export { searchLibraryHits } from './ui/finder/library-hits.js';
  export { shouldSearchContent, toFinderContentEntries, highlightSnippetParts } from './ui/finder/content-hits.js';
  export { keptBook } from './ui/book/model.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const HAN = /[\u3400-\u9fff]/;
const noop = () => {};
const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('markdownToPlainText and plainExcerpt strip Markdown syntax cleanly and populate snapshot.notes[].excerpt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-note-excerpt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  t.after(() => service.dispose());

  assert.equal(
    markdownToPlainText('# 热力学笔记\n\n> **核心定律**：孤立系统的**熵**永不减少（`ΔS >= 0`），详见[第二定律](https://example.com)。[^1]\n\n[^1]: 讲义 p.3'),
    '热力学笔记\n\n核心定律：孤立系统的熵永不减少（ΔS >= 0），详见第二定律。',
  );
  assert.ok(plainExcerpt('# 标题\n\n' + '内容片段 '.repeat(60), 160).length <= 161);

  await service.store.update((state) => {
    state.decks.push({
      id: 'd-thermo',
      title: '热力学基础',
      course: 'Physics',
      cards: [{ id: 'c1', kind: 'flashcard', topic: '热力学第二定律', prompt: '什么是熵？', answer: '状态函数。' }],
    });
    state.notes.push({
      id: 'note-entropy',
      title: '第二章课堂整理',
      cards: [{ deckId: 'd-thermo', cardId: 'c1' }],
      markdown: '# 第二章课堂整理\n\n## 核心概念\n\n克劳修斯不等式表明可逆卡诺循环的热温商之和为零，不可逆过程产生**熵增**。',
      status: 'draft',
      revision: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
  });

  const snap = await service.call('snapshot');
  const projectedNote = snap.notes.find((n) => n.id === 'note-entropy');
  assert.ok(projectedNote, 'note is present in snapshot');
  assert.equal(Object.hasOwn(projectedNote, 'markdown'), false, 'full markdown stays out of snapshot');
  assert.equal(typeof projectedNote.excerpt, 'string');
  assert.ok(projectedNote.excerpt.includes('可逆卡诺循环'), projectedNote.excerpt);
  assert.doesNotMatch(projectedNote.excerpt, /#|\*\*|`/, 'markdown markers stripped from note.excerpt');

  // Local Finder note matching works immediately via note.excerpt!
  const localHits = uiMod.searchLibraryHits(snap, '可逆卡诺循环');
  assert.equal(localHits.length, 1);
  assert.deepEqual(localHits[0].target, { kind: 'note', id: 'note-entropy' });
});

test('search.content supports single-Han CJK queries ("熵", "锁"), multi-term queries, andall 4 domains while excluding archived/sample items', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-content-search-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  // Seed review book fixture first (gives a real StudyHub review book in `ArchSS`)
  await seedBookFixture(root, 'archss');

  // Also seed a disk `course-books/Thermodynamics/ch2-entropy.md` chapter file to verify disk `course-books/` support!
  const diskBookDir = join(root, 'course-books', 'Thermodynamics');
  await mkdir(diskBookDir, { recursive: true });
  await writeFile(
    join(diskBookDir, 'ch2-entropy.md'),
    [
      '# 第二章 熵与统计解释',
      '',
      '第一段介绍宏观热机效率与卡诺定理的基本背景。',
      '',
      '第二段重点指出：玻尔兹曼公式 S = k ln Ω 将宏观**熵**与微观状态数联系起来，单字检索也能命中。',
      '',
      '第三段补充分布式系统中互斥**锁**与两阶段加锁的对比类比。',
    ].join('\n'),
    'utf8',
  );

  const service = new StudyService(root);
  t.after(() => service.dispose());

  const pageText = '前导段落说明状态参量。\n在这一页中，孤立系统的熵（Entropy）用于度量微观无序度，且两阶段锁保证可串行化。';
  await service.store.update((state) => {
    state.courses.push(
      { id: 'course-thermo', name: 'Thermodynamics', active: true },
      { id: 'course-db', name: 'Database Systems', active: true },
      { id: 'course-sample', name: 'Sample Course', active: true, sample: true },
    );
    state.sources.push(
      {
        id: 'thermo-p3',
        title: '热力学讲义.pdf · p. 3',
        courses: ['Thermodynamics'],
        text: pageText,
        document: { materialId: 'doc-thermo', page: 3, totalPages: 10, format: 'pdf', filename: '热力学讲义.pdf' },
      },
      {
        id: 'archived-src',
        title: '旧版讲义',
        courses: ['Thermodynamics'],
        archived: true,
        text: '这份已归档资料也提到了熵与锁，但不应出现在默认搜索中。',
      },
      {
        id: 'sample-src',
        title: '示例资料',
        courses: ['Sample Course'],
        sample: true,
        text: '这份示例资料提到了熵与锁，默认不混入学习者结果。',
      },
    );
    state.decks.push(
      {
        id: 'deck-thermo',
        title: '热力学核心题组',
        course: 'Thermodynamics',
        cards: [
          {
            id: 'card-entropy',
            kind: 'quiz',
            topic: '热力学第二定律',
            prompt: '在绝热自由膨胀过程中，理想气体的哪个状态函数必定增加？',
            options: ['内能 U', '焓 H', '熵 S', '温度 T'],
            answer: '熵 S',
            explanation: '绝热自由膨胀不可逆，孤立系统熵增加，而理想气体内能与温度不变。',
          },
          {
            id: 'card-suspended',
            kind: 'flashcard',
            suspended: true,
            topic: '暂停题',
            prompt: '暂停的熵题',
            answer: '不应命中',
          },
        ],
      },
      {
        id: 'deck-db',
        title: '并发控制题组',
        course: 'Database Systems',
        cards: [
          {
            id: 'card-lock',
            kind: 'flashcard',
            topic: '两阶段封锁',
            prompt: '为什么严格两阶段锁（Strict 2PL）能避免级联回滚？',
            answer: '事务持有的排他锁直到事务提交或中止后才释放。',
          },
        ],
      },
      {
        id: 'deck-archived',
        title: '已归档题组',
        course: 'Thermodynamics',
        archived: true,
        cards: [{ id: 'card-arch', kind: 'flashcard', topic: '熵', prompt: '归档的熵题', answer: '不应出现' }],
      },
      {
        id: 'deck-sample',
        title: '示例题组',
        course: 'Sample Course',
        sample: true,
        cards: [{ id: 'card-samp', kind: 'flashcard', topic: '熵', prompt: '示例熵题', answer: '默认排除' }],
      },
    );
    state.notes.push(
      {
        id: 'note-thermo',
        title: '统计物理复习札记',
        cards: [{ deckId: 'deck-thermo', cardId: 'card-entropy' }],
        markdown: '# 统计物理复习札记\n\n微观态数目越多，系统的**熵**越大；而在数据库笔记中我们记录了行级锁与意向锁。',
        status: 'draft',
        revision: 1,
      },
      {
        id: 'note-archived',
        title: '已归档笔记',
        archived: true,
        cards: [],
        markdown: '归档的熵与锁笔记',
        status: 'draft',
      },
      {
        id: 'note-sample',
        title: '示例笔记',
        sample: true,
        cards: [{ deckId: 'deck-sample', cardId: 'card-samp' }],
        markdown: '示例中的熵笔记',
        status: 'draft',
      },
    );
  });

  // 1) Short/empty queries never throw length errors
  for (const shortQuery of ['', '   ', 'a', '7']) {
    const empty = await service.call('search.content', { query: shortQuery });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.results, []);
  }

  // 2) Single-Han query `'熵'` hits all 4 content domains!
  const entropyRes = await service.call('search.content', { query: '熵' });
  assert.deepEqual(entropyRes.terms, ['熵']);
  assert.ok(entropyRes.total >= 4, `expected >= 4 hits across 4 domains, got ${entropyRes.total}`);

  const srcHit = entropyRes.groups.sources.find((h) => h.sourceId === 'thermo-p3');
  assert.ok(srcHit, 'found material page hit');
  assert.equal(srcHit.kind, 'source');
  assert.equal(srcHit.page, 3);
  assert.equal(srcHit.course, 'Thermodynamics');
  assert.ok(srcHit.documentKey.includes('doc-thermo'), srcHit.documentKey);
  assert.equal(pageText.indexOf('熵'), srcHit.matchOffset, 'matchOffset points to exact character in source text');
  assert.ok(srcHit.snippet.includes('熵'));

  const cardHit = entropyRes.groups.cards.find((h) => h.cardId === 'card-entropy');
  assert.ok(cardHit, 'found question bank hit via answer/options/explanation');
  assert.equal(cardHit.deckId, 'deck-thermo');
  assert.equal(cardHit.deckTitle, '热力学核心题组');
  assert.equal(cardHit.course, 'Thermodynamics');
  assert.equal(cardHit.topic, '热力学第二定律');
  assert.ok(cardHit.snippet.includes('熵'));

  const noteHit = entropyRes.groups.notes.find((h) => h.noteId === 'note-thermo');
  assert.ok(noteHit, 'found note markdown body hit');
  assert.equal(noteHit.course, 'Thermodynamics');
  assert.ok(noteHit.snippet.includes('熵'));
  assert.doesNotMatch(noteHit.snippet, /\*\*/, 'markdown stripped in note snippet');

  const bookHit = entropyRes.groups.books.find((h) => h.chapterId === 'ch2-entropy');
  assert.ok(bookHit, 'found disk course-books/ chapter hit');
  assert.equal(bookHit.course, 'Thermodynamics');
  assert.equal(bookHit.chapterTitle, '第二章 熵与统计解释');
  assert.equal(bookHit.paragraphIndex, 1, '0: intro paragraph, 1: Boltzmann entropy paragraph');
  assert.ok(bookHit.snippet.includes('玻尔兹曼公式'), 'snippet comes from the matching body paragraph rather than repeating the chapter heading');

  // Excluded archived and sample items by default
  const allIds = JSON.stringify(entropyRes.results);
  for (const excluded of ['archived-src', 'sample-src', 'card-suspended', 'card-arch', 'card-samp', 'note-archived', 'note-sample']) {
    assert.equal(allIds.includes(excluded), false, `${excluded} is excluded from active content search`);
  }

  // 3) Single-Han query `'锁'` hits database card, source, note, and book!
  const lockRes = await service.call('search.content', { query: '锁' });
  assert.deepEqual(lockRes.terms, ['锁']);
  assert.ok(lockRes.groups.cards.some((h) => h.cardId === 'card-lock'));
  assert.ok(lockRes.groups.sources.some((h) => h.sourceId === 'thermo-p3'));
  assert.ok(lockRes.groups.notes.some((h) => h.noteId === 'note-thermo'));
  assert.ok(lockRes.groups.books.some((h) => h.chapterId === 'ch2-entropy' && h.paragraphIndex === 2));

  // 4) StudyHub built-in review book (`seedBookFixture` in `ArchSS`) is also searched cleanly!
  const archBookRes = await service.call('search.content', { query: '这段在讲什么', course: BOOK_COURSE });
  assert.ok(archBookRes.groups.books.length > 0, 'searches StudyHub review book points in BOOK_COURSE');
  assert.equal(archBookRes.groups.books[0].course, BOOK_COURSE);

  // 5) Course filter scopes results, and explicitly scoping into Sample Course allows its items
  const dbOnly = await service.call('search.content', { query: '锁', course: 'Database Systems' });
  assert.ok(dbOnly.results.every((h) => h.course === 'Database Systems'));
  assert.equal(dbOnly.groups.cards[0]?.cardId, 'card-lock');

  const sampleScoped = await service.call('search.content', { query: '熵', course: 'Sample Course' });
  assert.ok(sampleScoped.groups.sources.some((h) => h.sourceId === 'sample-src'), 'explicitly scoping to sample course matches sample items');
});

test('ranking orders exact phrase > title/topic match > body match', async () => {
  const state = {
    courses: [{ name: 'OS', active: true }],
    sources: [
      { id: 'body-split', title: 'General Notes', courses: ['OS'], text: 'First we discuss 死锁, and much later we discuss 检测 algorithms in detail.' },
      { id: 'body-phrase', title: 'Chapter Summary', courses: ['OS'], text: 'This section explains 死锁 检测 with wait-for graphs.' },
      { id: 'title-match', title: '死锁 检测', courses: ['OS'], text: 'Overview of operating system resource allocation.' },
    ],
    decks: [],
    notes: [],
  };
  const res = await searchLibraryContent(state, { query: '死锁 检测' });
  assert.deepEqual(
    res.results.map((r) => r.sourceId),
    ['title-match', 'body-phrase', 'body-split'],
    'exact title phrase > exact body phrase > split body terms',
  );
});

test('FinderSheet renders 全文内容 (Content matches) with zero Han in English UI, and content-hits routes all 4 jump targets', async () => {
  assert.equal(uiMod.shouldSearchContent(''), false);
  assert.equal(uiMod.shouldSearchContent('a'), false);
  assert.equal(uiMod.shouldSearchContent('熵'), true);
  assert.equal(uiMod.shouldSearchContent('锁'), true);
  assert.equal(uiMod.shouldSearchContent('os'), true);

  const sampleHits = [
    { kind: 'source', sourceId: 's1', documentKey: 'source:s1', title: 'Thermodynamics Notes', course: 'Physics', page: 4, snippet: 'Boltzmann entropy formula S = k ln W', matchOffset: 42, quote: 'Boltzmann entropy formula S = k ln W' },
    { kind: 'card', deckId: 'd1', deckTitle: 'Thermo Deck', cardId: 'c1', course: 'Physics', topic: 'Second Law', prompt: 'What happens to entropy in an isolated system?', snippet: 'Entropy never decreases in an isolated system.' },
    { kind: 'note', noteId: 'n1', title: 'Lecture 4 Summary', course: 'Physics', snippet: 'Reversible heat engines conserve total entropy.' },
    { kind: 'book', course: 'Physics', chapterId: 'p2', chapterTitle: 'Statistical Mechanics', paragraphIndex: 1, snippet: 'Microstates determine macroscopic entropy.' },
  ];

  // Chinese UI check
  uiMod.setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(React.createElement(uiMod.FinderSheet, {
    data: { features: { examBlueprint: true } },
    initialQuery: 'entropy',
    initialContentHits: sampleHits,
    onGo: noop,
    onClose: noop,
    onTour: noop,
  }));
  assert.match(zhHtml, /class="finder-content"/);
  assert.match(zhHtml, /全文内容/);
  assert.match(zhHtml, /<mark class="finder-hit-mark">entropy<\/mark>/i);
  assert.match(zhHtml, /第 4 页/);

  // 1-char Latin query hides 全文内容 even if stale hits existed
  const shortHtml = renderToStaticMarkup(React.createElement(uiMod.FinderSheet, {
    data: { features: { examBlueprint: true } },
    initialQuery: 'e',
    initialContentHits: sampleHits,
    onGo: noop,
    onClose: noop,
    onTour: noop,
  }));
  assert.doesNotMatch(shortHtml, /class="finder-content"/);

  // English UI zero-Han check across all 4 content domains!
  uiMod.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(uiMod.FinderSheet, {
      data: { features: { examBlueprint: true } },
      initialQuery: 'entropy',
      initialContentHits: sampleHits,
      onGo: noop,
      onClose: noop,
      onTour: noop,
    }));
    assert.match(enHtml, /Content matches/);
    assert.match(enHtml, /Page 4/);
    assert.match(enHtml, /Review book/);
    assert.doesNotMatch(stripHtml(enHtml), HAN, 'English FinderSheet with all 4 content hit types has zero Chinese characters');
  } finally {
    uiMod.setUiLanguage('zh');
  }

  // Verify target mapping and useFinder jump dispatch for all 4 domains
  const entries = uiMod.toFinderContentEntries(sampleHits);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0].target, { kind: 'source', id: 's1', matchOffset: 42, quote: 'Boltzmann entropy formula S = k ln W' });
  assert.deepEqual(entries[1].target, { kind: 'card', deckId: 'd1', cardId: 'c1' });
  assert.deepEqual(entries[2].target, { kind: 'note', id: 'n1' });
  assert.deepEqual(entries[3].target, { kind: 'book', course: 'Physics', chapterId: 'p2' });

  const openedTargets = [];
  const sourceOffsets = [];
  const navigatedPages = [];
  const switchedCourses = [];
  let finderApi = null;
  function Harness() {
    finderApi = uiMod.useFinder({
      nav: { page: 'library', navigate: (page, opts) => navigatedPages.push([page, opts]) },
      settingsEntry: { openSettings: noop },
      core: {
        notify: noop,
        refs: { dataRef: { current: { root: '/lib-finder', focus: { course: 'OS' } } } },
        act: async (action, payload) => { switchedCourses.push([action, payload]); return true; },
      },
      tour: { tourStep: null, startTour: noop },
      rootRef: { current: null },
      learn: {
        openLearningTarget: async (target) => { openedTargets.push(target); },
        openSourceAt: (id, offset) => { sourceOffsets.push([id, offset]); },
      },
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  for (const entry of entries) await finderApi.go(entry);

  assert.deepEqual(openedTargets, [
    { kind: 'source', id: 's1', quote: 'Boltzmann entropy formula S = k ln W' },
    { kind: 'card', deckId: 'd1', cardId: 'c1' },
    { kind: 'note', id: 'n1' },
  ]);
  assert.deepEqual(switchedCourses, [['focus.set', { course: 'Physics' }]]);
  assert.equal(navigatedPages[0]?.[0], 'book');
  assert.equal(uiMod.keptBook('/lib-finder', 'Physics')?.target, 'p2');

  // Source hit without quote falls back to openSourceAt(sourceId, matchOffset)
  const offsetOnlyEntry = uiMod.toFinderContentEntries([
    { kind: 'source', sourceId: 's2', documentKey: 'source:s2', title: 'Doc 2', course: 'OS', page: 1, snippet: 'snippet', matchOffset: 128 },
  ])[0];
  await finderApi.go(offsetOnlyEntry);
  assert.deepEqual(sourceOffsets, [['s2', 128]]);
});
