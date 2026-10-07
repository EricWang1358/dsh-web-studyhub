import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 1 · WP-C: empty, error and loading states (#89 #102 #103) and the chips that became Badges (#95).
const read = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { StatsView } from './ui/Dashboard.jsx';
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { GraphStatus } from './ui/Graph.jsx';
  export { default as EmptyStudyActions } from './ui/EmptyStudyActions.jsx';
  export { default as StudyBoundary } from './ui/host/StudyBoundary.jsx';
  export { deferredView } from './ui/deferred-view.jsx';
  export { default as IndexBadge } from './ui/IndexBadge.jsx';
  export { JevDecidedBadge, JevCardBadge } from './ui/JevBadge.jsx';
    export { RubricSkills, CaseReport } from './ui/CaseResult.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const noop = () => {};
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const emoji = /[☀-➿\u{1f300}-\u{1faff}]/u;

const emptyStats = { generatedAt: '2026-10-02T04:00:00Z', today: '2026-10-02', totals: { attempts: 0, activeDays: 0, streak: 0, due: 0 },
  heatmap: [], trend: [], forecast: { days: [], later: 0 }, mastery: { windowDays: 30, minAnswers: 3, levels: [], kinds: [] }, weakTopics: [] };

test('EmptyStudyActions uses Button: one primary per state', () => {
  m.setUiLanguage('zh');
  const decks = [{ id: 'd', archived: false }];
  const study = html(m.EmptyStudyActions, { data: { decks }, onStart: noop });
  assert.match(study, /<button[^>]*sh-btn--primary[^>]*>开始学习<\/button>/);
  const create = html(m.EmptyStudyActions, { data: { decks: [] }, onCreate: noop, onSources: noop });
  assert.match(create, /sh-btn--primary[^>]*>创建题组</);
  assert.match(create, /sh-btn--secondary[^>]*>添加学习资料</);
  assert.equal((create.match(/sh-btn--primary/g) || []).length, 1);
  assert.match(html(m.EmptyStudyActions, { data: { decks: [], drafts: [{}] }, onLibrary: noop }), /sh-btn--primary[^>]*>查看待发布草稿</);
  assert.match(html(m.EmptyStudyActions, { data: { decks }, busy: true, onStart: noop }), /disabled=""/);
  assert.doesNotMatch(create, /class="primary"/);
});

test('the dashboard empty state is an EmptyState with an icon, not a dashed box with a glyph', () => {
  m.setUiLanguage('zh');
  const out = html(m.StatsView, { stats: emptyStats, course: '*', data: { decks: [], focus: {} }, busy: false, onStartScope: noop, onLibrary: noop, onCreate: noop, onSources: noop });
  assert.match(out, /sh-empty/);
  assert.match(out, /还没有作答记录/);
  assert.match(out, /sh-empty__icon[^>]*><svg/);
  assert.doesNotMatch(out, /class="empty|empty-icon|◔/);
  assert.match(out, /sh-btn--primary/, 'the actions sit inside the empty state');
});

test('the wrong book empty state and its errors use the shared components', () => {
  m.setUiLanguage('zh');
  const base = { data: { root: 'r', decks: [], attempts: [], focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop,
    items: [], counts: { total: 0, graded: 0, self: 0, oral: 0, rubric: 0 }, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
    onReload: noop, onPage: noop, recs: { items: [] }, coach: {}, details: {}, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop,
    onGenerate: async () => ({}), onOpenSettings: noop, busy: false };
  const empty = html(m.WrongBookView, base);
  assert.match(empty, /sh-empty/);
  assert.match(empty, /data-tour="wrongbook-list"/);
  assert.match(empty, /还没有练习记录/);
  assert.doesNotMatch(empty, /class="empty|empty-icon|wb-empty/);
  assert.doesNotMatch(empty, emoji);
  const failed = html(m.WrongBookView, { ...base, items: null, err: '读取失败了' });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /sh-inline--error/);
  assert.doesNotMatch(failed, /wb-error/);
  const stale = html(m.WrongBookView, { ...base, err: '网络断了' });
  assert.match(stale, /读取失败，仍显示上次结果：网络断了/);
  const loading = html(m.WrongBookView, { ...base, items: null, loading: true });
  assert.match(loading, /role="status"[^>]*>(?:<span[^>]*sh-spinner[^>]*><\/span>)?<span class="sh-loading__label">正在读取待巩固题…/);
});

test('the graph says loading, failure (with retry) and empty through the shared components', () => {
  m.setUiLanguage('zh');
  assert.match(html(m.GraphStatus, { loading: true }), /role="status"[\s\S]*正在生成图谱…/);
  const failed = html(m.GraphStatus, { error: '网络断了', onRetry: noop });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /图谱加载失败/);
  assert.match(failed, /网络断了/);
  assert.match(failed, /<button[^>]*sh-btn--link[^>]*>重试<\/button>/, 'retry is a Button');
  assert.doesNotMatch(failed, /graph-error/);
  assert.match(html(m.GraphStatus, {}), /当前范围内没有可展示的题目。/);
});

test('error boundaries share one CrashFallback: no emoji, no raw message as the text', () => {
  m.setUiLanguage('zh');
  const crashed = new m.StudyBoundary({ children: null });
  crashed.state = { error: new Error('TypeError: x is undefined'), nonce: 0 };
  const out = renderToStaticMarkup(crashed.render());
  assert.match(out, /class="study-app"/);
  assert.match(out, /sh-crash/);
  assert.match(out, /role="alert"/);
  assert.doesNotMatch(out, emoji);
  assert.match(out, /学习工作台渲染出错/);
  const main = out.slice(0, out.indexOf('<details'));
  assert.doesNotMatch(main, /x is undefined/);
  assert.match(out.slice(out.indexOf('<details')), /x is undefined/);
  assert.match(out, /<button[^>]*sh-btn[\s\S]*?重新加载<\/button>/);
  assert.doesNotMatch(out, /ghost-btn|class="empty/);
  const View = m.deferredView(() => Promise.resolve({ default: () => null }));
  const deferred = new View({});
  deferred.state = { ...deferred.state, error: new Error('Failed to fetch module') };
  const fallback = renderToStaticMarkup(deferred.render());
  assert.match(fallback, /sh-crash/);
  assert.match(fallback, /role="alert"/);
  assert.match(fallback.slice(0, fallback.indexOf('<details')), /^((?!Failed to fetch module).)*$/s);
  assert.match(fallback, /重新加载/);
  const loading = renderToStaticMarkup(new View({}).render());
  assert.match(loading, /role="status"/);
});

test('a deferred view that is kept mounted out of sight shows no loading bar while its chunk is on the way (3.0.0: the page moved 46 px when it arrived)', () => {
  m.setUiLanguage('zh');
  const View = m.deferredView(() => new Promise(() => {}));
  const status = props => /role="status"/.test(renderToStaticMarkup(new View(props).render()));
  assert.equal(status({ visible: false }), false, 'LiveClass stays mounted for recording and is hidden on every other page: its fallback must not push the page down');
  assert.equal(status({ visible: true }), true, 'the page the learner opened still says it is loading');
  assert.equal(status({}), true, 'views without a visible prop keep their fallback');
});

test('IndexBadge is a Badge whose tone and icon follow the index state', () => {
  m.setUiLanguage('zh');
  const badge = info => html(m.IndexBadge, { info });
  assert.match(badge({ state: 'indexed', total: 120 }), /sh-badge[^>]*data-tone="success"[^>]*data-state="indexed"|data-state="indexed"[^>]*data-tone="success"/);
  assert.match(badge({ state: 'indexed', total: 120 }), /索引已建好 · 这份资料 120\/120 页/);
  assert.match(badge({ state: 'partial', indexed: 3, total: 9 }), /data-tone="warning"/);
  assert.match(badge({ state: 'stale', stale: 2 }), /data-tone="warning"/);
  assert.match(badge({ state: 'building' }), /data-tone="info"[\s\S]*sh-spinner/);
  assert.match(badge({ state: 'missing' }), /data-tone="neutral"/);
  assert.match(badge({ state: 'missing' }), /role="tooltip"[^>]*>这份资料还没有检索目录/, 'the words behind the badge are a Tooltip, not a title');
  assert.equal(html(m.IndexBadge, {}), '');
});

test('the Jev marks are Badges and the duplicated decided badge has one implementation', async () => {
  m.setUiLanguage('zh');
  assert.match(html(m.JevDecidedBadge), /sh-badge[^>]*data-jev-decided="card"|data-jev-decided="card"[^>]*sh-badge/);
  assert.match(html(m.JevDecidedBadge, { scope: 'row' }), /data-jev-decided="row"/);
  assert.match(html(m.JevDecidedBadge, { scope: 'row' }), /由 Jev 判定/);
  assert.match(html(m.JevCardBadge, { signal: { flagged: true } }), /data-tone="warning"/);
  assert.match(html(m.JevCardBadge, { signal: {} }), /data-tone="success"/);
  assert.match(html(m.JevCardBadge, { signal: { rewritten: true } }), /data-tone="info"/);
  const organize = await read('ui/JevOrganize.jsx');
  assert.doesNotMatch(organize, /jev-badge--decided/, 'the organizer re-uses the draft badge');
  for (const file of ['ui/JevBadge.jsx', 'ui/JevOrganize.jsx']) assert.doesNotMatch(await read(file), /audio-chip/, `${file} borrows no audio class`);
});

test('the case report uses the shared spinner and error message', async () => {
  m.setUiLanguage('zh');
  const source = await read('ui/CaseResult.jsx');
  assert.doesNotMatch(source, /assist-spin/);
  assert.doesNotMatch(source, /className="warning"/);
  assert.match(source, /<Spinner|LoadingState/);
});

test('loading text and errors in the pages of this package come from the shared components', async () => {
  for (const file of ['ui/Dashboard.jsx', 'ui/WrongBook.jsx', 'ui/Graph.jsx']) {
    const source = await read(file);
    assert.doesNotMatch(source, /className="(?:dash-error|wb-error|graph-error|graph-state graph-error)"/, file);
    assert.doesNotMatch(source, /className="empty/, file);
    assert.doesNotMatch(source, /empty-icon/, file);
    assert.match(source, /LoadingState/, file);
  }
  const dashboard = await read('ui/Dashboard.jsx');
  assert.match(dashboard, /ErrorState/);
  assert.doesNotMatch(await read('ui/EmptyStudyActions.jsx'), /<button/);
});

test('CSS that these components replaced is gone from the files this package owns', async () => {
  for (const [file, pattern] of [['ui/graph.css', /\.graph-error/], ['ui/wrongbook.css', /\.wb-empty/]]) {
    assert.doesNotMatch(await read(file), pattern, file);
  }
  const jev = await read('ui/jev.css');
  assert.doesNotMatch(jev, /\.jev-badge(?:--|\s*\{)/, 'jev.css has no private badge rules left');
  await assert.rejects(read('ui/index-badge.css'), 'index-badge.css is deleted');
});
