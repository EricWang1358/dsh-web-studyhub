/* Courses may contain courses: the pickers show the tree and the UI filters read the whole subtree.
   One component per action: PageScope (scope), CourseField (filing), CourseList (settings) are extended, not duplicated. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as PageScope, decksInCourse, courseMatcher } from './ui/PageScope.jsx';
  export { default as CourseField, pickCourse } from './ui/CourseField.jsx';
  export { CourseList } from './ui/CourseSettings.jsx';
  export { groupCourseNames, splitCourseName } from './ui/course-names.js';
  export { inScope } from './ui/SourcePicker.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { PageScope, decksInCourse, courseMatcher, CourseField, pickCourse, CourseList, groupCourseNames, splitCourseName, inScope, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

const P = 'Cloud Native Solution Design';
const NAMES = {
  c01: `${P}/01 云计算概览与参考架构`, c05: `${P} / 05 Kubernetes：对象、运行机制与故障诊断`, c07: `${P} / 07 微服务设计：边界、通信、发现与兼容演进`,
  c10: `${P} / 10 Serverless`, c08: `${P} / 08 Serverless与生成式AI：计算、模型与应用集成`,
};
let n = 0;
const course = (name, extra = {}) => ({ id: `course-${String(++n).padStart(12, '0')}`, name, aliases: [], guidanceSourceIds: [], focusTopics: [], decks: 1, drafts: 0, sources: 2, ...extra });
const focusCourses = [{ name: 'Databases' }, { name: P }, { name: NAMES.c10 }, { name: NAMES.c05 }, { name: NAMES.c01 }, { name: NAMES.c07 }, { name: NAMES.c08 },
  { name: 'TCP/IP' }, { name: 'Lone / ch 2' }, { name: 'Lone / ch 10' }, { name: 'Lone', implicit: true }];
const userNames = [...Object.values(NAMES), P, 'Lone', 'TCP/IP'].flatMap(name => [name, ...name.split(/\s\/\s|\//)]).filter(Boolean).sort((a, b) => b.length - a.length);
const userData = new RegExp(userNames.map(name => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'g');
const noHan = html => assert.doesNotMatch(html.replace(userData, ''), han);

test('groupCourseNames: any parent with a chapter is a group; implicit parents and depth are supported', () => {
  const alone = groupCourseNames([course('Physics / 01 Mechanics'), course('Chemistry')]);
  assert.deepEqual(alone.map(entry => entry.type), ['group', 'course']);
  assert.equal(alone[0].name, 'Physics');
  assert.equal(alone[0].parent.implicit, true, 'a parent nobody filed under is a synthetic parent');
  assert.deepEqual(alone[0].chapters.map(item => [item.chapter, item.depth]), [['01 Mechanics', 1]]);
  const deep = groupCourseNames([course('A / B / C'), course('A / B / D'), course('A / E'), course('Z')]);
  assert.deepEqual(deep.map(entry => entry.type), ['group', 'course']);
  assert.deepEqual(deep[0].chapters.map(item => [item.chapter, item.depth, item.relative]), [['B', 1, 'B'], ['C', 2, 'B / C'], ['D', 2, 'B / D'], ['E', 1, 'E']]);
  const records = [course(P), course(NAMES.c05), course(NAMES.c01)];
  const [group] = groupCourseNames(records);
  assert.equal(group.parent, records[0], 'an existing parent is passed through untouched');
  assert.deepEqual(group.chapters.map(item => item.course), [records[2], records[1]], 'the no-space chapter joins; natural order');
  assert.equal(groupCourseNames([course('TCP/IP'), course('Databases')]).filter(entry => entry.type === 'group').length, 0);
});

test('splitCourseName follows the shared rule: an unspaced slash needs a known course before it', () => {
  assert.deepEqual(splitCourseName(`${P} / 05 Kubernetes`), { parent: P, chapter: '05 Kubernetes' });
  assert.equal(splitCourseName(NAMES.c01), null, 'unknown prefix: one name');
  assert.deepEqual(splitCourseName(NAMES.c01, [P]), { parent: P, chapter: '01 云计算概览与参考架构' });
  assert.equal(splitCourseName('TCP/IP Basics', ['TCP/IP Basics']), null);
});

test('PageScope shows the tree (a Combobox: children at level 2 under their parent), the full name as value, sub-courses said so', () => {
  const html = render(h(PageScope, { courses: focusCourses, value: '*', onChange() {} }));
  const options = [...html.matchAll(/<option value="([^"]*)"(?: title="([^"]*)")?[^>]*>([^<]*)<\/option>/g)].map(([, value, title, text]) => ({ value, title, text }));
  const labels = options.map(option => option.text.replace(/ /g, '_'));
  const at = text => labels.findIndex(label => label.includes(text));
  assert.ok(at(P) >= 0 && at('01 云计算') > at(P) && at('05 Kubernetes') > at('01 云计算') && at('07 微服务') > at('05 Kubernetes') && at('08 Serverless') > at('07 微服务') && at('10 Serverless') > at('08 Serverless'),
    'chapters follow their parent in natural order');
  assert.match(labels[at('05 Kubernetes')], /^05 Kubernetes/, 'a chapter shows only its last segment, flush left in the label');
  assert.match(html, /<option[^>]*data-level="2"[^>]*>05 Kubernetes/, 'and hangs at level 2 on the hairline in the open list');
  assert.doesNotMatch(labels[at('05 Kubernetes')], /Cloud Native/);
  const chapter = options[at('05 Kubernetes')];
  assert.equal(chapter.value.replace(/&amp;/g, '&'), NAMES.c05, 'choosing a child fills the full path');
  assert.equal(options[at('01 云计算')].value, NAMES.c01, 'the stored spelling, as typed');
  assert.match(labels[at(P)], /含子课程/, 'a parent says it includes its sub-courses');
  assert.doesNotMatch(labels[at('Databases')], /含子课程/);
  assert.match(labels[at('TCP/IP')], /^TCP\/IP$/, 'a slash inside a name is not a hierarchy');
  assert.equal(options.filter(option => option.value === 'Lone').length, 1, 'an implicit parent is listed once');
  assert.ok(at('ch 2') < at('ch 10'), 'natural order: 2 before 10');
  assert.ok(labels.indexOf('未分类') > at('ch 10'), 'unassigned stays last');
  assert.match(html, /<option value="\*"[^>]*>全部课程/);
});

test('PageScope: the chosen child is named in full below the select; English has no Han outside user data', () => {
  const chosen = render(h(PageScope, { courses: focusCourses, value: NAMES.c05, onChange() {} }));
  assert.match(chosen, /class="page-scope__path"[^>]*>Cloud Native Solution Design › 05 Kubernetes/);
  assert.doesNotMatch(render(h(PageScope, { courses: focusCourses, value: P, onChange() {} })), /page-scope__path/);
  const en = render(h(PageScope, { courses: focusCourses, value: NAMES.c07, onChange() {} }), 'en');
  noHan(en);
  assert.match(en, /Includes sub-courses/);
  assert.match(en, />All courses</);
  const plain = render(h(PageScope, { courses: ['Databases', 'Algorithms'], value: '*', onChange() {} }));
  assert.doesNotMatch(plain, /含子课程/);
});

test('decksInCourse and inScope read the whole subtree and keep the special scopes', () => {
  const data = { focus: { courses: focusCourses }, decks: [
    { id: 'p', course: P }, { id: 'a', course: NAMES.c01 }, { id: 'b', course: NAMES.c05 }, { id: 'c', course: 'Cloud Native' }, { id: 't', course: 'TCP/IP' },
    { id: 'u', course: '' }, { id: 'x', folder: NAMES.c07 }, { id: 'old', course: P, archived: true }, { id: 'sys', course: P, systemKind: 'x' }] };
  const ids = course => decksInCourse(data, course).map(deck => deck.id);
  assert.deepEqual(ids(P), ['p', 'a', 'b', 'x']);
  assert.deepEqual(ids(NAMES.c05), ['b']);
  assert.deepEqual(ids('Cloud Native'), ['c']);
  assert.deepEqual(ids(''), ['u']);
  assert.deepEqual(ids('*'), ['p', 'a', 'b', 'c', 't', 'u', 'x']);
  assert.equal(courseMatcher(data, P)(NAMES.c01), true);
  assert.equal(courseMatcher(data, NAMES.c05)(P), false);
  const known = focusCourses.map(item => item.name);
  assert.equal(inScope({ courses: [NAMES.c01] }, P, known), true);
  assert.equal(inScope({ courses: [NAMES.c01] }, NAMES.c05, known), false);
  assert.equal(inScope({ courses: [] }, '', known), true);
  assert.equal(inScope({ courses: [P] }, '', known), false);
  assert.equal(inScope({ courses: [] }, P, known), false);
  assert.equal(inScope({ courses: ['Cloud Native'] }, P, known), false);
  assert.equal(inScope({ courses: [NAMES.c05, 'Databases'] }, '*', known), true);
});

const filing = value => render(h(CourseField, { courses: focusCourses, value, onChange() {}, initialOpen: true }));

test('CourseField: the full list shows chapters under their parent and choosing one fills the full path', () => {
  const html = filing(NAMES.c07);
  assert.match(html, /role="listbox"/);
  const rows = [...html.matchAll(/<li[^>]*role="option"[^>]*>/g)].map(match => match[0]);
  assert.ok(rows.some(row => /course-field__option--group/.test(row) && /aria-expanded="true"/.test(row)), 'the parent of the chosen chapter starts open');
  assert.match(html, /05 Kubernetes：对象、运行机制与故障诊断/);
  assert.doesNotMatch(html, new RegExp('>' + NAMES.c05.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '<'), 'a chapter row shows its last segment only');
  assert.match(html, /--depth:1/);
  assert.equal(pickCourse('', NAMES.c05, false, focusCourses.map(item => item.name)), NAMES.c05);
  assert.equal(pickCourse(`Databases; ${NAMES.c01}`, NAMES.c05, true, focusCourses.map(item => item.name)),`Databases; ${NAMES.c01}; ${NAMES.c05}`);
  const en = render(h(CourseField, { courses: focusCourses, value: NAMES.c07, onChange() {}, initialOpen: true }), 'en');
  noHan(en);
});

test('CourseField: an implicit parent can be filed under like any course', () => {
  const html = filing('Lone / ch 2');
  assert.match(html, /Lone/);
  assert.match(html, /ch 2/);
  assert.match(html, /ch 10/);
});

test('Settings course list: a parent counts its sub-courses and says so; an implicit parent has no settings of its own', () => {
  const records = [course('Databases'), course(P, { decks: 1, sources: 1, decksTotal: 4, sourcesTotal: 7 }), course(NAMES.c05, { sources: 3 }), course(NAMES.c07, { sources: 4 }),
    course(NAMES.c10, { sources: 2 }), course('Lone / ch 1', { sources: 1 }), course('Lone / ch 2', { sources: 1 })];
  const html = render(h(CourseList, { courses: records, onOpen() {}, onMerge() {}, defaultOpenGroups: [P, 'Lone'] }));
  assert.match(html, /3 个章节/);
  assert.match(html, /含子课程共 7 份资料/);
  assert.match(html, /Lone[\s\S]*?2 个章节/);
  const lone = html.slice(html.indexOf('course-list__group', html.indexOf('>Lone<') - 400));
  assert.ok(lone.length > 0);
  const en = render(h(CourseList, { courses: records, onOpen() {}, onMerge() {}, defaultOpenGroups: [P] }), 'en');
  noHan(en);
  assert.match(en, /incl\. sub-courses/);
});

test('PageScope: a closed picker shows the chosen course without indentation spaces; depth is a level in the open list; the path wraps instead of being cut', async () => {
  const { readFileSync } = await import('node:fs');
  const html = render(h(PageScope, { courses: focusCourses, value: NAMES.c07, onChange() {} }));
  const options = [...html.matchAll(/<option([^>]*)>([^<]*)</g)].map(match => ({ attrs: match[1], text: match[2] }));
  assert.ok(options.length > 3);
  for (const option of options) assert.doesNotMatch(option.text, /^[\s ]/, `no leading spaces in the label "${option.text}" (the closed select would show them)`);
  const child = options.find(option => /07 微服务/.test(option.text));
  assert.match(child.attrs, /data-level="[23]"/, 'a child hangs at a level (drawn on the hairline by the open list only)');
  const root = options.find(option => /^全部课程$/.test(option.text));
  assert.doesNotMatch(root.attrs, /data-level/);
  const css = readFileSync(new URL('../ui/course-active.css', import.meta.url), 'utf8');
  const pathRule = /\.page-scope__path\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(pathRule, /white-space:\s*nowrap/, 'the whole path is shown, wrapped');
  assert.doesNotMatch(pathRule, /text-overflow:\s*ellipsis/);
  assert.match(pathRule, /overflow-wrap:\s*anywhere/);
  const scopeRule = /\.page-scope\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(scopeRule, /max-width:\s*340px/, 'long chapter titles get more room than 340px');
});
