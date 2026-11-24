import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { buildVoicePack } from '../lib/contexts/study/voice-handoff.js';
import { courseList, courseProfile, courseView, mergeCourses, saveCourse } from '../lib/courses.js';
import { courseActivity, focusView } from '../lib/focus.js';
import { libraryCourses } from '../lib/source-courses.js';

test('#1323-3: voice pack exports real course name, inherited exam date & parent/child focus topics across single-deck, multi-deck, and hierarchy scopes', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const state = {
    courses: [
      { id: 'c-os', name: '操作系统', exam: { date: '2026-12-15', format: 'closed-book' }, focusTopics: ['死锁', '调度'] },
      { id: 'c-os-mem', name: '操作系统 / 内存管理', focusTopics: ['分页', '缺页中断'] },
      { id: 'c-os-io', name: '操作系统 / 文件系统', focusTopics: ['inode'] },
    ],
    decks: [
      {
        id: 'd-mem-1',
        title: '第 4 章分页专项题组',
        course: '操作系统 / 内存管理',
        cards: [{ id: 'cm1', kind: 'quiz', topic: '分页', prompt: '页表的作用？', answer: '虚拟地址到物理地址映射' }],
      },
      {
        id: 'd-io-1',
        title: '第 6 章文件系统题组',
        course: '操作系统 / 文件系统',
        cards: [{ id: 'ci1', kind: 'quiz', topic: 'inode', prompt: 'inode 存什么？', answer: '元数据与块指针' }],
      },
      {
        id: 'd-sample',
        title: '示例题组',
        course: '示例课程',
        sample: true,
        cards: [{ id: 'cs1', kind: 'quiz', topic: 'Sample', prompt: 'Sample?' }],
      },
    ],
    sources: [],
    attempts: [],
  };

  // 1) Single-deck export: course must be real course name (NOT deck title), inherits parent exam date + focus topics
  const single = buildVoicePack(state, { deckId: 'd-mem-1' }, now);
  assert.equal(single.course, '操作系统 / 内存管理', 'must use real course name instead of deck title');
  assert.equal(single.progress.exam?.date, '2026-12-15', 'child course inherits parent exam date');
  assert.ok(single.progress.focusTopics.includes('分页'), 'includes own focus topic');
  assert.ok(single.progress.focusTopics.includes('死锁'), 'inherits parent focus topic');
  assert.match(single.markdown, /课程：操作系统 \/ 内存管理/);
  assert.match(single.markdown, /\*\*目标考试日期\*\*：2026-12-15/);

  // 2) Multi-deck export across sibling child courses: resolves longest common parent course, keeps exam date & merged focus topics
  const multi = buildVoicePack(state, { deckIds: ['d-mem-1', 'd-io-1'] }, now);
  assert.equal(multi.course, '操作系统', 'multi-deck across sibling chapters resolves common parent course');
  assert.equal(multi.progress.exam?.date, '2026-12-15');
  assert.ok(multi.progress.focusTopics.includes('分页') && multi.progress.focusTopics.includes('inode') && multi.progress.focusTopics.includes('死锁'));

  // 3) Parent course export includes descendant focus topics
  const byParent = buildVoicePack(state, { course: '操作系统' }, now);
  assert.equal(byParent.course, '操作系统');
  assert.equal(byParent.progress.exam?.date, '2026-12-15');
  assert.ok(byParent.progress.focusTopics.includes('死锁') && byParent.progress.focusTopics.includes('分页') && byParent.progress.focusTopics.includes('inode'));

  // 4) All-library export excludes sample decks when user has real decks
  const allLib = buildVoicePack(state, { course: '*' }, now);
  assert.ok(allLib.cards.every((c) => c.deckId !== 'd-sample'), 'sample deck excluded when user decks exist');
});

test('#1323-6: historical document revisions and archived sources never double source counts or create ghost courses', () => {
  const state = {
    courses: [
      { id: 'c-live', name: '计算机网络' },
      { id: 'c-old', name: '已归档旧课' },
      { id: 'c-ghost', name: '原归属课' },
    ],
    documents: [
      {
        id: 'doc-1',
        currentRevision: 2,
        versions: [
          // v1 was on 原归属课; v2 updated and moved to 计算机网络
          { revision: 1, sourceIds: ['src-v1-p1', 'src-v1-p2'] },
          { revision: 2, sourceIds: ['src-v2-p1', 'src-v2-p2'] },
        ],
      },
    ],
    sources: [
      { id: 'src-v1-p1', title: 'P1 old', text: 'old', courses: ['原归属课'], createdAt: '2026-11-01T00:00:00Z' },
      { id: 'src-v1-p2', title: 'P2 old', text: 'old', courses: ['原归属课'], createdAt: '2026-11-01T00:00:00Z' },
      { id: 'src-v2-p1', title: 'P1 new', text: 'new', courses: ['计算机网络'], createdAt: '2026-11-10T00:00:00Z' },
      { id: 'src-v2-p2', title: 'P2 new', text: 'new', courses: ['计算机网络'], createdAt: '2026-11-10T00:00:00Z' },
      { id: 'src-arch', title: 'Archived', text: 'arch', courses: ['已归档旧课'], archived: true, createdAt: '2026-11-23T00:00:00Z' },
    ],
    decks: [
      { id: 'd-live', title: 'Net', course: '计算机网络', cards: [{ id: 'c1', prompt: 'Q?' }] },
      { id: 'd-arch', title: 'Old', course: '已归档旧课', archived: true, cards: [{ id: 'c2', prompt: 'Q?' }] },
    ],
    drafts: [],
    attempts: [],
  };

  // libraryCourses & focusView omit ghost historical course and fully-archived course
  const listed = libraryCourses(state);
  assert.ok(listed.includes('计算机网络'));
  assert.ok(!listed.includes('已归档旧课'), 'fully-archived course disappears from libraryCourses');
  assert.ok(!listed.includes('原归属课'), 'historical-only ghost course disappears from libraryCourses');

  const focus = focusView(state);
  const netFocus = focus.courses.find((c) => c.name === '计算机网络');
  assert.equal(netFocus?.sourceCount, 2, 'only current revision sources counted (2, not 4)');
  assert.equal(focus.courses.find((c) => c.name === '已归档旧课'), undefined);
  assert.equal(focus.courses.find((c) => c.name === '原归属课'), undefined);

  // courseActivity ignores archived & historical sources
  const activity = courseActivity(state);
  assert.equal(activity.has('已归档旧课'), false);
  assert.equal(activity.has('原归属课'), false);

  // courseList & courseView count only active current-revision sources
  const rows = courseList(state);
  assert.equal(rows.find((r) => r.name === '计算机网络')?.sources, 2);
  assert.equal(rows.find((r) => r.name === '已归档旧课')?.sources, 0);
  assert.equal(rows.find((r) => r.name === '原归属课')?.sources, 0);
});

test('#1323-7: permanent source deletion strips guidanceSourceIds and saveCourse/mergeCourses self-heal pre-existing dangling IDs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'study-1323-7-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir);
  t.after(() => service.dispose());

  // 1) source.remove cleans up guidanceSourceIds on all courses in the same transaction
  await service.call('source.add', { id: 'src-guide', title: 'Exam Syllabus', text: 'Syllabus content', courses: ['编译原理'] });
  const saved = await service.call('course.save', { name: '编译原理', guidanceSourceIds: ['src-guide'], focusTopics: ['词法分析'] });
  assert.deepEqual(saved.guidanceSourceIds, ['src-guide']);

  await service.call('source.archive', { id: 'src-guide', archived: true });
  await service.call('source.remove', { id: 'src-guide', confirm: true });

  const afterRemove = await service.store.read();
  const courseAfter = afterRemove.courses.find((c) => c.name === '编译原理');
  assert.deepEqual(courseAfter.guidanceSourceIds, [], 'source.remove strips deleted source from courses[].guidanceSourceIds');

  // Saving course settings & adding focus topics succeeds with zero deadlock
  const updated = await service.call('course.save', {
    id: courseAfter.id,
    name: '编译原理',
    exam: { format: 'closed-book', date: '2026-12-20' },
    focusTopics: ['词法分析', '语法分析'],
  });
  assert.equal(updated.exam.date, '2026-12-20');

  // 2) Legacy state with a pre-existing dangling guidanceSourceId self-heals on view, profile, save, and merge
  const legacyState = {
    courses: [
      { id: 'c-legacy', name: '旧课', guidanceSourceIds: ['src-deleted', 'src-alive'], focusTopics: ['A'] },
      { id: 'c-target', name: '目标课', guidanceSourceIds: ['src-alive'], focusTopics: ['B'] },
    ],
    sources: [{ id: 'src-alive', title: 'Alive', text: 'ok', courses: ['目标课'] }],
    decks: [],
    drafts: [],
  };

  assert.deepEqual(courseView(legacyState, legacyState.courses[0]).guidanceSourceIds, ['src-alive']);
  assert.deepEqual(courseProfile(legacyState.courses[0], legacyState).guidanceSourceIds, ['src-alive']);

  // Submitting stale client payload containing prior dangling ID self-heals instead of deadlocking
  const healed = saveCourse(legacyState, {
    id: 'c-legacy',
    name: '旧课',
    guidanceSourceIds: ['src-deleted', 'src-alive'],
    focusTopics: ['A', 'C'],
  });
  assert.deepEqual(healed.guidanceSourceIds, ['src-alive']);

  // Submitting a brand-new nonexistent ID is still rejected
  assert.throws(
    () => saveCourse(legacyState, { id: 'c-legacy', name: '旧课', guidanceSourceIds: ['src-brand-new-missing'] }),
    /考官指引里有资料不存在/,
  );

  // Merging a course with a dangling ID into a healthy course strips the dangling ID
  legacyState.courses[0].guidanceSourceIds = ['src-deleted', 'src-alive'];
  const merged = mergeCourses(legacyState, { into: 'c-target', from: ['c-legacy'] });
  assert.deepEqual(merged.course.guidanceSourceIds, ['src-alive']);
});
