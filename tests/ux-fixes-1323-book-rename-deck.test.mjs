import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import {
  COURSE_BOOK_DOC_PROVENANCE,
  COURSE_INVENTORY_PROVENANCE,
  COURSE_NOTES_PROVENANCE,
  COURSE_OUTLINE_PROVENANCE,
} from '../lib/exam-point-list.js';
import { bookLinks } from '../lib/course-book-links.js';
import { courseNotesOf } from '../lib/course-book-view.js';
import { renameCourse, setCourseActive } from '../lib/courses.js';
import { focusView } from '../lib/focus.js';

function seedBookSources(course, prefix) {
  return [
    {
      id: `${prefix}-outline`,
      title: `总纲 · ${course}`,
      text: 'outline',
      courses: [course],
      provenance: COURSE_OUTLINE_PROVENANCE,
      courseOutline: { version: 1, course, nodes: [{ id: 'n1', title: '核心概念', leaf: true, anchors: [] }] },
    },
    {
      id: `${prefix}-notes`,
      title: `讲解 · ${course}`,
      text: 'notes',
      courses: [course],
      provenance: COURSE_NOTES_PROVENANCE,
      courseNotes: { version: 1, course, language: 'zh', leaves: [{ id: 'n1', body: { explain: 'AI 讲解正文', cites: [] } }] },
    },
    {
      id: `${prefix}-inv`,
      title: `清点 · ${course}`,
      text: 'inventory',
      courses: [course],
      provenance: COURSE_INVENTORY_PROVENANCE,
      courseInventory: { version: 1, course, items: [] },
    },
    {
      id: `${prefix}-doc`,
      title: `复习全书 · ${course}`,
      text: 'book notice',
      courses: [course],
      provenance: COURSE_BOOK_DOC_PROVENANCE,
      bookDoc: {
        version: 1,
        course,
        language: 'zh',
        outlineId: `${prefix}-outline`,
        revision: 3,
        nextId: 2,
        manifest: { nodes: [{ id: 'n1', hid: 'h1', title: '核心概念', leaf: true }] },
        files: {
          'n1.gen.md': { text: `AI 讲解[^1]\n\n[^1]: ${prefix} 出处`, version: 2, forked: prefix === 'src' },
          'n1.mine.md': { text: `${prefix} 的手写笔记[^1]\n\n[^1]: 手写脚注`, version: 2 },
          'n1.qa.md': { text: `${prefix} 的收藏问答`, version: 1 },
          'unplaced.md': { text: '', version: 1 },
        },
      },
    },
  ];
}

test('#1323-4: course rename & merge preserve all 4 复习全书 layers, park merged learner text, and migrate examCoach & studySessions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'study-1323-4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir);
  t.after(() => service.dispose());

  await service.store.update((s) => {
    s.courses = [
      { id: 'c-os', name: 'OS', aliases: [], guidanceSourceIds: [], focusTopics: [] },
      { id: 'c-sys', name: '系统基础', aliases: [], guidanceSourceIds: [], focusTopics: [] },
    ];
    s.sources.push(...seedBookSources('OS', 'src'), ...seedBookSources('系统基础', 'dst'));
    s.learner = { ...(s.learner || {}), examCoach: { OS: { course: 'OS', readiness: 70 } } };
    s.studySessions = [{ id: 'ss-1', courseId: 'OS', status: 'active', scope: [] }];
  });

  // 1) Rename OS -> 操作系统 via service (verifies domain-contracts write permissions for learner & studySessions too!)
  await service.call('course.rename', { id: 'c-os', name: '操作系统' });
  const afterRename = await service.store.read();
  assert.equal(afterRename.sources.find((s) => s.id === 'src-outline').courseOutline.course, '操作系统');
  assert.equal(afterRename.sources.find((s) => s.id === 'src-notes').courseNotes.course, '操作系统');
  assert.equal(afterRename.sources.find((s) => s.id === 'src-inv').courseInventory.course, '操作系统');
  const bookDoc = afterRename.sources.find((s) => s.id === 'src-doc');
  assert.equal(bookDoc.bookDoc.course, '操作系统');
  assert.equal(bookDoc.id, 'src-doc', 'bookDoc keeps its original id');
  assert.equal(afterRename.learner.examCoach['操作系统']?.course, '操作系统');
  assert.equal(afterRename.learner.examCoach.OS, undefined);
  assert.equal(afterRename.studySessions[0].courseId, '操作系统');

  // Legacy fallback: courseNotesOf resolves via outline.courses[0] if outline.courseOutline.course is stale
  const staleOutline = {
    id: 'legacy-o',
    courses: ['操作系统'],
    courseOutline: { version: 1, course: '旧名', nodes: [] },
  };
  const foundNotes = courseNotesOf(afterRename, [], staleOutline);
  assert.equal(foundNotes?.record.id, 'src-notes', 'legacy fallback rescues renamed notes via outline.courses[0]');

  // 2) Merge 操作系统 into 系统基础 when BOTH have books: primary kept, source parked into unplaced.md & archived
  await service.call('course.merge', { into: 'c-sys', from: ['c-os'] });
  const afterMerge = await service.store.read();
  const primaryDoc = afterMerge.sources.find((s) => s.id === 'dst-doc');
  const archivedSrcDoc = afterMerge.sources.find((s) => s.id === 'src-doc');
  assert.equal(archivedSrcDoc.archived, true, 'source bookDoc is archived after merge');
  assert.equal(afterMerge.sources.find((s) => s.id === 'src-outline').archived, true);
  assert.equal(afterMerge.sources.find((s) => s.id === 'src-notes').archived, true);
  assert.equal(primaryDoc.archived, undefined);
  assert.match(primaryDoc.bookDoc.files['unplaced.md'].text, /src 的手写笔记/, 'source learner notes parked in primary 未归位');
  assert.match(primaryDoc.bookDoc.files['unplaced.md'].text, /src 的收藏问答/, 'source Q&A parked in primary 未归位');
  assert.match(primaryDoc.bookDoc.files['unplaced.md'].text, /\[\^1-m\d+\]/, 'parked footnotes relabeled to avoid collision');
  assert.equal(afterMerge.studySessions[0].courseId, '系统基础');
});

test('#1323-8: parent course rename cascades to all descendants (including multi-level & no-space) without zombie parent or alias hijacking', () => {
  const state = {
    courses: [
      { id: 'c-os', name: 'OS', aliases: [], guidanceSourceIds: [], focusTopics: [] },
      { id: 'c-proc', name: 'OS / 进程', aliases: [], guidanceSourceIds: [], focusTopics: [] },
      { id: 'c-page', name: 'OS / 内存 / 分页', aliases: [], guidanceSourceIds: [], focusTopics: [] },
      { id: 'c-nospace', name: 'OS/01 概述', aliases: [], guidanceSourceIds: [], focusTopics: [] },
    ],
    decks: [
      { id: 'd1', title: '进程题组', course: 'OS / 进程', cards: [{ id: 'q1', prompt: 'Q?' }] },
      { id: 'd2', title: '分页题组', course: 'OS / 内存 / 分页', cards: [{ id: 'q2', prompt: 'Q?' }] },
      { id: 'd3', title: '概述题组', course: 'OS/01 概述', cards: [{ id: 'q3', prompt: 'Q?' }] },
    ],
    drafts: [],
    sources: [],
    runs: [],
    attempts: [],
    focus: { course: 'OS / 进程' },
  };

  // Refuses renaming into own descendant
  assert.throws(() => renameCourse(state, { id: 'c-os', name: 'OS / 进程 / 子项' }), /不能把父课程改名为它自己的子课程/);

  // Atomic cascade rename of parent + all 3 descendants
  const res = renameCourse(state, { id: 'c-os', name: '操作系统' });
  assert.equal(res.course.name, '操作系统');
  assert.equal(res.subCourses.length, 3);
  assert.equal(state.courses.find((c) => c.id === 'c-proc').name, '操作系统 / 进程');
  assert.equal(state.courses.find((c) => c.id === 'c-page').name, '操作系统 / 内存 / 分页');
  assert.equal(state.courses.find((c) => c.id === 'c-nospace').name, '操作系统 / 01 概述');
  assert.equal(state.decks.find((d) => d.id === 'd1').course, '操作系统 / 进程');
  assert.equal(state.decks.find((d) => d.id === 'd3').course, '操作系统 / 01 概述');
  assert.equal(state.focus.course, '操作系统 / 进程');

  // No zombie "OS" parent in focusView
  const fv = focusView(state);
  assert.equal(fv.courses.find((c) => c.name === 'OS'), undefined, 'no zombie old parent course remains');

  // Defense-in-depth: even if an implicit parent exists matching an old alias, focusView sets id: null and setCourseActive never hijacks the renamed course
  state.decks.push({ id: 'd-stray', title: 'Stray', course: 'OS / 遗留章节', cards: [{ id: 'q4', prompt: 'Q?' }] });
  const fvWithImplicit = focusView(state);
  const implicitRow = fvWithImplicit.courses.find((c) => c.name === 'OS');
  assert.equal(implicitRow?.implicit, true);
  assert.equal(implicitRow?.id, null, 'implicit parent must NEVER steal renamed course ID via alias');

  setCourseActive(state, { name: 'OS', active: false });
  assert.notEqual(state.courses.find((c) => c.id === 'c-os').active, false, 'parking implicit old parent must NEVER deactivate renamed course 操作系统');
});

test('#1323-9: deck.merge and deck.split relocate 复习全书 card links, oralRuns, and studySessions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'study-1323-9-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir);
  t.after(() => service.dispose());

  await service.store.update((s) => {
    s.courses = [{ id: 'c-net', name: '计网', aliases: [], guidanceSourceIds: [], focusTopics: [] }];
    s.decks = [
      {
        id: 'd-from',
        title: 'TCP 题组',
        course: '计网',
        cards: [
          { id: 'c1', kind: 'quiz', topic: '拥塞控制', prompt: '慢启动？', answer: '指数增长' },
          { id: 'c2', kind: 'quiz', topic: '流量控制', prompt: '滑动窗口？', answer: '接收窗口通告' },
        ],
      },
      {
        id: 'd-target',
        title: '网络层合集',
        course: '计网',
        cards: [{ id: 'c3', kind: 'quiz', topic: 'IP', prompt: 'CIDR？', answer: '无类域间路由' }],
      },
    ];
    s.sources = [{
      id: 'book-net',
      title: '复习全书 · 计网',
      text: 'book',
      courses: ['计网'],
      provenance: COURSE_BOOK_DOC_PROVENANCE,
      bookDoc: {
        version: 1,
        course: '计网',
        language: 'zh',
        revision: 1,
        manifest: { nodes: [] },
        files: {
          'n1.qa.md': {
            text: `- [练习：慢启动](${bookLinks.card('d-from', 'c1')})\n- [练习：滑动窗口](${bookLinks.card('d-from', 'c2')})`,
            version: 1,
            suggestions: [{ id: 's1', text: `[建议](${bookLinks.card('d-from', 'c1')})` }],
          },
        },
      },
    }];
    s.oralRuns = [{
      id: 'oral-1',
      deckId: 'd-from',
      scope: [{ deckId: 'd-from', cardId: 'c1' }],
      entries: [{ deckId: 'd-from', card: { id: 'c1', prompt: '慢启动？' } }],
    }];
    s.studySessions = [{
      id: 'gs-1',
      courseId: '计网',
      status: 'active',
      version: 1,
      scope: [{ kind: 'deck', id: 'd-from' }, { kind: 'card', deckId: 'd-from', cardId: 'c1' }],
      focus: { kind: 'card', deckId: 'd-from', cardId: 'c1' },
    }];
  });

  // 1) deck.split: move topic 拥塞控制 (c1) into new deck; c2 stays in d-from
  const splitRes = await service.call('deck.split', { id: 'd-from', title: '拥塞专题', topics: ['拥塞控制'] });
  const splitDeckId = splitRes.targetId;
  const afterSplit = await service.store.read();
  const bookAfterSplit = afterSplit.sources.find((s) => s.id === 'book-net');
  assert.match(bookAfterSplit.bookDoc.files['n1.qa.md'].text, new RegExp(bookLinks.card(splitDeckId, 'c1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(bookAfterSplit.bookDoc.files['n1.qa.md'].text, new RegExp(bookLinks.card('d-from', 'c2').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(bookAfterSplit.bookDoc.files['n1.qa.md'].suggestions[0].text, new RegExp(bookLinks.card(splitDeckId, 'c1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(bookAfterSplit.bookDoc.files['n1.qa.md'].version, 2);
  assert.equal(bookAfterSplit.bookDoc.revision, 2);
  assert.equal(afterSplit.oralRuns[0].entries[0].deckId, splitDeckId, 'oralRuns entry relocated on split');
  assert.ok(afterSplit.studySessions[0].scope.some((item) => item.kind === 'deck' && item.id === splitDeckId), 'studySession scope appends split deck');
  assert.ok(afterSplit.studySessions[0].scope.some((item) => item.kind === 'deck' && item.id === 'd-from'), 'studySession scope keeps remaining source deck');
  assert.equal(afterSplit.studySessions[0].focus.deckId, splitDeckId, 'studySession focus relocated to split deck');

  // 2) deck.merge: merge splitDeckId into d-target
  await service.call('deck.merge', { sourceIds: [splitDeckId], targetId: 'd-target' });
  const afterMerge = await service.store.read();
  const bookAfterMerge = afterMerge.sources.find((s) => s.id === 'book-net');
  assert.match(bookAfterMerge.bookDoc.files['n1.qa.md'].text, new RegExp(bookLinks.card('d-target', 'c1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(afterMerge.oralRuns[0].entries[0].deckId, 'd-target', 'oralRuns entry relocated on merge');
  assert.equal(afterMerge.studySessions[0].focus.deckId, 'd-target', 'studySession focus relocated on merge');
  assert.ok(afterMerge.studySessions[0].scope.some((item) => item.kind === 'deck' && item.id === 'd-target'));
  assert.ok(!afterMerge.studySessions[0].scope.some((item) => item.kind === 'deck' && item.id === splitDeckId));
});
