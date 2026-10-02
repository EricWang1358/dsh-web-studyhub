import test from 'node:test';
import assert from 'node:assert/strict';
import { courseSegments, courseWithin, courseScope, courseParent, courseTree, courseRelative } from '../lib/course-tree.js';

/* Courses may contain courses (owner request): the hierarchy lives in the name, a path of segments
   separated by " / ". A slash without spaces separates only when what comes before it is a known course. */
const P = 'Cloud Native Solution Design';
const C07 = `${P} / 07 微服务设计：边界、通信、发现与兼容演进`;
const C05 = `${P} / 05 Kubernetes：对象、运行机制与故障诊断`;
const C01 = `${P}/01 云计算概览与参考架构`;
const OWNER = [P, C07, C05, C01, `${P} / 10 Serverless`, `${P} / 08 Serverless与生成式AI：计算、模型与应用集成`];

test('a name is a path: spaced slashes always separate, whitespace is normalised', () => {
  assert.deepEqual(courseSegments(C07), [P, '07 微服务设计：边界、通信、发现与兼容演进']);
  assert.deepEqual(courseSegments('  Cloud   Native  /  01  x '), ['Cloud Native', '01 x']);
  assert.deepEqual(courseSegments('A / B / C'), ['A', 'B', 'C']);
  assert.deepEqual(courseSegments('操作系统'), ['操作系统']);
  assert.deepEqual(courseSegments(''), []);
});

test('a slash without spaces separates only after an existing course name', () => {
  assert.deepEqual(courseSegments(C01), [C01], 'unknown prefix: part of the name');
  assert.deepEqual(courseSegments(C01, OWNER), [P, '01 云计算概览与参考架构']);
  assert.deepEqual(courseSegments('TCP/IP', ['TCP/IP', 'Networks']), ['TCP/IP']);
  assert.deepEqual(courseSegments('I/O', ['I/O', 'OS']), ['I/O']);
  assert.deepEqual(courseSegments('Networks/IP', ['Networks']), ['Networks', 'IP']);
  assert.deepEqual(courseSegments('Networks/IP/v6', ['Networks', 'Networks/IP']), ['Networks', 'IP', 'v6']);
  assert.deepEqual(courseSegments('Networks/IP/v6', ['Networks']), ['Networks', 'IP/v6']);
});

test('containment is on segment boundaries', () => {
  assert.equal(courseWithin(P, P, OWNER), true);
  assert.equal(courseWithin(P, C07, OWNER), true);
  assert.equal(courseWithin(P, C01, OWNER), true, 'the no-space chapter belongs to its parent');
  assert.equal(courseWithin(C07, P, OWNER), false, 'a chapter does not contain its parent');
  assert.equal(courseWithin(C07, C05, OWNER), false, 'siblings are separate');
  assert.equal(courseWithin(C07, C07, OWNER), true);
  assert.equal(courseWithin('Cloud', `${P} / 01 x`, [...OWNER, 'Cloud']), false, 'Cloud is not Cloud Native');
  assert.equal(courseWithin('Cloud', 'Cloud / A', ['Cloud']), true);
  assert.equal(courseWithin('Cloud / A', 'Cloud / A / deep', []), true, 'descendants of descendants');
  assert.equal(courseWithin('TCP', 'TCP/IP', ['TCP/IP']), false, 'TCP/IP is a name, not a child of TCP');
});

test('the same course in another spelling is the same node; names are compared, never rewritten', () => {
  assert.equal(courseWithin(`${P}/01 云计算概览与参考架构`, `${P} / 01 云计算概览与参考架构`, OWNER), true);
  assert.equal(courseWithin('Cloud  Native', 'Cloud Native / x', []), true);
  assert.equal(courseWithin('Ｃloud', 'Cloud / x', []), true, 'NFKC, as course ids use');
});

test('special scopes keep their meaning: * is everything, empty is uncategorised only', () => {
  for (const course of ['', P, C07]) assert.equal(courseWithin('*', course, OWNER), true);
  assert.equal(courseWithin(undefined, C07, OWNER), true);
  assert.equal(courseWithin(null, C07, OWNER), true);
  assert.equal(courseWithin('', '', OWNER), true);
  assert.equal(courseWithin('', undefined, OWNER), true);
  assert.equal(courseWithin('', P, OWNER), false);
  assert.equal(courseWithin(P, '', OWNER), false, 'a parent scope never matches uncategorised');
  assert.equal(courseWithin(P, undefined, OWNER), false);
});

test('courseScope prepares one matcher for a loop', () => {
  const within = courseScope(P, OWNER);
  assert.deepEqual(OWNER.map(name => within(name)), OWNER.map(() => true));
  assert.equal(within('Other'), false);
  assert.equal(courseScope('*', OWNER).all, true);
  assert.equal(courseScope('', OWNER).uncategorised, true);
});

test('parent of a path', () => {
  assert.equal(courseParent(C07, OWNER), P);
  assert.equal(courseParent(C01, OWNER), P, 'the stored spelling of an existing parent is preferred');
  assert.equal(courseParent(P, OWNER), null);
  assert.equal(courseParent('A / B / C', []), 'A / B', 'an implicit parent is named by its path');
  assert.equal(courseParent('', []), null);
});

test('relative name below a scope (for rows listed under a parent)', () => {
  assert.equal(courseRelative(C05, P, OWNER), '05 Kubernetes：对象、运行机制与故障诊断');
  assert.equal(courseRelative(C01, P, OWNER), '01 云计算概览与参考架构');
  assert.equal(courseRelative(`${P} / A / B`, P, OWNER), 'A / B');
  assert.equal(courseRelative(P, P, OWNER), null, 'the scope itself has no relative name');
  assert.equal(courseRelative('Other / x', P, OWNER), null);
  assert.equal(courseRelative(C05, C07, OWNER), null, 'a sibling is not inside');
  assert.equal(courseRelative(C05, '*', OWNER), null);
  assert.equal(courseRelative(C05, '', OWNER), null);
  assert.equal(courseRelative(C05, undefined, OWNER), null);
});

test('tree: children indented under their parent in natural order, implicit parents included', () => {
  const rows = courseTree([C07, `${P} / 10 Serverless`, C05, C01, `${P} / 08 X`, 'Other', 'Lone / chapter 2', 'Lone / chapter 10'], [P, C01]);
  assert.deepEqual(rows.map(row => [row.depth, row.label, row.implicit]), [
    [0, P, true],
    [1, '01 云计算概览与参考架构', false], [1, '05 Kubernetes：对象、运行机制与故障诊断', false],
    [1, '07 微服务设计：边界、通信、发现与兼容演进', false], [1, '08 X', false], [1, '10 Serverless', false],
    [0, 'Other', false],
    [0, 'Lone', true], [1, 'chapter 2', false], [1, 'chapter 10', false],
  ]);
  const byLabel = new Map(rows.map(row => [row.label, row]));
  assert.equal(byLabel.get(P).name, P, 'an implicit parent is filled with its path');
  assert.equal(byLabel.get('01 云计算概览与参考架构').name, C01, 'a child keeps the exact stored name');
  assert.equal(byLabel.get('chapter 2').name, 'Lone / chapter 2');
  assert.equal(byLabel.get('chapter 2').parent, 'Lone');
  assert.equal(byLabel.get(P).childCount, 5);
  assert.equal(byLabel.get('Lone').childCount, 2);
});

test('tree: an explicit parent is one row, top level keeps the given order, no empty names', () => {
  const rows = courseTree(['Zeta', `${P} / b`, P, 'Alpha', '', '*', `${P} / a`]);
  assert.deepEqual(rows.map(row => [row.depth, row.label, row.implicit]),
    [[0, 'Zeta', false], [0, P, false], [1, 'a', false], [1, 'b', false], [0, 'Alpha', false]]);
});

test('tree: a name that merely contains a slash stays a root', () => {
  const rows = courseTree(['TCP/IP', 'Networks']);
  assert.deepEqual(rows.map(row => [row.depth, row.label]), [[0, 'TCP/IP'], [0, 'Networks']]);
});

test('tree: two spellings of one path are one row that keeps both names', () => {
  const rows = courseTree([`${P} / 01 x`, `${P}/01 x`], [P]);
  const child = rows.find(row => row.depth === 1);
  assert.equal(rows.filter(row => row.depth === 1).length, 1);
  assert.deepEqual(child.names, [`${P} / 01 x`, `${P}/01 x`]);
});

test('a parent that only exists implicitly is known too, so a no-space chapter still joins it', () => {
  assert.deepEqual(courseSegments(C01, [C07, C05]), [P, '01 云计算概览与参考架构']);
  assert.equal(courseWithin(P, C01, [C07]), true);
  const rows = courseTree([C07, C01]);
  assert.deepEqual(rows.map(row => [row.depth, row.implicit]), [[0, true], [1, false], [1, false]]);
  assert.equal(courseSegments('Networks/IP', ['Networks / Layer 3']).length, 2);
  assert.equal(courseSegments('TCP/IP', ['Networks / Layer 3']).length, 1);
});
