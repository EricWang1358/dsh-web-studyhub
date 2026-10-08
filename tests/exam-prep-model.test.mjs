import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { TIER_LABEL, examPointListSummary } from '../lib/exam-point-list.js';
import { STAMP, library, pointList, buildJob, snapshot } from './helpers/exam-prep-fixtures.mjs';

/* The 备考补习 page, its pure part (ui/exam-prep/model.js and words.js): the point list a learner sees is read from a source record of
   the library (lib/exam-blueprint-material.js) and from the build jobs of the snapshot. Nothing here draws or calls anything. */

const code = await loadUi(`
  export * from './ui/exam-prep/model.js';
  export * from './ui/exam-prep/words.js';
  export { setUiLanguage } from './ui/i18n.js';
  export { pageAvailable } from './ui/capabilities.js';
  export { PAGES, pagesInGroup } from './ui/pages.js';
  export { NAV_DEFAULTS, mergeOrder } from './ui/nav-order.js';`);
const m = code;
const english = fn => { m.setUiLanguage('en'); try { return fn(); } finally { m.setUiLanguage('zh'); } };
const han = /[㐀-鿿]/;

/* ---------- the gate ---------- */

test('the page exists only when the host says the exam-point build is switched on; off, nothing else about the app changes', () => {
  assert.equal(m.examPrepEnabled(snapshot({ on: true })), true);
  assert.equal(m.examPrepEnabled(snapshot({ on: false })), false);
  assert.equal(m.examPrepEnabled({}), false, 'an older host or the offline demo has no switch: off');
  assert.equal(m.examPrepEnabled({ features: { examBlueprint: 'yes' } }), false, 'only a literal true');
  assert.equal(m.examPrepEnabled(null), false);
  assert.equal(m.examPrepEnabled({ experimental: true }), false, 'the experimental switch alone does not show it: the build switch does');
  assert.equal(m.pageAvailable(snapshot({ on: true }), 'examprep'), true);
  assert.equal(m.pageAvailable(snapshot({ on: false }), 'examprep'), false);
  assert.equal(m.pageAvailable({}, 'examprep'), false, 'default off, even for a host that publishes no capability list');
  assert.equal(m.pageAvailable({ features: { examBlueprint: true }, contexts: ['bank', 'study'] }, 'examprep'), false, 'it also needs the materials and the generation components');
  assert.equal(m.pageAvailable(snapshot({ on: false }), 'sources'), true, 'every other page is unchanged');
  assert.equal(m.pageAvailable({}, 'generate'), true);
});

test('备考补习 is a sidebar page of the now-and-then group, titled and labelled 备考补习, and a learner\'s saved order keeps its sequence', () => {
  assert.equal(m.PAGES.examprep.label, '备考补习');
  assert.equal(m.PAGES.examprep.title, '备考补习');
  assert.equal(m.PAGES.examprep.group, 'periodic');
  assert.ok(m.NAV_DEFAULTS.periodic.includes('examprep'));
  assert.deepEqual(m.pagesInGroup('periodic'), m.NAV_DEFAULTS.periodic);
  const merged = m.mergeOrder({ periodic: ['dashboard', 'exam'] }, m.NAV_DEFAULTS).periodic;
  assert.deepEqual(merged.slice(0, 2), ['dashboard', 'exam']);
  assert.ok(merged.includes('examprep'));
  for (const word of [m.PAGES.examprep.label, m.PAGES.examprep.title]) assert.doesNotMatch(word, /蓝图|blueprint/i);
});

/* ---------- tiers, counts, the tree ---------- */

test('a point is 必学 when a chosen sample paper tests it and 补充 when only the slides teach it; a recorded tier wins, a missing one is derived', () => {
  const [source] = [pointList()];
  const byId = Object.fromEntries(source.blueprint.points.map(point => [point.id, point]));
  assert.equal(m.tierOf(byId.p2), 'must', 'a sample paper is among its places');
  assert.equal(m.tierOf(byId.p3), 'extra', 'slides only');
  assert.equal(m.tierOf({ ...byId.p3, tier: 'must' }), 'must', 'the tier the build wrote is used as it is');
  assert.equal(m.tierOf({ ...byId.p2, tier: 'extra' }), 'extra');
  assert.equal(m.tierOf({ ...byId.p2, tier: 'whatever' }), 'must', 'an unknown tier is derived like a missing one');
  const { backing, ...bare } = byId.p2;
  assert.equal(m.tierOf(bare), 'must', 'without a backing the places are counted');
  assert.equal(m.tierOf({ id: 'x', title: 'x', evidence: [] }), 'extra');
  // the tier the build writes and the one derived from the backing agree
  const derived = source.blueprint.points.map(({ tier, ...rest }) => m.tierOf(rest));
  assert.deepEqual(derived, source.blueprint.points.map(point => point.tier));
});

test('points are a two-level tree by parentId: big points hold small ones, a stray parent makes a root, a loop does not hang', () => {
  const { blueprint } = pointList();
  const tree = m.buildTree(blueprint.points);
  assert.deepEqual(tree.roots.map(node => node.id), ['p1', 'p4', 'p5']);
  assert.deepEqual(tree.roots[0].children.map(node => node.id), ['p2', 'p3']);
  assert.deepEqual(tree.roots[0].children.map(node => node.tier), ['must', 'extra']);
  assert.equal(tree.roots[0].depth, 1);
  assert.equal(tree.roots[0].children[0].depth, 2);
  const stray = m.buildTree([{ id: 'a', title: 'A', parentId: 'gone', evidence: [] }, { id: 'b', title: 'B', parentId: 'c', evidence: [] }, { id: 'c', title: 'C', parentId: 'b', evidence: [] }]);
  assert.deepEqual(stray.roots.map(node => [node.id, node.children.map(child => child.id)]), [['a', []], ['c', ['b']]], 'every point is shown once, whatever the data says: a loop is cut where it closes');
  const deep = m.buildTree([{ id: 'a', title: 'A', evidence: [] }, { id: 'b', title: 'B', parentId: 'a', evidence: [] }, { id: 'c', title: 'C', parentId: 'b', evidence: [] }]);
  assert.deepEqual(deep.roots.map(node => [node.id, node.children.map(child => child.id)]), [['a', ['b', 'c']]], 'a third level is kept under its big point');
  assert.deepEqual(m.buildTree(undefined).roots, []);
});

test('the counts are of the points a learner studies: a big point with small ones is a heading, not a count of its own', () => {
  const tree = m.buildTree(pointList().blueprint.points);
  assert.deepEqual(m.countPoints(tree), { must: 2, extra: 2, total: 4, withoutSlides: 0 });
  const orphan = m.buildTree([{ id: 'q', title: 'Q', tier: 'must', backing: { slides: 0, samplePapers: 1, kind: 'sample-paper' }, evidence: [{ sourceId: 'paper-1', role: 'past-paper', quote: 'q' }] }]);
  assert.deepEqual(m.countPoints(orphan), { must: 1, extra: 0, total: 1, withoutSlides: 1 });
  assert.equal(m.lacksSlides(orphan.roots[0].point), true);
  assert.equal(m.lacksSlides(pointList().blueprint.points[1]), false);
  assert.equal(m.lacksSlides({ id: 'z', title: 'z', evidence: [{ role: 'past-paper', sourceId: 'p', quote: 'q' }] }), true, 'no backing: the places are counted');
  const [heading, small] = pointList().blueprint.points;
  assert.equal(heading.noSlidePlace, false, 'the build writes the flag');
  assert.equal(m.lacksSlides({ ...small, noSlidePlace: true }), true, 'the flag the build wrote wins over the backing');
  assert.equal(m.lacksSlides({ ...orphan.roots[0].point, noSlidePlace: false }), false);
  assert.equal(pointList({ orphan: true }).blueprint.points.find(point => point.id === 'p6').noSlidePlace, true);
});

test('filters: 全部 / 必学 / 补充 and a text search over titles, requirements and the quotes; a big point stays when a small one matches', () => {
  const tree = m.buildTree(pointList().blueprint.points);
  const ids = nodes => nodes.flatMap(node => [node.id, ...node.children.map(child => child.id)]);
  assert.deepEqual(ids(m.filterTree(tree, {})), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(ids(m.filterTree(tree, { tier: 'all', query: '  ' })), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(ids(m.filterTree(tree, { tier: 'must' })), ['p1', 'p2', 'p4'], 'p1 stays as the heading of p2');
  assert.deepEqual(ids(m.filterTree(tree, { tier: 'extra' })), ['p1', 'p3', 'p5'], 'p1 is itself 补充 here');
  assert.deepEqual(ids(m.filterTree(tree, { query: '挥手' })), ['p1', 'p3']);
  assert.deepEqual(ids(m.filterTree(tree, { query: 'tcp' })), ['p1', 'p2', 'p3'], 'a big point that matches shows its small ones');
  assert.deepEqual(ids(m.filterTree(tree, { query: '窗口调节' })), ['p4'], 'the quotes are searched');
  assert.deepEqual(ids(m.filterTree(tree, { query: '没有这个词' })), []);
  assert.deepEqual(ids(m.filterTree(tree, { tier: 'must', query: '挥手' })), [], 'both filters apply');
  assert.equal(tree.roots.length, 3, 'filtering does not change the tree');
});

test('the rows a keyboard walks: closed big points hide their small ones, and arrows/Home/End/Enter move and open as an ARIA tree does', () => {
  const tree = m.buildTree(pointList().blueprint.points);
  const rows = m.treeRows(tree.roots, new Set());
  assert.deepEqual(rows.map(row => [row.id, row.level, row.hasChildren, row.expanded]), [['p1', 1, true, false], ['p4', 1, false, undefined], ['p5', 1, false, undefined]]);
  const open = m.treeRows(tree.roots, new Set(['p1']));
  assert.deepEqual(open.map(row => row.id), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(open.map(row => [row.posinset, row.setsize]), [[1, 3], [1, 2], [2, 2], [2, 3], [3, 3]]);
  const key = (current, name, opened = new Set(['p1'])) => m.treeKey(m.treeRows(tree.roots, opened), current, name, opened);
  assert.deepEqual(key('p1', 'ArrowDown'), { focus: 'p2' });
  assert.deepEqual(key('p3', 'ArrowDown'), { focus: 'p4' });
  assert.deepEqual(key('p5', 'ArrowDown'), { focus: 'p5' }, 'the last row stays');
  assert.deepEqual(key('p2', 'ArrowUp'), { focus: 'p1' });
  assert.deepEqual(key('p1', 'ArrowRight'), { focus: 'p2' }, 'an open big point: right goes in');
  assert.deepEqual(key('p1', 'ArrowRight', new Set()), { toggle: 'p1', open: true }, 'a closed one opens');
  assert.deepEqual(key('p1', 'ArrowLeft'), { toggle: 'p1', open: false }, 'an open one closes');
  assert.deepEqual(key('p3', 'ArrowLeft'), { focus: 'p1' }, 'a small point: left goes to its big point');
  assert.deepEqual(key('p4', 'ArrowLeft'), {}, 'a root leaf has nowhere to go');
  assert.deepEqual(key('p3', 'Home'), { focus: 'p1' });
  assert.deepEqual(key('p3', 'End'), { focus: 'p5' });
  assert.deepEqual(key('p1', 'Enter'), { toggle: 'p1', open: false });
  assert.deepEqual(key('p4', 'Enter'), { toggle: 'p4', open: true }, 'a leaf opens its quotes');
  assert.deepEqual(key('p4', ' '), { toggle: 'p4', open: true });
  assert.deepEqual(key('p4', 'x'), null, 'any other key is not ours');
});

test('a long list (300 points) is turned into a tree, filtered and flattened in a blink', () => {
  const { blueprint } = pointList({ many: 295 });
  assert.equal(blueprint.points.length, 300);
  const started = performance.now();
  const tree = m.buildTree(blueprint.points);
  const counts = m.countPoints(tree);
  const shown = m.filterTree(tree, { tier: 'extra', query: '补充考点 2' });
  const rows = m.treeRows(tree.roots, new Set(tree.roots.map(node => node.id)));
  assert.ok(performance.now() - started < 200, 'well under a frame budget on a loaded machine');
  assert.equal(counts.total + tree.roots.filter(node => node.children.length).length, 300, 'every point is a leaf or a heading');
  assert.ok(shown.length > 0);
  assert.equal(rows.length, 300);
});

/* ---------- the lists of a course ---------- */

test('the lists of the page are the point lists of the current course: another course\'s list is not shown, the same course\'s is; archived and older versions are not', () => {
  const mine = pointList({ title: '网络 · 传输层 考点清单', courses: ['网络'] });
  const other = pointList({ title: '数据库 · 考点清单', courses: ['数据库'] });
  const loose = pointList({ title: '没分课程', courses: [] });
  const data = snapshot({ lists: [mine, other, loose] });
  const known = ['网络', '数据库'];
  const titles = scope => m.pointLists(data, { scope, known }).map(row => row.title);
  assert.deepEqual(titles('网络'), ['网络 · 传输层 考点清单']);
  assert.deepEqual(titles('数据库'), ['数据库 · 考点清单']);
  assert.deepEqual(titles('*').sort(), ['数据库 · 考点清单', '没分课程', '网络 · 传输层 考点清单'].sort());
  assert.deepEqual(titles(''), ['没分课程'], 'uncategorised');
  assert.deepEqual(m.pointLists(data, { scope: '网络', known }).map(row => row.id), [mine.id]);
  // a parent course takes in its sub-courses, like every other page
  const nested = snapshot({ lists: [pointList({ courses: ['网络/传输层'] })], courses: ['网络', '网络/传输层'] });
  assert.equal(m.pointLists(nested, { scope: '网络', known: ['网络', '网络/传输层'] }).length, 1);
  // ordinary materials are not point lists, archived and historical records are not shown
  assert.equal(m.pointLists(snapshot({ lists: [] }), { scope: '*', known }).length, 0);
  assert.equal(m.pointLists({ ...snapshot({ lists: [] }), sources: [mine] }, { scope: '*', known }).length, 0, 'the lists are the snapshot examPointLists, not whatever the sources hold');
  assert.equal(m.pointLists({}, {}).length, 0);
  assert.equal(m.pointLists(snapshot({ lists: [{ ...mine, archived: true }, { ...other, archived: true }] }), { scope: '*', known }).length, 0);
  assert.equal(m.isPointList(mine), true);
  assert.equal(m.isPointList(library()[0]), false);
  assert.equal(m.isPointList({ provenance: 'exam-blueprint' }), false, 'a record without the structured list is an ordinary material');
});

test('a new version replaces the old one: the build archives the old list, so the page shows the newest with a count of the versions behind it, and the older ones as history', () => {
  const first = pointList({ title: '传输层 考点清单', createdAt: '2026-10-01T08:00:00.000Z' });
  const second = pointList({ title: '传输层 考点清单', createdAt: '2026-10-05T08:00:00.000Z', supersedes: first.id, papers: 2 });
  const withArchived = (lists, ...archived) => { const data = snapshot({ lists }); data.examPointLists = data.examPointLists.map(summary => ({ ...summary, archived: archived.includes(summary.id) })); return data; };
  assert.equal(examPointListSummary(second).supersedes, first.id, 'the summary carries the link');
  assert.equal(examPointListSummary(first).supersedes, null);
  const data = withArchived([first, second], first.id);
  const rows = m.pointLists(data, { scope: '*', known: ['网络'] });
  assert.deepEqual(rows.map(row => row.id), [second.id]);
  assert.equal(rows[0].olderVersions, 1);
  const history = m.pointLists(data, { scope: '*', known: ['网络'], history: true });
  assert.deepEqual(history.map(row => [row.id, row.archived]), [[first.id, true]]);
  assert.deepEqual(m.pointLists(data, { scope: '数据库', known: ['网络', '数据库'], history: true }), [], 'history follows the course scope');
  // a restored older version is shown beside the newer one
  assert.deepEqual(m.pointLists(withArchived([first, second]), { scope: '*', known: ['网络'] }).map(row => row.id).sort(), [first.id, second.id].sort());
  const newest = pointList({ title: 'B', createdAt: '2026-10-09T00:00:00.000Z' });
  assert.deepEqual(m.pointLists(snapshot({ lists: [first, newest] }), { scope: '*', known: ['网络'] }).map(row => row.title), ['B', '传输层 考点清单'], 'newest first');
});

test('a row says what a learner needs to pick a list: title, scope, how many papers it rests on, the counts, when, and what is building', () => {
  const source = pointList();
  const done = buildJob({ id: 'blueprint-done', status: 'complete', refs: [{ kind: 'exam-point-list', id: source.id }], finishedAt: '2026-10-02T00:00:00.000Z' });
  const summary = examPointListSummary(source);
  const row = m.listRow(summary, { jobs: [done] });
  assert.deepEqual([row.title, row.scope, row.papers, row.counts, row.course], ['网络 · 传输层 考点清单', '传输层', 1, { must: 2, extra: 2, total: 4, withoutSlides: 0 }, '网络']);
  assert.equal(row.updatedAt, STAMP, 'the record\'s own time');
  assert.equal(row.archived, false);
  assert.equal(m.listRow({ ...summary, createdAt: null }, { jobs: [done] }).updatedAt, null, 'the time is the record\'s own (the job\'s time is not borrowed: it is gone after a restart)');
  const running = buildJob({ id: 'blueprint-2', status: 'running', done: 2, total: 5, targetId: source.id, supersedes: source.id });
  const withBuild = m.listRow(summary, { jobs: [running] });
  assert.deepEqual([withBuild.build.jobId, withBuild.build.live, withBuild.build.done, withBuild.build.total], ['blueprint-2', true, 2, 5]);
  assert.equal(m.listRow(summary, { jobs: [buildJob({ targetId: 'another-list' })] }).build, null, 'a build of another list is not this list\'s');
  assert.equal(m.listRow(summary, { jobs: [buildJob()] }).build, null, 'a first build has no list yet: the same title is not enough');
  assert.equal(m.listRow(summary, { jobs: [buildJob({ status: 'complete', targetId: source.id })] }).build, null, 'a build that has ended is not a state of the row');
});

test('a row is stale only when the snapshot says so: no flag, no warning', () => {
  const summary = examPointListSummary(pointList());
  assert.equal(m.listRow(summary).stale, false, 'a list saved before this release has no flag');
  assert.equal(m.listRow({ ...summary, stale: true }).stale, true);
  assert.equal(m.listRow({ ...summary, stale: 'yes' }).stale, false, 'only a literal true');
});

test('the builds are the build jobs of the snapshot, running ones first, with the id the 任务 console knows them by', () => {
  const data = snapshot({ jobs: [buildJob({ id: 'a', status: 'complete', finishedAt: '2026-10-02T00:00:00.000Z' }), buildJob({ id: 'b', status: 'running' }), { id: 'x', type: 'generation', status: 'running' }] });
  const builds = m.buildsOf(data);
  assert.deepEqual(builds.map(build => [build.jobId, build.live]), [['b', true], ['a', false]]);
  assert.equal(builds[0].taskId, 'b');
  assert.deepEqual(m.buildsOf(snapshot({ jobs: [buildJob({ targetId: 'x', supersedes: 'y' })] }))[0].targetId, 'x');
  assert.equal(builds[0].targetId, null, 'a first build: null until its list is saved');
  assert.equal(builds[0].title, '网络 · 传输层 考点清单');
  assert.deepEqual(m.buildsOf({}), []);
  assert.equal(m.buildsOf(snapshot({ jobs: [buildJob({ status: 'failed' })] }))[0].failed, true);
});

test('a build carries the course it was asked for (detail.course), null when the job does not say, and its result lists as exam-point-list refs', () => {
  const [mineBuild] = m.buildsOf(snapshot({ jobs: [buildJob({ course: '网络' })] }));
  assert.equal(mineBuild.course, '网络');
  assert.equal(m.buildsOf(snapshot({ jobs: [buildJob({ course: null })] }))[0].course, null);
  const done = buildJob({ status: 'complete', refs: [{ kind: 'exam-point-list', id: 'list-1' }], finishedAt: '2026-10-02T00:00:00.000Z' });
  assert.deepEqual(m.buildsOf(snapshot({ jobs: [done] }))[0].resultIds, ['list-1']);
});

test('builds of the page: the rule of the lists, so a build is never out of sight: named courses by course, a build with no course under all courses and uncategorised', () => {
  const known = ['网络', '数据库'];
  const builds = m.buildsOf(snapshot({ jobs: [buildJob({ id: 'net', course: '网络' }), buildJob({ id: 'db', course: '数据库' }), buildJob({ id: 'none', course: null }),
    buildJob({ id: 'sub', course: '网络/传输层' })] }));
  const ids = scope => m.buildsInScope(builds, scope, known).map(build => build.jobId).sort();
  assert.deepEqual(ids('网络'), ['net', 'sub'].sort(), 'the course and its sub-courses, like the rows of the page');
  assert.deepEqual(ids('数据库'), ['db']);
  assert.deepEqual(ids('*'), ['db', 'net', 'none', 'sub'], 'every build, the one with no course too');
  assert.deepEqual(ids(''), ['none'], 'uncategorised: the list a build with no course makes is uncategorised');
});

/* ---------- what is under a point ---------- */

test('the places of a point: slides and sample-paper questions apart, each with its page, quote and where to open it', () => {
  const [, p2] = pointList().blueprint.points;
  const places = m.placesOf(p2);
  assert.deepEqual(places.map(place => [place.kind, place.sourceId, place.page ?? null]), [['slide', '传输层-1', 1], ['paper', 'paper-1', null]]);
  assert.equal(places[0].quote, '三次握手建立连接');
  assert.equal(m.placesOf({ evidence: [{ role: 'syllabus', sourceId: 's', quote: 'q' }, { role: 'textbook', sourceId: 't', quote: 'q' }] }).length, 1, 'a textbook is never evidence; the syllabus counts as the slides do');
  assert.deepEqual(m.placesOf({}), []);
});

test('what is left over: sample-paper questions with no point, and slides with no readable text', () => {
  const { blueprint } = pointList();
  assert.deepEqual(m.unmatchedQuestions(blueprint), ['Q3']);
  assert.deepEqual(m.skippedPages(blueprint), [{ title: '传输层.pptx', pages: [5] }]);
  assert.deepEqual(m.unmatchedQuestions(pointList({ papers: 0 }).blueprint), []);
  assert.deepEqual(m.skippedPages(pointList({ papers: 0 }).blueprint).length, 1);
  assert.deepEqual(m.unmatchedQuestions({ examShape: { questions: [{ label: 'Q1', pointIds: [] }, { label: 'Q2', pointIds: ['p1'] }] } }), ['Q1'], 'else the questions that reach no point');
  assert.deepEqual(m.skippedPages({ inputs: [{ role: 'past-paper', title: 'x', skippedPages: [2] }] }), [], 'only slides count');
});

/* ---------- the words ---------- */

test('the basis line says how many sample papers the list rests on and what that cannot tell, in the data\'s own words and in English', () => {
  const basis = papers => m.basisLine(pointList({ papers }).blueprint.basis);
  assert.equal(basis(1), '依据 1 份样卷；样卷考过的范围可能不全');
  assert.equal(basis(2), '依据 2 份样卷（取并集）；样卷考过的范围可能不全');
  assert.match(basis(3), /^依据 3 份样卷（取并集）；/);
  assert.equal(basis(0), '没有样卷，无法判断哪些考点样卷考过');
  assert.doesNotMatch([0, 1, 2, 3].map(basis).join(''), /蓝图|blueprint|必学/i);
  english(() => {
    assert.equal(basis(1), 'Based on 1 sample paper; the range tested in sample papers may be incomplete');
    assert.equal(basis(2), 'Based on 2 sample papers (united); the range tested in sample papers may be incomplete');
    assert.match(basis(0), /^No sample paper/);
    assert.doesNotMatch([0, 1, 2, 3].map(basis).join(''), han);
  });
  assert.equal(m.basisLine({}), '', 'a record without a basis says nothing it does not know');
  assert.equal(m.basisLine(null), '');
});

test('the counts line and the backing line use the owner\'s words', () => {
  assert.equal(m.countsLine({ must: 12, extra: 30 }), '样卷考过 12 · 补充 30');
  assert.equal(english(() => m.countsLine({ must: 12, extra: 30 })), 'Tested in sample papers 12 · Extra 30');
  const [p1, p2, p3] = pointList().blueprint.points;
  assert.equal(m.backingLine(p2), '出现在 1 页课件 + 1 份样卷');
  assert.equal(m.backingLine(p3), '出现在 1 页课件');
  assert.equal(m.backingLine({ ...p1, backing: { slides: 2, samplePapers: 1, kind: 'both' } }), '出现在 2 页课件 + 1 份样卷');
  assert.equal(m.backingLine({ id: 'q', title: 'q', backing: { slides: 0, samplePapers: 1, kind: 'sample-paper' }, evidence: [] }), '只出现在 1 份样卷');
  english(() => {
    assert.equal(m.backingLine(p2), 'In 1 slide + 1 sample paper');
    assert.equal(m.backingLine({ ...p1, backing: { slides: 2, samplePapers: 2, kind: 'both' } }), 'In 2 slides + 2 sample papers');
    assert.equal(m.backingLine({ id: 'q', title: 'q', backing: { slides: 0, samplePapers: 1, kind: 'sample-paper' }, evidence: [] }), 'Only in 1 sample paper');
  });
  assert.equal(m.tierName('must'), TIER_LABEL.must, 'the library\'s own word, not a second one');
  assert.equal(m.tierName('must'), '样卷考过');
  assert.equal(m.tierName('extra'), TIER_LABEL.extra);
  assert.equal(english(() => m.tierName('must')), 'Tested in sample papers');
  assert.equal(english(() => m.tierName('extra')), 'Extra');
});

test('a point tested by a sample paper says in how many of the papers; any other point says 补充; the word 必学 is nowhere', () => {
  const [, p2, p3] = pointList({ papers: 2 }).blueprint.points;
  const basis = { samplePapers: 2 };
  assert.equal(m.tierWords('must', { ...p2, backing: { slides: 1, samplePapers: 1 } }, basis), '样卷考过（1/2 份）');
  assert.equal(m.tierWords('must', { ...p2, backing: { slides: 1, samplePapers: 2 } }, basis), '样卷考过（2/2 份）');
  assert.equal(m.tierWords('must', { ...p2, backing: undefined }, basis), '样卷考过（1/2 份）', 'a record without backing is counted from its places');
  assert.equal(m.tierWords('extra', p3, basis), '补充');
  assert.equal(m.tierWords('must', p2, null), '样卷考过', 'no basis: the word alone, no invented total');
  assert.equal(english(() => m.tierWords('must', { ...p2, backing: { slides: 1, samplePapers: 1 } }, basis)), 'Tested in sample papers (1/2 papers)');
  assert.equal(english(() => m.tierWords('extra', p3, basis)), 'Extra');
  for (const words of [m.tierWords('must', p2, basis), m.countsLine({ must: 1, extra: 2 }), ...Object.keys(m.EXPLAIN).flatMap(key => m.explain(key))]) assert.doesNotMatch(words, /必学/);
});

test('every hover explanation is one plain sentence and at most one consequence line, in both languages, and none says 蓝图', () => {
  const keys = Object.keys(m.EXPLAIN);
  for (const key of ['tier.must', 'tier.extra', 'basis', 'peek', 'noSlides', 'regenerate', 'estimate', 'roles', 'role.textbook', 'delete', 'restore', 'unmatched', 'skipped', 'reading'])
    assert.ok(keys.includes(key), `${key} has an explanation`);
  for (const key of keys) {
    const [sentence, consequence, extra] = m.explain(key);
    assert.ok(sentence && sentence.length > 5, key);
    assert.equal(extra, undefined, `${key}: at most two lines`);
    assert.doesNotMatch(`${sentence}${consequence || ''}`, /蓝图|blueprint/i, key);
    english(() => {
      const [s, c] = m.explain(key);
      assert.doesNotMatch(`${s}${c || ''}`, han, `${key}: English`);
      assert.ok(s.length > 5);
      assert.equal(Boolean(c), Boolean(consequence), `${key}: the consequence line exists in both languages or in neither`);
    });
  }
  assert.match(m.explain('tier.must').join(''), /样卷/);
  assert.match(m.explain('tier.extra').join(''), /课件/);
  assert.match(m.explain('regenerate').join(''), /额度|Token|token/);
  assert.equal(m.explain('generate'), null, 'the action that was never built has no explanation left');
  assert.equal(m.explain('no-such-key'), null);
});

test('a refusal of the build is shown as the operation worded it; with no message, in plain words by its code, in both languages', () => {
  const codes = ['blueprint-needs-primary-input', 'blueprint-no-readable-text', 'blueprint-input-missing', 'blueprint-title-required', 'blueprint-input-invalid', 'blueprint-disabled', 'capability-unverified', 'executor-unavailable', 'scope-unloaded'];
  for (const refusal of codes) {
    assert.equal(m.refusalWords({ code: refusal, message: '请选择课件' }), '请选择课件', 'the operation answers in the learner language: shown as given');
    const zh = m.refusalWords({ code: refusal });
    assert.ok(han.test(zh), refusal);
    assert.doesNotMatch(zh, /蓝图/);
    english(() => { const en = m.refusalWords({ code: refusal }); assert.ok(en.length > 10 && !han.test(en), refusal); });
  }
  assert.match(m.refusalWords({ code: 'blueprint-needs-primary-input' }), /课件/);
  assert.match(m.refusalWords({ code: 'blueprint-no-readable-text' }), /文字/);
  assert.equal(m.refusalWords({ code: 'something-new', message: '服务暂时不可用' }), '服务暂时不可用');
  assert.ok(m.refusalWords(new Error('')).length > 5);
  assert.ok(m.refusalWords(null).length > 5);
});

/* ---------- the create form ---------- */

test('the inputs of a build are chosen by role from the library: slides required, papers optional', () => {
  const sources = library();
  const lecture = ['传输层-1', '传输层-2', '传输层-3', '传输层-4', '传输层-6'];
  const request = m.buildRequest({ title: ' 网络 · 传输层 考点清单 ', scope: '传输层', course: '网络', picks: { lecture, 'past-paper': ['paper-1'], syllabus: [] },
    reading: { title: '计算机网络', author: 'Kurose', url: 'https://example.com/book', note: '老师推荐' } }, sources, { language: 'zh' });
  assert.equal(request.title, '网络 · 传输层 考点清单');
  assert.equal(request.course, '网络');
  assert.deepEqual(request.scope, { label: '传输层' });
  assert.equal(request.language, 'zh');
  assert.deepEqual(request.inputs.map(input => [input.role, input.sourceIds.length]), [['lecture', 5], ['past-paper', 1]]);
  assert.equal(request.inputs[0].documentId, '传输层');
  assert.equal(request.inputs[0].title, '传输层.pptx');
  assert.deepEqual(request.recommendedReading, { title: '计算机网络', author: 'Kurose', url: 'https://example.com/book', note: '老师推荐' });
  assert.equal(request.estimate, undefined);
  const bare = m.buildRequest({ title: 'T', course: '', picks: { lecture: ['传输层-1'] }, reading: { title: '  ' } }, sources, { language: 'en' });
  assert.equal(bare.recommendedReading, undefined, 'a note without a title is no note');
  assert.equal(bare.scope, undefined);
  assert.equal(bare.language, 'en');
  assert.deepEqual(bare.inputs[0].sourceIds, ['传输层-1']);
  assert.equal(bare.inputs[0].documentId, undefined, 'part of a deck: only the pages chosen');
  assert.equal(m.buildRequest({ title: 'T', picks: { lecture: ['传输层-1'] }, supersedes: 'old-id' }, sources, {}).supersedes, 'old-id');
});

test('the form is ready when it has slides or a syllabus, and says what is missing; the name is never missing', () => {
  assert.deepEqual(m.formProblems({ picks: { lecture: [] } }), ['lecture']);
  assert.deepEqual(m.formProblems({ title: '', picks: { lecture: ['a'] } }), [], 'no name: the request carries a default');
  assert.deepEqual(m.formProblems({ picks: { lecture: [], syllabus: ['s'] } }), [], 'a syllabus stands in for slides');
  assert.deepEqual(m.formProblems({ picks: { lecture: ['a'] }, reading: { title: '', url: 'ftp://x' } }), ['reading-url']);
  const nothing = { inputs: [{ role: 'past-paper', sourceIds: ['p'] }] }, slides = { inputs: [{ role: 'lecture', sourceIds: ['a'] }] };
  assert.deepEqual(m.formProblems({ picks: { lecture: ['gone'] } }, nothing), ['lecture'], 'the request is what counts: a pick the library no longer holds is no slides');
  assert.deepEqual(m.formProblems({ picks: { lecture: [] } }, slides), []);
});

test('a list is opened for a new version with the inputs it was built from', () => {
  const source = pointList({ papers: 2 });
  const form = m.formFromList(m.listRow(examPointListSummary(source)), source.blueprint);
  assert.equal(form.title, source.title);
  assert.equal(form.supersedes, source.id);
  assert.equal(form.course, '网络');
  assert.equal(form.scope, '传输层');
  assert.deepEqual(form.picks.lecture, ['传输层-1', '传输层-2', '传输层-3', '传输层-4']);
  assert.deepEqual(form.picks['past-paper'], ['paper-1', 'paper-2']);
  assert.deepEqual(form.reading, { title: '计算机网络：自顶向下方法', author: 'Kurose', url: '', note: '老师推荐，未导入' });
});
