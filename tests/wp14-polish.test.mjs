/* WP14 · 2.1.1 polish from the owner's first real use of 2.1.0 with a large
   library (18 courses, ~180 sources in one course, "Course / Chapter" names and
   a near-duplicate pair): a readable source viewer, a clearable course field,
   one bounded scroll window for long lists, chapter grouping, duplicate hints
   and a compact language switch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { ScrollWindow, filterItems } from './ui/components/index.js';
  export { default as CourseField, courseQuery, pickCourse } from './ui/CourseField.jsx';
  export { CourseList, default as CourseSettings } from './ui/CourseSettings.jsx';
  export { groupCourseNames, findDuplicateCourses, courseNameKey, splitCourseName, rankCourses } from './ui/course-names.js';
  export { default as SourcePicker } from './ui/SourcePicker.jsx';
  export { default as DocumentViewer, sourceTextClass, originalHandling, viewerFormat } from './ui/document-preview/DocumentViewer.jsx';
  export { sourceFormatLabel } from './ui/SourcePicker.jsx';
  export { default as LanguageSwitch } from './ui/LanguageSwitch.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { ScrollWindow, filterItems, CourseField, courseQuery, pickCourse, rankCourses, CourseList, CourseSettings, groupCourseNames, findDuplicateCourses, courseNameKey,
  splitCourseName, SourcePicker, DocumentViewer, sourceTextClass, originalHandling, viewerFormat, sourceFormatLabel, LanguageSwitch, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const h = React.createElement;

/* ---------- a library shaped like the owner's ---------- */
const CNSD = 'Cloud Native Solution Design';
const chapterNames = ['01 云计算概览与参考架构', '02 容器与镜像', '03 微服务拆分', '04 服务网格', '05 Kubernetes：对象、运行机制与故障诊断', '06 可观测性', '07 安全与合规'];
let n = 0;
const course = (name, extra = {}) => ({ id: `course-${String(++n).padStart(12, '0')}`, name, aliases: [], guidanceSourceIds: [], focusTopics: [], decks: 1, drafts: 0, sources: 3, ...extra });
const chapters = chapterNames.map(name => course(`${CNSD} / ${name}`, { sources: name.startsWith('05') ? 180 : 4 }));
const duplicate = course(`${CNSD}/01 云计算概览与参考架构`, { decks: 0, sources: 2 });
const plain = ['Databases', 'Operating Systems', '数据结构', '计算机网络', 'Machine Learning', 'TCP/IP Basics', 'TCP/IP Advanced', '编译原理', '软件工程', 'Algorithms']
  .map(name => course(name));
const courses = [plain[0], ...chapters.slice(0, 3), duplicate, ...plain.slice(1), ...chapters.slice(3)];

test('fixture: 18 courses with chapters and a near-duplicate', () => {
  assert.equal(courses.length, 18);
});

/* ---------- 1 · source viewer ---------- */

test('sourceTextClass keeps the layout style for PDF page text only', () => {
  assert.match(sourceTextClass({ format: 'pdf' }), /source-text--pdf/);
  assert.doesNotMatch(sourceTextClass({ format: 'pdf' }), /reading/);
  for (const value of [{ format: 'txt' }, { format: 'txt', audio: { provider: 'gemini' } }, { format: 'md' }, { format: 'html' }, {}])
    assert.match(sourceTextClass(value), /source-text--reading/, JSON.stringify(value));
  assert.match(sourceTextClass({ format: 'pdf', audio: {} }), /source-text--pdf/);
  for (const value of [{ format: 'pdf' }, { format: 'txt' }]) assert.match(sourceTextClass(value), /^source-text\b/);
});

const transcript = { id: 'audio-1', title: '第 3 讲 · 中英对照逐字稿', text: 'A long transcript line that should wrap instead of being cut off at the right edge. '.repeat(20),
  audio: { provider: 'gemini', importedAt: '2026-09-01T00:00:00.000Z' }, courses: [] };
const pdfPage = { id: 'pdf-p1', title: 'slides.pdf · p.1', text: 'page one', document: { id: 'd', filename: 'slides.pdf', page: 1, format: 'pdf' }, courses: [] };
const viewer = (source, props = {}, language) => render(h(DocumentViewer, { source, call: async () => ({}), data: { decks: [] }, ...props }), language);

test('a transcript opens in the readable style, a PDF page in the layout style', () => {
  const html = viewer(transcript);
  assert.match(html, /<pre class="source-text source-text--reading"/);
  assert.doesNotMatch(html, /pdf-extracted-text/);
  const pdf = viewer(pdfPage);
  assert.match(pdf, /source-text--pdf/);
});

test('the viewer toolbar is one row: the mode switch on the left, generate as the primary action on the right', () => {
  const html = viewer(transcript, { onGenerate() {} });
  const toolbar = html.match(/<div class="study-document-toolbar">([\s\S]*?)<div class="study-document-notices"/)?.[1] || '';
  assert.match(toolbar, /class="sh-seg[^"]*"[^>]*role="group"|role="group"[^>]*class="sh-seg/, 'the 排版/原文 switch is the shared SegmentedControl');
  assert.match(toolbar, /aria-pressed="true"[^>]*>排版</);
  assert.match(toolbar, /原文/);
  assert.match(toolbar, /class="sh-btn sh-btn--primary[^"]*"[^>]*>[\s\S]*?从这份资料出题/, 'generate is the primary button inside the toolbar');
  assert.ok(toolbar.indexOf('sh-seg') < toolbar.indexOf('从这份资料出题'), 'switch first, generate last');
  assert.doesNotMatch(viewer(transcript), /从这份资料出题/, 'no generate button without onGenerate');
  const pdf = viewer(pdfPage, { onGenerate() {} });
  assert.match(pdf, /原始 PDF/);
  assert.match(pdf, /可选中的提取文字/);
  const en = viewer(transcript, { onGenerate() {} }, 'en');
  assert.match(en, /Generate from this source/);
  assert.match(en, /Formatted/);
});

test('the selection panel keeps its buttons inside one bordered box, full width', () => {
  const html = viewer(transcript, { onCaseFromPassage() {} });
  const panel = html.match(/<div class="study-document-selection">([\s\S]*?)<\/div><h3/)?.[1] || '';
  assert.match(panel, /使用当前选区/);
  assert.match(panel, /围绕这段出案例题/);
  for (const label of ['使用当前选区', '围绕这段出案例题'])
    assert.match(panel, new RegExp(`class="sh-btn [^"]*study-document-wide[^"]*"[^>]*>(?:<[^>]+>)*${label}`), `${label} is a full-width shared button`);
});

/* ---------- 2 · course field ---------- */

const names = courses.map(item => ({ name: item.name }));
const field = (props, language) => render(h(CourseField, { courses: names.slice(0, 4), value: '', onChange() {}, ...props }), language);

test('the course field offers a × to clear and a one-line hint', () => {
  const filled = field({ value: 'Databa' });
  assert.match(filled, /aria-label="清空课程"/);
  assert.match(filled, /输入新课程名，或点下方已有课程直接切换；点 × 清空。/);
  assert.doesNotMatch(field({ value: '' }), /清空课程/, 'nothing to clear');
  const multiple = field({ value: 'Databases; 数据结构', multiple: true });
  assert.match(multiple, /aria-label="清空课程"/);
  assert.match(multiple, /多门课程用分号分隔/);
  const en = field({ value: 'Databa' }, 'en');
  assert.doesNotMatch(en.replace(/(value|title)="[^"]*"/g, '').replace(/>[^<]*(Cloud|数据|计算|编译|软件|Databases)[^<]*</g, '><'), han);
});

test('an exact course name does not attach the native datalist', () => {
  const exact = field({ value: 'Databases' });
  assert.doesNotMatch(exact, /<datalist/);
  assert.doesNotMatch(exact, / list="/);
  const partial = field({ value: 'Data' });
  assert.match(partial, /<datalist/);
  assert.match(partial, / list="/);
});

/* 60 courses: 6 parents × 8 chapters with long names, 11 ordinary courses and one near-duplicate. */
const PARENTS = ['Cloud Native Solution Design', 'Distributed Systems Engineering', 'Machine Learning Systems', '软件架构与设计模式', 'Information Security Management', '数据密集型应用设计'];
const sixty = [
  ...PARENTS.flatMap((parent, p) => Array.from({ length: 8 }, (_, c) => ({ name: `${parent} / 0${c + 1} 第 ${c + 1} 章：一个相当长的章节标题，用来测试截断与分组`,
    count: (p + c) % 3, sourceCount: c === 4 ? 180 : 2, lastUsedAt: `2026-0${(c % 9) + 1}-1${p}T08:00:00.000Z` }))),
  ...['Databases', 'Operating Systems', '数据结构', '计算机网络', 'Compilers', '软件工程', 'Algorithms', 'TCP/IP Basics', 'HCI', 'Statistics', 'Ethics']
    .map((name, index) => ({ name, count: index, sourceCount: 0 })),
  { name: `${PARENTS[0]}/01 第 1 章：一个相当长的章节标题，用来测试截断与分组`, count: 0, sourceCount: 1 },
];
const picks = html => [...html.matchAll(/<button type="button" class="course-field__pick([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].map(match => ({ cls: match[1], html: match[0] }));

test('rankCourses: the current course first, then recently used, then the busiest', () => {
  const list = [{ name: 'A', count: 1 }, { name: 'B', count: 9 }, { name: 'C', count: 0, lastUsedAt: '2026-09-01T00:00:00Z' },
    { name: 'D', count: 0, lastUsedAt: '2026-09-20T00:00:00Z' }, { name: 'E', sourceCount: 4 }];
  assert.deepEqual(rankCourses({ courses: list }).map(item => item.name), ['D', 'C', 'B', 'E', 'A']);
  assert.deepEqual(rankCourses({ courses: list, current: 'A' }).map(item => item.name), ['A', 'D', 'C', 'B', 'E']);
  assert.deepEqual(rankCourses({ courses: list, recent: { A: '2026-10-01T00:00:00Z' } }).map(item => item.name), ['A', 'D', 'C', 'B', 'E']);
  assert.deepEqual(rankCourses({ courses: ['x', 'y'] }).map(item => item.name), ['x', 'y'], 'plain names keep their order');
  assert.deepEqual(rankCourses({ courses: [{ name: 'S', sources: 3, decks: 1 }, { name: 'T', sources: 1 }] }).map(item => item.name), ['S', 'T'], 'course records count too');
});

test('many courses: at most six chips in one row, chapters folded into one parent chip, then 全部课程 (N)', () => {
  const html = render(h(CourseField, { courses: sixty, value: '', onChange() {} }));
  const chips = picks(html);
  const more = chips.filter(chip => /course-field__more/.test(chip.cls));
  assert.equal(more.length, 1);
  assert.match(more[0].html, /全部课程 \(60\)/);
  assert.match(more[0].html, /aria-expanded="false"/);
  assert.ok(chips.length - more.length <= 6, `at most 6 quick picks, got ${chips.length - more.length}`);
  const parent = chips.find(chip => /course-field__pick--group/.test(chip.cls));
  assert.ok(parent, 'a parent chip stands for its chapters');
  assert.match(parent.html, /· 8 章/);
  assert.match(parent.html, /aria-expanded="false"/);
  assert.equal((html.match(/第 3 章/g) || []).length, 0, 'chapters stay folded until the parent chip is opened');
  assert.doesNotMatch(html, /<datalist/, 'the course list replaces the native datalist');
  assert.match(html, /role="combobox"/);
  const en = render(h(CourseField, { courses: sixty, value: '', onChange() {} }), 'en');
  assert.match(en, /All courses \(60\)/);
  assert.match(en, /· 8 ch\./);
});

test('a chapter as the value opens its parent chip with short chapter names; long names keep their full title', () => {
  const value = sixty[12].name; // Distributed Systems Engineering / 05 …
  const html = render(h(CourseField, { courses: sixty, value, onChange() {} }));
  const chips = picks(html);
  assert.match(chips[0].html, /Distributed Systems Engineering/, 'the current course comes first');
  assert.match(chips[0].html, /aria-expanded="true"/);
  const row = html.match(/<div class="course-field__chapters"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(row, /aria-label="「Distributed Systems Engineering」的章节"/);
  assert.equal((row.match(/<button/g) || []).length, 8);
  assert.match(row, new RegExp(`aria-pressed="true"[^>]*title="${value}"|title="${value}"[^>]*aria-pressed="true"`));
  assert.match(row, />05 第 5 章：一个相当长的章节标题，用来测试截断与分组</, 'only the chapter part is shown');
  assert.match(row, new RegExp(`aria-label="${value}"`), 'the full name is the accessible name');
});

test('the 全部课程 panel lists every course grouped and filtered by the typed text, as a listbox', () => {
  const html = render(h(CourseField, { courses: sixty, value: 'statis', onChange() {}, initialOpen: true }));
  const panel = html.match(/<div class="course-field__panel"[\s\S]*$/)?.[0] || '';
  assert.match(panel, /role="listbox"/);
  assert.equal((panel.match(/role="option"/g) || []).length, 1);
  assert.match(panel, />Statistics</);
  assert.match(html, /显示 1 \/ 共 60 门/);
  const all = render(h(CourseField, { courses: sixty, value: '', onChange() {}, initialOpen: true }));
  const list = all.match(/<div class="course-field__panel"[\s\S]*$/)?.[0] || '';
  assert.equal((list.match(/course-field__option--group/g) || []).length, 6, 'six collapsible parents');
  assert.match(list, /aria-expanded="false"/);
  const chapter = render(h(CourseField, { courses: sixty, value: '第 7 章', onChange() {}, initialOpen: true }));
  const hits = chapter.match(/<div class="course-field__panel"[\s\S]*$/)?.[0] || '';
  assert.equal((hits.match(/course-field__option--chapter/g) || []).length, 6, 'a chapter hit opens its parent');
  assert.match(hits, /aria-expanded="true"/);
  assert.match(html, /aria-activedescendant="[^"]+"/, 'the first result is active for Enter');
});

test('small lists keep plain chips, and multiple mode replaces the typed part when a course is picked', () => {
  const few = render(h(CourseField, { courses: names.slice(0, 5), value: '', onChange() {} }));
  assert.doesNotMatch(few, /course-field__more|role="combobox"/, 'a handful of courses need no list');
  assert.equal(picks(few).length, 5);
  assert.equal(pickCourse('Databases; Stat', 'Statistics', true, ['Databases', 'Statistics']), 'Databases; Statistics');
  assert.equal(pickCourse('Databases; Statistics', 'Databases', true, ['Databases', 'Statistics']), 'Statistics');
  assert.equal(pickCourse('Data', 'Databases', false, ['Databases']), 'Databases');
  assert.equal(courseQuery('Databases; Oper', true), 'Oper');
  assert.equal(courseQuery('  Data ', false), 'Data');
});

test('focusView reports when each course was last used', async () => {
  const { focusView } = await import('../lib/focus.js');
  const state = { decks: [{ id: 'd1', title: 'D', course: 'Databases', cards: [], createdAt: '2026-01-01T00:00:00.000Z' }], drafts: [],
    sources: [{ id: 's1', title: 'x', text: 'x', courses: ['Systems'], createdAt: '2026-03-01T00:00:00.000Z' }],
    attempts: [{ id: 'a', deckId: 'd1', quiz_id: 'q', timestamp: '2026-05-01T00:00:00.000Z', grade: 3 }], runs: [], courses: [], focus: {} };
  const courses = Object.fromEntries(focusView(state).courses.map(course => [course.name, course.lastUsedAt]));
  assert.equal(courses.Databases, '2026-05-01T00:00:00.000Z', 'practice counts as use');
  assert.equal(courses.Systems, '2026-03-01T00:00:00.000Z', 'an import counts as use');
});

/* ---------- 3 · ScrollWindow ---------- */

const fruit = ['Apple', 'Banana', 'Cherry', 'Date'];
const windowOf = (props, language) => render(h(ScrollWindow, { label: '水果', items: fruit, itemKey: item => item, renderItem: item => h('span', null, item), ...props }), language);

test('ScrollWindow is a focusable, named, bounded region', () => {
  const html = windowOf({});
  assert.match(html, /<div[^>]*class="sh-scroll__viewport"[^>]*>/);
  const viewport = html.match(/<div[^>]*class="sh-scroll__viewport"[^>]*>/)[0];
  assert.match(viewport, /role="region"/);
  assert.match(viewport, /aria-label="水果"/);
  assert.match(viewport, /tabindex="0"/);
  assert.match(html, /--sh-scroll-max:\s*380px/, 'a sensible default height');
  assert.match(windowOf({ maxHeight: 240 }), /--sh-scroll-max:\s*240px/);
  assert.equal((html.match(/data-scroll-key=/g) || []).length, 4);
  assert.doesNotMatch(html, /type="search"/, 'no filter unless asked');
});

test('ScrollWindow filters with a live count', () => {
  const html = windowOf({ filterable: true, filterPlaceholder: '筛选水果…' });
  assert.match(html, /type="search"[^>]*placeholder="筛选水果…"|placeholder="筛选水果…"[^>]*type="search"/);
  assert.match(html, /aria-label="筛选水果…"/);
  assert.match(html, /共 4 项/);
  const filtered = windowOf({ filterable: true, query: 'an' });
  assert.match(filtered, /共 4 项 \/ 显示 1 项/);
  assert.equal((filtered.match(/data-scroll-key=/g) || []).length, 1);
  assert.match(filtered, /Banana/);
  const none = windowOf({ filterable: true, query: 'zzz' });
  assert.match(none, /没有匹配的项/);
  assert.match(windowOf({ filterable: true, query: 'an' }, 'en'), /4 items \/ showing 1/);
  assert.deepEqual(filterItems(fruit, ' CH '), ['Cherry']);
  assert.deepEqual(filterItems(fruit, ''), fruit);
  assert.deepEqual(filterItems([{ t: 'x' }, { t: 'y' }], 'y', item => item.t), [{ t: 'y' }]);
});

test('ScrollWindow marks the active item for keeping it in view', () => {
  const html = windowOf({ activeKey: 'Cherry' });
  assert.match(html, /data-scroll-key="Cherry"[^>]*data-active="true"|data-active="true"[^>]*data-scroll-key="Cherry"/);
});

/* ---------- 4 · grouping and 5 · duplicates ---------- */

test('splitCourseName reads "Course / Chapter" and leaves ordinary slashes alone', () => {
  assert.deepEqual(splitCourseName(`${CNSD} / 05 Kubernetes`), { parent: CNSD, chapter: '05 Kubernetes' });
  assert.deepEqual(splitCourseName(`${CNSD}/01 云计算概览`), { parent: CNSD, chapter: '01 云计算概览' });
  assert.deepEqual(splitCourseName(`${CNSD} ／ 02 容器`), { parent: CNSD, chapter: '02 容器' }, 'full-width slash');
  assert.equal(splitCourseName('TCP/IP Basics'), null, 'a one-word part before an unspaced slash is not a course');
  assert.equal(splitCourseName('Databases'), null);
  assert.equal(splitCourseName(' / x'), null);
});

test('groupCourseNames groups chapters under their course, in order, without renaming', () => {
  const groups = groupCourseNames(courses);
  const cnsd = groups.find(entry => entry.type === 'group');
  assert.equal(cnsd.name, CNSD);
  assert.equal(cnsd.chapters.length, 8, 'seven chapters plus the unspaced duplicate');
  assert.deepEqual(cnsd.chapters.map(item => item.course.name), cnsd.chapters.map(item => item.course.name).slice().sort((a, b) => splitCourseName(a).chapter.localeCompare(splitCourseName(b).chapter, undefined, { numeric: true })));
  assert.ok(cnsd.chapters.every(item => courses.includes(item.course)), 'the original records, untouched');
  assert.equal(cnsd.chapters.find(item => item.course === chapters[4]).chapter, '05 Kubernetes：对象、运行机制与故障诊断');
  assert.equal(groups.filter(entry => entry.type === 'course').length, 10);
  assert.equal(groups.indexOf(cnsd), 1, 'the group sits where its first chapter was');
  assert.ok(groups.some(entry => entry.type === 'course' && entry.course.name === 'TCP/IP Basics'));
  const alone = groupCourseNames([course('Physics / 01 Mechanics'), course('Chemistry')]);
  assert.deepEqual(alone.map(entry => entry.type), ['course', 'course'], 'a single chapter is not a group');
  const parented = groupCourseNames([course('Physics'), course('Physics / 01 Mechanics'), course('Physics / 02 Waves')]);
  assert.equal(parented.length, 1);
  assert.equal(parented[0].parent.name, 'Physics', 'a course named like the group heads it');
});

test('findDuplicateCourses matches names equal after normalising spaces, width and slashes', () => {
  assert.equal(courseNameKey(`${CNSD}/01 云计算概览与参考架构`), courseNameKey(`${CNSD} / 01 云计算概览与参考架构`));
  assert.equal(courseNameKey('Ｄａｔａｂａｓｅｓ  101'), courseNameKey('Databases 101'));
  assert.equal(courseNameKey('Kubernetes：对象'), courseNameKey('Kubernetes: 对象'));
  assert.notEqual(courseNameKey('Databases 1'), courseNameKey('Databases 2'));
  const found = findDuplicateCourses(courses);
  assert.deepEqual(found.get(duplicate.id).map(item => item.id), [chapters[0].id]);
  assert.deepEqual(found.get(chapters[0].id).map(item => item.id), [duplicate.id]);
  assert.equal(found.size, 2);
  assert.equal(findDuplicateCourses([course('A'), course('B')]).size, 0);
});

const list = (props = {}, language) => render(h(CourseList, { courses, onOpen() {}, onMerge() {}, ...props }), language);

test('Settings › 课程 is a filterable window of compact rows with chapter groups', () => {
  const html = list();
  assert.match(html, /class="sh-scroll[ "]/);
  assert.match(html, /placeholder="筛选课程…"/);
  assert.match(html, /共 11 项/, '10 courses and one group');
  assert.match(html, /aria-expanded="false"[^>]*>[\s\S]*?Cloud Native Solution Design/, 'the group starts collapsed');
  assert.match(html, /8 个章节/);
  assert.doesNotMatch(html, /05 Kubernetes/, 'chapters stay hidden while collapsed');
  assert.equal((html.match(/>设置</g) || []).length, 10, 'each visible course keeps its own 设置');
  assert.doesNotMatch(html, /course-list__item"[^>]*style/, 'no giant cards');
  const open = list({ defaultOpenGroups: [CNSD] });
  assert.match(open, /05 Kubernetes：对象、运行机制与故障诊断/);
  assert.equal((open.match(/>设置</g) || []).length, 18);
  const filtered = list({ defaultQuery: 'kubernetes' });
  assert.match(filtered, /05 Kubernetes/, 'a filter that hits a chapter opens its group');
  assert.match(filtered, /共 11 项 \/ 显示 1 项/);
  const en = list({}, 'en');
  assert.match(en, /Filter courses…/);
  assert.match(en, /8 chapters/);
});

test('near-duplicates get a hint and a merge action; the group says so while collapsed', () => {
  const closed = list();
  assert.match(closed, /1 处可能重复/);
  const html = list({ defaultOpenGroups: [CNSD] });
  assert.match(html, new RegExp(`可能与「${CNSD} / 01 云计算概览与参考架构」重复`));
  assert.match(html, new RegExp(`可能与「${CNSD}/01 云计算概览与参考架构」重复`));
  assert.equal((html.match(/>合并到这里</g) || []).length, 2);
  const en = list({ defaultOpenGroups: [CNSD] }, 'en');
  assert.match(en, /May duplicate/);
  assert.match(en, /Merge into this/);
});

test('合并到这里 opens the existing merge confirmation with the duplicate preselected', () => {
  const data = { courses, sources: [], focus: {} };
  const html = render(h(CourseSettings, { data, courseId: chapters[0].id, mergeFrom: [duplicate.id], act: async () => {}, onClose() {} }));
  assert.match(html, /把 1 门课程并入「Cloud Native Solution Design \/ 01 云计算概览与参考架构」？/);
  assert.match(html, /确认合并/);
  const checked = html.match(/<input type="checkbox" checked=""[^>]*>[\s\S]*?<strong>([^<]+)<\/strong>/);
  assert.equal(checked?.[1], duplicate.name);
});

/* ---------- SourcePicker inside a window ---------- */

const many = Array.from({ length: 180 }, (_, index) => ({ id: `s${index}`, title: `讲义 ${String(index + 1).padStart(3, '0')} · ${index % 2 ? 'Pods' : 'Services'}.md`,
  text: 'x', createdAt: '2026-09-30T08:00:00.000Z', courses: [chapters[4].name],
  document: { materialId: `document-${index}-md`, materialRevision: 'r', format: 'md', filename: `n${index}.md` } }));

test('SourcePicker lists documents inside a filterable scroll window', () => {
  const html = render(h(SourcePicker, { sources: many, selected: [], onChange() {} }));
  assert.match(html, /class="sh-scroll[ "]/);
  assert.match(html, /placeholder="筛选资料…"/);
  assert.match(html, /共 180 项/);
  assert.equal((html.match(/data-document-key="/g) || []).length, 180);
  const filtered = render(h(SourcePicker, { sources: many, selected: [], onChange() {}, defaultQuery: 'Pods' }));
  assert.equal((filtered.match(/data-document-key="/g) || []).length, 90);
  assert.match(filtered, /选择筛选结果/, 'select-all follows the filter');
  assert.match(render(h(SourcePicker, { sources: many, selected: [], onChange() {} }), 'en'), /Filter materials…/);
});

/* ---------- language switch ---------- */

test('the language switch is one compact row with a small segmented control', () => {
  const html = render(h(LanguageSwitch, { language: 'zh', onChange() {} }));
  assert.match(html, /class="study-language-switch"/);
  assert.match(html, /class="sh-seg sh-seg--sm/);
  assert.match(html, /aria-label="Interface language \/ 界面语言"/);
  assert.match(html, /aria-pressed="true"[^>]*>中文</);
  assert.match(html, /aria-pressed="false"[^>]*>EN</);
  assert.match(html, />语言</);
  assert.match(render(h(LanguageSwitch, { language: 'en', onChange() {} }), 'en'), />Language</);
  const narrow = render(h(LanguageSwitch, { language: 'zh', narrow: true, onChange() {} }));
  assert.equal((narrow.match(/<button/g) || []).length, 1, 'the icon rail gets one small toggle');
  assert.match(narrow, /aria-label="Interface language \/ 界面语言[^"]*"/);
  assert.match(narrow, />中</);
  assert.match(render(h(LanguageSwitch, { language: 'en', narrow: true, onChange() {} })), />EN</);
});

/* ---------- Word and PowerPoint (WP22) in the viewer and the picker ---------- */

const slide = n => ({ id: `pptx-s${n}`, title: `deck.pptx · p.${n}`, text: `slide ${n} text`, createdAt: '2026-10-01T08:00:00.000Z', courses: [],
  document: { id: 'p'.repeat(64), filename: 'deck.pptx', page: n, totalPages: 12, format: 'pptx', materialId: 'document-p-pptx' } });

test('office originals are downloaded, never decoded as text; office text reads like prose', () => {
  assert.equal(originalHandling({ originalAvailable: true, format: 'pdf' }), 'pdf');
  assert.equal(originalHandling({ originalAvailable: true, format: 'md' }), 'text');
  assert.equal(originalHandling({ originalAvailable: true, format: 'docx' }), 'download');
  assert.equal(originalHandling({ originalAvailable: true, format: 'pptx' }), 'download');
  assert.equal(originalHandling({ originalAvailable: false, format: 'docx' }), 'none');
  for (const format of ['docx', 'pptx']) assert.match(sourceTextClass({ format }), /source-text--reading/);
  assert.equal(viewerFormat(null, slide(1)), 'pptx', 'a slide is a slide before the document loads');
  assert.equal(viewerFormat(null, pdfPage), 'pdf');
  assert.equal(viewerFormat(null, transcript), 'txt');
  const html = viewer(slide(2));
  assert.match(html, /data-study-page="2"/, 'slides get page sections like PDF pages');
  assert.match(html, /<pre class="source-text source-text--reading"/);
  assert.doesNotMatch(html, /source-text--pdf/);
});

test('the picker labels Word and PowerPoint and groups a deck of slides', () => {
  setUiLanguage('zh');
  const html = render(h(SourcePicker, { sources: Array.from({ length: 12 }, (_, i) => slide(i + 1)), selected: [], onChange() {} }));
  assert.equal((html.match(/data-document-key="/g) || []).length, 1);
  assert.match(html, /PowerPoint · 12 页/);
  assert.match(html, /选择页面/);
  assert.match(render(h(SourcePicker, { sources: Array.from({ length: 12 }, (_, i) => slide(i + 1)), selected: [], onChange() {} }), 'en'), /PowerPoint · 12 slides/);
  const word = { id: 'w', title: 'notes.docx', text: 'x', createdAt: '2026-10-01T08:00:00.000Z', courses: [], document: { format: 'docx', filename: 'notes.docx', materialId: 'document-w-docx' } };
  assert.equal(sourceFormatLabel(word), 'Word');
  assert.match(sourceFormatLabel(slide(3)), /^PowerPoint · 第 3 页/);
});
