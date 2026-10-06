import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

// UI wave 2 · WP-H: StudyMap split into its parts (#130) with real menus (#79), named fold buttons (#146),
// a JobRow for generation jobs (#98) and an InlineMessage for the notebook read error (#88).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as StudyMap } from './ui/StudyMap.jsx';
  export * from './ui/study-map/map-model.js';
  export { default as CourseHeading } from './ui/study-map/CourseHeading.jsx';
  export { default as RoleSuggestion } from './ui/study-map/RoleSuggestion.jsx';
  export { default as MergeSuggestions, useMergeSuggestions } from './ui/study-map/MergeSuggestions.jsx';
  export { default as DeckTree } from './ui/study-map/DeckTree.jsx';
  export { default as HomeActivity } from './ui/study-map/HomeActivity.jsx';
  export { default as JobCard } from './ui/study-map/JobCard.jsx';
  export { default as NotebookDirectory } from './ui/study-map/NotebookDirectory.jsx';
  export { default as CatalogHeading } from './ui/study-map/CatalogHeading.jsx';
  export { useDeckTree } from './ui/study-map/useDeckTree.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const noop = () => {};
const html = (type, props = {}) => renderToStaticMarkup(h(type, props));

const deck = { id: 'd1', title: '行为型模式', folder: 'CS3219', course: 'CS3219', topics: ['Memento'], available: 5, count: 5, quizCount: 3, createdAt: '2026-09-01T00:00:00Z' };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: 'active',
  topics: [{ name: 'Memento', total: 5, due: 1, mastery: 60, status: 'active', counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 } }] } };
const baseData = (patch = {}) => ({ root: '/tmp/lib', decks: [deck], progress, sources: [{ id: 's' }], drafts: [], jobs: [], runs: [],
  today: { due: 1, weak: 2, new: 0, size: 3 }, focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] }, ...patch });
const props = (data) => ({ data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop, retryGeneration: noop,
  addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [], onFocus: noop, cancelJob: noop, dismissJob: noop });
const page = (data, extra = {}) => html(m.StudyMap, { ...props(data), ...extra });

test('StudyMap.jsx is a small composition: at most 400 lines and 6 useState (#130)', () => {
  const source = read('ui/StudyMap.jsx');
  assert.ok(source.split('\n').length <= 400, `${source.split('\n').length} lines`);
  assert.ok((source.match(/\buseState\(/g) || []).length <= 6);
  for (const file of ['useDeckTree.js', 'CourseHeading.jsx', 'RoleSuggestion.jsx', 'MergeSuggestions.jsx', 'DeckTree.jsx', 'HomeActivity.jsx', 'NotebookDirectory.jsx', 'JobCard.jsx'])
    assert.ok(readdirSync(new URL('../ui/study-map/', import.meta.url)).includes(file), file);
});

test('the deck tree keeps folds and selection as pure transitions', () => {
  const folds = m.toggleInSet(new Set(['a']), 'b');
  assert.deepEqual([...folds], ['a', 'b']);
  assert.deepEqual([...m.toggleInSet(folds, 'a')], ['b']);
  const deckKey = m.topicKey('d1'), topicKey = m.topicKey('d1', 'Memento'), other = m.topicKey('d2', 'X');
  const picked = m.applySelection(new Set([topicKey, other]), [deckKey], true);
  assert.deepEqual([...picked].sort(), [deckKey, other].sort(), 'a whole deck supersedes its topics');
  assert.deepEqual([...m.applySelection(picked, [deckKey], false)], [other]);
  assert.deepEqual(m.scopeOf(picked).sort((a, b) => a.deckId.localeCompare(b.deckId)), [{ deckId: 'd1' }, { deckId: 'd2', topic: 'X' }]);
  assert.deepEqual([...m.defaultExpanded([deck])].sort(), ['d1', 'folder:CS3219']);
  assert.deepEqual([...m.defaultExpanded([1, 2, 3, 4].map((n) => ({ id: `d${n}`, folder: 'F' })))], ['folder:F']);
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  m.writeExpanded('/lib', new Set(['x']), storage);
  assert.deepEqual([...m.readExpanded('/lib', storage)], ['x']);
  assert.equal(m.readExpanded('/other', storage), null);
  assert.equal(m.readExpanded('/lib', { getItem() { throw new Error('blocked'); } }), null);
});

test('useDeckTree starts from the remembered folds, else every course open', () => {
  function Probe({ root, decks }) {
    const tree = m.useDeckTree(root, decks);
    return h('p', null, `${[...tree.expanded].sort().join('|')}#${tree.scope.length}`);
  }
  assert.match(renderToStaticMarkup(h(Probe, { root: '/lib', decks: [deck] })), /d1\|folder:CS3219#0/);
});

test('every fold button on the home has a name that says what it opens (#146)', () => {
  m.setUiLanguage('zh');
  const out = page(baseData());
  assert.doesNotMatch(out, /[▾▸▤]/, 'no glyph carets or folder glyphs');
  assert.doesNotMatch(out, /map-caret|course-caret/);
  const folds = [...out.matchAll(/(<button[^>]*aria-expanded[^>]*>)([^]*?)<\/button>/g)].filter((hit) => !hit[2].replace(/<[^>]*>/g, '').trim());
  assert.ok(folds.length >= 2, 'icon-only fold buttons exist');
  for (const [, tag] of folds) assert.match(tag, /aria-label="[^"]{2,}"/, tag);
  assert.match(out, /aria-label="收起 CS3219"/);
  assert.match(out, /aria-label="收起 行为型模式"/);
  m.setUiLanguage('en');
  assert.match(page(baseData()), /aria-label="Collapse CS3219"/);
  m.setUiLanguage('zh');
});

test('the deck ⋯ and the 整理与添加 menus are the shared Menu (#79)', () => {
  m.setUiLanguage('zh');
  const out = page(baseData());
  assert.doesNotMatch(out, /map-menu-toggle|class="map-menu"/);
  assert.match(out, /<button[^>]*aria-haspopup="menu"[^>]*aria-label="更多操作"|<button[^>]*aria-label="更多操作"[^>]*aria-haspopup="menu"/);
  assert.match(out, /<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*>整理与添加<\/button>/);
  const source = read('ui/StudyMap.jsx') + read('ui/study-map/DeckTree.jsx') + read('ui/study-map/DeckRow.jsx') + read('ui/study-map/CatalogHeading.jsx');
  assert.match(source, /<Menu/);
  assert.doesNotMatch(source, /pointerdown/);
});

test('the catalog heading offers the housekeeping menu and shows a busy trigger while it merges', () => {
  m.setUiLanguage('zh');
  const merge = { busy: false, error: '', suggestions: null, run() {}, close() {}, confirm() {} };
  assert.match(html(m.CatalogHeading, { count: 3, showArchived: false, hasDecks: true, hasSources: true, merge, busy: false, course: 'CS3219',
    addSource: noop, createManual: noop, importLibrary: noop, manage: noop, onShowGraph: noop }), />整理与添加</);
  assert.match(html(m.CatalogHeading, { count: 3, showArchived: false, hasDecks: true, hasSources: true, merge: { ...merge, busy: true }, busy: false, course: 'CS3219',
    addSource: noop, createManual: noop, importLibrary: noop, manage: noop, onShowGraph: noop }), />整理中…</);
});

test('merge suggestions render an error as an alert and each proposal with a confirm button', () => {
  m.setUiLanguage('zh');
  const suggestions = { course: 'CS3219', method: 'model', proposals: [{ targetId: 't', targetTitle: '主题 A', sourceIds: ['s'], sourceTitles: ['主题 B'], reason: '内容重叠', count: 12 }] };
  const out = html(m.MergeSuggestions, { merge: { busy: false, error: '读取失败', suggestions, close() {}, confirm() {} }, busy: false });
  assert.match(out, /<[^>]*role="alert"[^>]*>[^]*读取失败/);
  assert.match(out, /主题 B → 主题 A/);
  assert.match(out, /确认合并/);
  assert.match(out, /合并后共 12 题/);
  assert.equal(html(m.MergeSuggestions, { merge: { busy: false, error: '', suggestions: null }, busy: false }), '');
});

test('the course heading is a named course switcher, or the role input in interview mode', () => {
  m.setUiLanguage('zh');
  const data = baseData();
  const heading = html(m.CourseHeading, { data, headline: '今天', onFocus: noop, role: { draft: '', setDraft: noop } });
  assert.match(heading, /<h1[^>]*class="sh-page-header__title course-heading"/, "the course heading is the PageHeader title");
  assert.match(heading, /<select[^>]*aria-label="切换当前课程"/);
  assert.doesNotMatch(heading, /▾/);
  assert.match(heading, /data-combobox="heading"/, 'the switcher is the searchable Combobox with the heading as its trigger');
  assert.match(heading, /<span class="sh-combobox__heading-text">/, 'the heading text is the trigger content');
  const interview = html(m.CourseHeading, { data: baseData({ focus: { ...data.focus, mode: 'interview', role: '后端' } }), headline: '今天', onFocus: noop, role: { draft: '后端', setDraft: noop } });
  assert.match(interview, /<input[^>]*aria-label="岗位方向"[^>]*value="后端"/);
  assert.match(interview, /<h1[^>]*><input/, 'the role input is inside the h1: the page keeps its title in interview mode');
});

test('role suggestions keep their own state and speak an error as an alert', () => {
  m.setUiLanguage('zh');
  const data = baseData({ focus: { mode: 'interview', role: '后端', jd: '', courses: [], roleWeak: [{ deckId: 'd1', topic: 'Memento', weak: 2 }] } });
  const out = html(m.RoleSuggestion, { data, role: '后端', busy: false, suggestRole: noop, onFocus: noop, start: noop });
  assert.match(out, /用岗位描述细化练习范围/);
  assert.match(out, /AI 匹配知识点/);
  assert.match(out, /优先练这些薄弱点/);
  assert.match(out, /Memento · 2 道薄弱题/);
});

test('generation jobs render as compact cards with a real progress bar and one dismiss (#98)', () => {
  m.setUiLanguage('zh');
  const job = (id, status, extra = {}) => ({ id, status, type: 'generate', stage: '', parts: 1, trace: [], ...extra });
  const running = html(m.JobCard, { job: job('a', 'running', { requestedTotal: 10, savedCount: 4 }), jobs: [], drafts: [], busy: false, cancelJob: noop, dismissJob: noop });
  assert.match(running, /<article[^>]*class="cjc"[^>]*data-job-id="a"/);
  assert.match(running, /role="progressbar"[^>]*aria-valuenow="40"[^>]*|aria-valuemax="100"[^>]*aria-valuenow="40"/);
  assert.match(running, /停止/);
  assert.doesNotMatch(running, /知道了/, 'a running job cannot be dismissed');
  assert.doesNotMatch(running, /style="width:/, 'the fill moves with transform, never width');
  const failed = html(m.JobCard, { job: job('b', 'failed', { stage: 'rate limit exceeded' }), jobs: [], drafts: [], busy: false, dismissJob: noop });
  assert.match(failed, /data-state="fail"/);
  assert.match(failed, /知道了/);
  assert.match(failed, /role="alert"/);
  const done = html(m.JobCard, { job: job('c', 'complete'), jobs: [], drafts: [], busy: false, dismissJob: noop });
  assert.match(done, /data-state="done"/);
  assert.doesNotMatch(running + failed + done, /class="job /);
});

test('HomeActivity lists jobs and drafts, with a bulk dismiss only past one finished job', () => {
  m.setUiLanguage('zh');
  const job = (id, status) => ({ id, status, type: 'generate', stage: '', parts: 1, trace: [] });
  const base = { drafts: [], busy: false, openDraft: noop, openAgent: noop, cancelJob: noop, dismissJob: noop, retryGeneration: noop, manage: noop, start: noop,
    call: noop, continueDraft: noop, modelReady: true, data: baseData() };
  const one = html(m.HomeActivity, { ...base, jobs: [job('a', 'failed'), job('b', 'running')] });
  assert.match(one, /class="home-activity"|class="home-activity /);
  assert.doesNotMatch(one, /全部知道了/);
  const many = html(m.HomeActivity, { ...base, jobs: [job('a', 'failed'), job('b', 'partial'), job('c', 'complete')] });
  assert.match(many, /全部知道了/);
  assert.equal(html(m.HomeActivity, { ...base, jobs: [] }), '');
});

test('the notebook directory read error is an InlineMessage alert, not a status paragraph (#88)', () => {
  m.setUiLanguage('zh');
  const failed = html(m.NotebookDirectory, { notebooks: null, error: '连接超时', busy: false, refresh: noop });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /目录读取失败：连接超时/);
  assert.doesNotMatch(failed, /class="warning"/);
  const waiting = html(m.NotebookDirectory, { notebooks: null, error: '', busy: false, refresh: noop });
  assert.match(waiting, /role="status"/);
  assert.match(waiting, /正在读取全局笔记本目录/);
  const open = html(m.NotebookDirectory, { notebooks: { notebooks: [] }, error: '', busy: false, refresh: noop });
  assert.match(open, /<button[^>]*aria-expanded="true"[^>]*aria-label="收起 全局笔记本"|<button[^>]*aria-label="收起 全局笔记本"[^>]*aria-expanded="true"/);
  assert.doesNotMatch(open, /map-caret|[▾▸]/);
  const stale = html(m.NotebookDirectory, { notebooks: { notebooks: [] }, error: '连接超时', busy: false, refresh: noop });
  assert.match(stale, /role="alert"/);
  assert.match(stale, /目录读取失败，仍显示上次结果：连接超时/);
});

test('the study map no longer carries hand-built menus, glyph carets or raw warnings', () => {
  const parts = ['ui/StudyMap.jsx', ...readdirSync(new URL('../ui/study-map/', import.meta.url)).filter((name) => /\.jsx?$/.test(name)).map((name) => `ui/study-map/${name}`)];
  for (const file of parts) {
    const source = read(file);
    assert.doesNotMatch(source, /className="warning"|role="menu"|map-caret|course-caret/, file);
    assert.doesNotMatch(source, />\s*[▸▾▶⋯×]\s*</, `${file}: glyph text as an icon`);
    assert.doesNotMatch(source, /"[▸▾] "/, `${file}: glyph text prefix`);
  }
});
