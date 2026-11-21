import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { draftPointReport, POINT_REASONS } from '../lib/evidence/point-report.js';
import { COURSE, pointLibrary } from './helpers/point-library.mjs';

/* 知识点查缺 on the draft page (ui/coverage/PointGaps.jsx), in zh and en: the one line, the fold of uncovered points (前置 marked, what each rests on, the ones that
   cannot be written), the one action 「补这些知识点」 and the request it sends (the same top-up as the page's others, ui/coverage/top-up.js), and the one quiet line
   when the course has no outline to count by. The report is the real one of a small course (tests/helpers/point-library.mjs). */

const m = await loadUi(`
  export { default as PointGaps } from './ui/coverage/PointGaps.jsx';
  export { topUpArgs, topUpNotice } from './ui/coverage/top-up.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const source = await readFile(new URL('../ui/coverage/PointGaps.jsx', import.meta.url), 'utf8');
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const draft = { id: 'dr', title: '草稿', course: COURSE, draftVersion: 3, cards: [], editorial: { requested: 3, generation: { sourceIds: ['doc-p1', 'doc-p2'], course: COURSE } } };
const render = (props) => renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.PointGaps, { draft, onTopUp: () => {}, ...props })));

// A's question and B's question are in the deck; C (resting on B, which A rests on) has none, D has no verified text.
const { state } = pointLibrary();
const report = draftPointReport(state, draft);

test('the one line, the fold of uncovered points and the one action, in zh', () => {
  assert.deepEqual([report.points, report.uncovered, report.uncoverable, report.topUp], [4, 2, 1, { pointIds: ['pc'], questions: 1 }]);
  const html = render({ report }), words = text(html);
  assert.match(words, /4 个知识点，2 个还没有题/);
  assert.match(words, /还没有题的知识点/);
  assert.deepEqual([...html.matchAll(/data-point="([^"]+)"/g)].map(match => match[1]), ['pc', 'pd'], 'the uncovered points, in the order to fill them');
  assert.match(words, /先学：Point B/, 'what C rests on');
  assert.match(html, /data-point="pd"[^>]*>[\s\S]*?资料里找不到它的原文，补不了/, 'D cannot be written');
  assert.match(words, /补其中 1 个，约 1 题；一轮补不完的下次再补。|补 1 个知识点，约 1 题。/);
  assert.match(words, /补这些知识点/);
  assert.equal((html.match(/data-points-topup/g) || []).length, 1, 'ONE action');
  assert.ok(!/\stitle=/.test(source), 'explanations are tooltips, never title=');
});

test('a point others rest on is marked 前置, with why in a tooltip', () => {
  const marked = { ...report, list: report.list.map(point => (point.id === 'pc' ? { ...point, dependents: 2 } : point)) };
  const html = render({ report: marked });
  assert.match(html, /data-point="pc"[\s\S]*?data-point-prereq[^>]*>前置</);
  assert.match(html, /有 2 个知识点建立在它之上，先补它。/);
});

test('every word in English, the learner\'s point titles aside', () => inLanguage('en', () => {
  const html = render({ report });
  const words = text(html);
  assert.ok(!han.test(words), `untranslated: ${words.match(new RegExp(`.{0,30}${han.source}.{0,30}`))?.[0]}`);
  assert.match(words, /4 knowledge points, 2 without a question/);
  for (const reason of POINT_REASONS) {
    const quiet = text(render({ report: { status: 'unavailable', reason } }));
    assert.ok(quiet.trim() && !han.test(quiet), `${reason}: ${quiet}`);
  }
  const notice = renderNotice();
  assert.ok(!han.test(notice.replace(draft.title, '')), notice);
}));

test('no outline to count by: one quiet line saying why and where, nothing else', () => {
  for (const reason of POINT_REASONS) {
    const html = render({ report: { status: 'unavailable', reason } });
    assert.match(html, new RegExp(`data-points-unavailable="${reason}"`));
    assert.match(text(html), /「总纲」页/, `${reason} says where`);
    assert.ok(!/data-points-topup|data-point=/.test(html), `${reason}: no list, no action`);
  }
  assert.equal(render({ report: { status: 'unavailable', reason: 'unknown' } }), '');
  assert.equal(render({ report: { ...report, points: 0 } }), '', 'a draft whose materials hold no point says nothing');
});

test('every point has a question: the line says so, with no fold and no action', () => {
  const html = render({ report: { ...report, uncovered: 0, uncoverable: 0, list: [], more: 0, topUp: null } });
  assert.match(text(html), /4 个知识点都有题了/);
  assert.ok(!/data-points-list|data-points-topup/.test(html));
});

test('the request: the draft and its point ids, a top-up like the others; 补这些知识点 sends exactly the report\'s points and says so when it starts', async () => {
  assert.deepEqual(m.topUpArgs(draft, null, { pointIds: ['pc'] }), { resumeDraftId: 'dr', draftVersion: 3, coverage: { pointIds: ['pc'] } });
  assert.deepEqual(m.topUpArgs(draft, ['s1'], { manual: true }).coverage, { sectionIds: ['s1'], manual: true, autoComplete: false }, 'the other top-ups are unchanged');
  const calls = [];
  const tree = renderTree({ report, onTopUp: (...args) => calls.push(args) });
  const button = find(tree, node => node.props?.['data-points-topup']);
  button.props.onClick();
  assert.equal(calls.length, 1);
  const [target, sectionIds, options] = calls[0];
  assert.deepEqual([target.id, sectionIds, options.pointIds], ['dr', null, ['pc']]);
  assert.equal(options.notice(draft, { coverage: { questions: 1 } }), '已开始为「草稿」补 1 个知识点，约 1 题；通过检查后会保存到同一份草稿。');
  const estimate = find(tree, node => node.props?.request?.feature === 'generate');
  assert.deepEqual(estimate.props.request, { feature: 'generate', resumeDraftId: 'dr', draftVersion: 3, coverage: { pointIds: ['pc'] } }, 'the estimate is of the same request');
});

test('知识点查缺 reaches nothing in lib/ of its own: loading it apart must not split the chunks of the first load', async () => {
  const seen = new Set(), pending = ['ui/coverage/PointGaps.jsx'];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), dir = file.slice(0, file.lastIndexOf('/'));
    for (const [, spec] of code.matchAll(/^import [^;]*?from '(\.[^']+)'/gm)) {
      const path = new URL(spec, `file:///${dir}/`).pathname.slice(1);
      assert.doesNotMatch(path, /^lib\//, `${file} imports ${spec}`);
      if (/^ui\/coverage\/(?:PointGaps|point-)/.test(path)) pending.push(path);
    }
  }
  assert.deepEqual([...seen].sort(), ['ui/coverage/PointGaps.jsx', 'ui/coverage/point-gaps.css', 'ui/coverage/point-words.js']);
});

function renderNotice() {
  const tree = renderTree({ report, onTopUp: (...args) => { renderNotice.options = args[2]; } });
  find(tree, node => node.props?.['data-points-topup']).props.onClick();
  return renderNotice.options.notice(draft, { coverage: { questions: 1 } });
}

/** The element tree PointGaps returns (one level: its own elements), with the hooks it calls answered here. */
function renderTree(props) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, before = internals.H;
  internals.H = { useInsertionEffect: () => {}, useContext: () => ({ call: async () => ({}), busy: false }) };
  try { return m.PointGaps({ draft, onTopUp: () => {}, ...props }); } finally { internals.H = before; }
}

function find(node, wanted) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const item of node) { const found = find(item, wanted); if (found) return found; } return null; }
  if (wanted(node)) return node;
  return find(node.props?.children, wanted);
}
