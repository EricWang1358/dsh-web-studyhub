import test from 'node:test';
import assert from 'node:assert/strict';
import { courseNamedBy, coursesForFile } from '../ui/import-course.js';

/* Which course a new material goes under: the learner's choice (or the current course) first; a file name fills a blank course only when it names
   exactly one course, as a whole word. A guess that could be wrong is not made. */

const courses = [{ name: 'CS2105', aliases: ['Networks'] }, { name: 'CS1101', aliases: [] }, { name: '操作系统', aliases: [] }, { name: '数据结构' }, { name: '数据结构与算法' }, { name: 'OS' }];

test('a file name that holds one course name as a whole word names that course', () => {
  assert.equal(courseNamedBy('CS2105 week 3.pdf', courses)?.course, 'CS2105');
  assert.equal(courseNamedBy('cs2105_lecture-04.PDF', courses)?.course, 'CS2105');
  assert.equal(courseNamedBy('D:\\Downloads\\CS1101 slides.pptx', courses)?.course, 'CS1101');
  assert.equal(courseNamedBy('操作系统 第三章.pdf', courses)?.course, '操作系统');
  assert.equal(courseNamedBy('操作系统第三章.pdf', courses)?.course, '操作系统', 'Chinese has no spaces between words');
});

test('an alias counts, and the match says which word it was', () => {
  const found = courseNamedBy('Networks - transport layer.pdf', courses);
  assert.equal(found?.course, 'CS2105');
  assert.equal(found?.term, 'Networks');
});

test('two courses in one name is no guess at all', () => {
  assert.equal(courseNamedBy('CS2105 and CS1101 notes.pdf', courses), null);
  assert.equal(courseNamedBy('数据结构与算法 笔记.pdf', courses), null, '数据结构 is inside 数据结构与算法: both fit');
});

test('a name that is only part of a word, or too short to tell apart, is not a match', () => {
  assert.equal(courseNamedBy('Costs of living.pdf', courses), null, 'OS inside Costs');
  assert.equal(courseNamedBy('OS lecture.pdf', courses), null, 'two letters match too many names');
  assert.equal(courseNamedBy('CS21050 draft.pdf', courses), null, 'CS2105 inside another number');
  assert.equal(courseNamedBy('', courses), null);
  assert.equal(courseNamedBy('notes.pdf', []), null);
  assert.equal(courseNamedBy('CS2105.pdf', ['', null, { name: '' }]), null, 'empty names are skipped');
});

test('coursesForFile: the field wins, a blank field may be filled by the name, else nothing', () => {
  assert.deepEqual(coursesForFile({ name: 'CS2105 week 3.pdf' }, { chosen: ['CS1101'], known: courses }), { courses: ['CS1101'], how: 'chosen' });
  assert.deepEqual(coursesForFile({ name: 'CS2105 week 3.pdf' }, { chosen: [], known: courses }), { courses: ['CS2105'], how: 'file-name', term: 'CS2105' });
  assert.deepEqual(coursesForFile({ name: 'lecture.pdf' }, { chosen: [], known: courses }), { courses: [], how: 'none' });
  assert.deepEqual(coursesForFile({ name: 'CS2105 and CS1101.pdf' }, { known: courses }), { courses: [], how: 'none' });
});
