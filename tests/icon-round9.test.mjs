import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import React from 'react';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { SINGULAR_KEY } from './helpers/plurals.mjs';
import { buttonElements, clickDoes, goOnProblems, labelHelpers, leadIconProblems, localHandlers, LOOK_EXCEPTIONS, LEADS_WHILE_LEAVING, looksOf, propOf } from './helpers/go-on.mjs';

/* #1073, round 9 of the review of PR #1118 (the round-8 review, e01b3a18):
     1  the singulars never reached the 资料 page's summary line ("2 sources, grouped by course (1 groups)", "1 sources"): its templates start with a space,
        ui() looks a template up trimmed, the singular lookup did not;
     2  「检查理解 →」 checks the answer where it stands (teachingAct), and its twins 提交答案 (reviewAct) have no arrow: the gate did not read `…Act(`;
     3  one action, two looks (从这份资料出题 ✦ / →, 打开交互伴学页 ▶ / →, 创建题组 + / →): the same words draw one look everywhere, and a control that leaves ends
        in → with nothing in front;
     4  「练这一章」 led with a tick (it reads "done") where its twins 练这一组 / 练这一节 end in →;
     5  the breadcrumb's separator was the go-on arrow on every page;
     6  the first-run line measured whether a step is cut before the web font arrived. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
let cache;
const all = async () => {
  if (!cache) { const sources = await uiSources(); cache = { sources, helpers: labelHelpers(sources) }; }
  return cache;
};
const englishCatalogue = async () => {
  const catalogue = {};
  for (const name of (await readdir(new URL('../ui/locales/', import.meta.url))).filter((entry) => /^en(?:\..+)?\.json$/.test(entry)).sort()) {
    for (const [key, value] of Object.entries(JSON.parse(await read(`ui/locales/${name}`)))) if (!Object.hasOwn(catalogue, key)) catalogue[key] = value;
  }
  return catalogue;
};

/* ---- 1: the singular of a call site's own template, as written ------------------------------------------------------------------------------------------- */

/** Every call of uiFormat / uiRich / uiTemplate in ui/ with a literal template: { file, line, fn, raw } (`raw` as written, with its spaces). */
async function templateSites() {
  const { sources } = await all(), sites = [];
  for (const { file, source } of sources) {
    for (const match of source.matchAll(/\b(uiFormat|uiRich|uiTemplate)\(\s*(["'`])((?:\\.|(?!\2)[^\\])*?)\2/g)) {
      if (match[2] === '`' && match[3].includes('${')) continue;
      sites.push({ file, line: source.slice(0, match.index).split('\n').length, fn: match[1], raw: match[3].replace(/\\(["'`\\])/g, '$1') });
    }
  }
  return sites;
}

test('1: every singular of the catalogue comes out at every call site, with the template as the site writes it (leading spaces and all)', async () => {
  const catalogue = await englishCatalogue(), sites = await templateSites();
  const { setUiLanguage, uiFormat, uiRich } = await loadUi("export { setUiLanguage, uiFormat } from './ui/i18n.js'; export { uiRich } from './ui/i18n-rich.jsx';");
  const text = (parts) => parts.map((part) => typeof part === 'string' ? part : String(part.props.children)).join('');
  const fill = (value, values) => value.replace(/\{(\d+)\}/g, (hit, index) => String(values[index]));
  const wrong = [];
  let checked = 0, padded = 0;
  setUiLanguage('en');
  try {
    for (const key of Object.keys(catalogue).filter((name) => SINGULAR_KEY.test(name))) {
      const base = key.replace(SINGULAR_KEY, ''), ones = (/#one:([\d,]+)$/.exec(key)?.[1] ?? '0').split(',').map(Number);
      const slots = Math.max(...[...base.matchAll(/\{(\d+)\}/g)].map((hit) => Number(hit[1]))) + 1;
      const values = Array.from({ length: slots }, (_, index) => (ones.includes(index) ? 1 : 2));
      for (const site of sites.filter(({ raw }) => raw.replace(/\s+/g, ' ').trim() === base)) {
        const got = (site.fn === 'uiRich' ? text(uiRich(site.raw, ...values)) : site.fn === 'uiTemplate' ? fill(uiFormat(site.raw, values), values) : uiFormat(site.raw, values)).trim();
        const want = fill(catalogue[key], values).trim();
        checked++;
        if (site.raw !== base) padded++;
        if (got !== want) wrong.push(`${site.file}:${site.line} ${JSON.stringify(site.raw)} with ${JSON.stringify(values)}: "${got}", want "${want}"`);
      }
    }
  } finally { setUiLanguage('zh'); }
  assert.deepEqual(wrong, []);
  assert.ok(checked > 300, `${checked} call sites of a counted template read`);
  assert.ok(padded >= 9, `the 资料 page's nine summary lines (a space in front of the template) are among them: ${padded}`);
});

test('1: the 资料 page says "1 source" and "(1 group)", and keeps the space in front of its summary line', async () => {
  const { setUiLanguage, uiFormat } = await loadUi("export { setUiLanguage, uiFormat } from './ui/i18n.js';");
  setUiLanguage('en');
  try {
    assert.equal(uiFormat(' 共 {0} 份资料，按课程分为 {1} 组。', [1, 1]), ' 1 source, grouped by course (1 group).');
    assert.equal(uiFormat(' 共 {0} 份资料，按课程分为 {1} 组。', [2, 1]), ' 2 sources, grouped by course (1 group).');
    assert.equal(uiFormat(' 共 {0} 份资料，按课程分为 {1} 组。', [2, 3]), ' 2 sources, grouped by course (3 groups).');
    assert.equal(uiFormat(' 共 {0} 份资料。', [1]), ' 1 source.');
  } finally { setUiLanguage('zh'); }
});

/* ---- 2: a review or teaching action is a data action where it stands -------------------------------------------------------------------------------------- */

test('2: `reviewAct(…)` / `teachingAct(…)` act where they stand (a dispatch of the run), and only a start of a run leaves', () => {
  assert.equal(clickDoes('() => reviewAct("review.answer", { selected })'), 'here');
  assert.equal(clickDoes('() => actions.teachingAct("teach.answer", { id, answer })'), 'here');
  assert.equal(clickDoes('submitStep', new Map([['submitStep', '{ if (busy) return; actions.teachingAct("teach.answer", { id: teaching.id }); }']])), 'here');
  assert.equal(clickDoes('() => reviewAct("review.start", { scope })'), 'leave', 'a run that starts is still a way on');
});

test('2: 检查理解 checks the answer where it stands: no →, like 提交答案', async () => {
  const { helpers } = await all();
  for (const file of ['ui/review/TeachingPanel.jsx', 'ui/review/QuestionRun.jsx', 'ui/review/QuestionParts.jsx']) {
    const source = await read(file);
    assert.deepEqual(goOnProblems(source, { file, helpers }).map((problem) => `${problem.label}: ${problem.want}`), [], file);
  }
  const panel = await read('ui/review/TeachingPanel.jsx');
  const check = buttonElements(panel).find(({ children }) => children.includes('检查理解'));
  assert.ok(check && !/iconEnd=/.test(check.open), '检查理解 draws no arrow');
});

test('2: no Button whose click dispatches a review or teaching action falls back to its words', async () => {
  const { sources, helpers } = await all(), unknown = [];
  for (const { file, source } of sources) {
    const locals = localHandlers(source);
    for (const { open, at } of buttonElements(source)) {
      const click = propOf(open, 'onClick');
      if (/\b[a-z]\w*Act\(/.test(click) && !clickDoes(click, locals, new Set(), { wiring: helpers.wiring, file, at })) unknown.push(`${file}: ${click.slice(0, 80)}`);
    }
  }
  assert.deepEqual(unknown, []);
});

/* ---- 3, 4: one action, one look ------------------------------------------------------------------------------------------------------------------------------ */

test('3: the same words draw one look everywhere (the icon in front, the arrow after), or are listed with why', async () => {
  const { sources, helpers } = await all(), byKey = new Map();
  for (const { file, source } of sources) {
    for (const { key, look, line } of looksOf(source, { file, helpers })) {
      if (!byKey.has(key)) byKey.set(key, new Map());
      const looks = byKey.get(key);
      if (!looks.has(look)) looks.set(look, []);
      looks.get(look).push(`${file}:${line}`);
    }
  }
  const twoLooks = [...byKey].filter(([, looks]) => looks.size > 1);
  const listed = new Set(LOOK_EXCEPTIONS.map((entry) => entry.key));
  assert.deepEqual(twoLooks.filter(([key]) => !listed.has(key)).map(([key, looks]) => `${key}: ${[...looks].map(([look, where]) => `${look} at ${where.join(', ')}`).join(' / ')}`), []);
  for (const entry of LOOK_EXCEPTIONS) {
    assert.ok(twoLooks.some(([key]) => key === entry.key), `${entry.key}: has one look now, so it leaves the list`);
    assert.ok(entry.why.length > 30, `${entry.key}: say why`);
  }
  assert.ok(byKey.size > 400, `${byKey.size} labels read`);
});

test('3: the round-8 pairs have one look each: 从这份资料出题, 打开交互伴学页 and 创建题组 end in → with nothing in front', async () => {
  const { sources, helpers } = await all(), found = new Map();
  for (const { file, source } of sources) for (const { key, look } of looksOf(source, { file, helpers })) if (['从这份资料出题', '打开交互伴学页', '创建题组', '练这一章'].includes(key)) found.set(key, [...(found.get(key) || []), look]);
  for (const key of ['从这份资料出题', '打开交互伴学页', '创建题组', '练这一章']) assert.deepEqual([...new Set(found.get(key))], ['-|→'], key);
});

test('3: a control that leaves ends in → with nothing in front: a leading icon is for a control that acts where it stands (or listed with why)', async () => {
  const { sources, helpers } = await all(), problems = [], used = new Set();
  for (const { file, source } of sources) problems.push(...leadIconProblems(source, { file, helpers, used }).map((problem) => `${file}: ${problem.label} (${problem.icon})`));
  assert.deepEqual(problems, []);
  assert.deepEqual(LEADS_WHILE_LEAVING.filter((entry) => !used.has(entry)).map((entry) => entry.file), [], 'a listed exception no control needs any more is deleted');
  for (const entry of LEADS_WHILE_LEAVING) assert.ok(entry.why.length > 30, `${entry.file}: say why`);
});

test('3: the look gate reads a Button, an action spec, and a spec drawn by the job card (its arrow unless `here`)', () => {
  const looks = (source, file = 'ui/X.jsx') => looksOf(source, { file }).map(({ key, look }) => `${key}=${look}`);
  assert.deepEqual(looks('<Button icon="sparkle" onClick={go}>{ui("从这份资料出题")}</Button>'), ['从这份资料出题=sparkle|-']);
  assert.deepEqual(looks('<Button iconEnd="arrow-right" onClick={go}>{ui("从这份资料出题")}</Button>'), ['从这份资料出题=-|→']);
  assert.deepEqual(looks('<Button icon={<Icon name="archive" />} onClick={go}>{ui("归档")}</Button>'), ['归档=archive|-']);
  assert.deepEqual(looks("const a = { label: ui('创建题组'), icon: 'sparkle', onClick: go };"), ['创建题组=sparkle|-']);
  assert.deepEqual(looks("const a = { label: ui('检查草稿'), run: () => openDraft(d) }; const b = { label: ui('再试一次'), here: true, run: retry };", 'ui/study-map/JobCard.jsx'), ['检查草稿=-|→', '再试一次=-|-']);
});

test('4: 练这一章 ends in → like 练这一组, 练这一节 and 再练这一节; a tick in front says "done"', async () => {
  const { sources, helpers } = await all(), twins = [];
  for (const { file, source } of sources) for (const { key, look, line } of looksOf(source, { file, helpers })) if (/^再?练这一[章组节]$/.test(key)) twins.push(`${key} ${look} ${file}:${line}`);
  assert.ok(twins.length >= 4, twins.join('\n'));
  assert.deepEqual(twins.filter((row) => !row.includes(' -|→ ')), []);
});

/* ---- 5: the breadcrumb is a path, not a way on --------------------------------------------------------------------------------------------------------------- */

/** The places that draw the go-on arrow as an <Icon> of their own (not a Button's iconEnd), each with why: a control's or a row's end, or punctuation in text. */
const ARROW_ICONS = [
  { file: 'ui/study-map/DeckRow.jsx', why: 'the 「继续 →」 face of the deck row\'s play slot: the control resumes the run' },
  { file: 'ui/study-map/DeskIntro.jsx', why: 'the end of a resume row (a Button): it takes the learner to the run' },
  { file: 'ui/study-map/HomeActivity.jsx', why: 'the end of an activity row (a Button): 打开 takes the learner to the draft' },
  { file: 'ui/study-map/NotebookDirectory.jsx', why: 'the end of a notebook row (a Button): it opens the notebook' },
  { file: 'ui/review/QuestionRun.jsx', why: 'the end of the prerequisite row (a Button): it goes to the prerequisite' },
  { file: 'ui/book/BookLookup.jsx', why: 'a glossary cross-reference, term → see: punctuation inside a line of text (A → B), drawn as the registry\'s arrow' },
  { file: 'ui/SkeletonCanvas.jsx', why: 'a step of the skeleton\'s replay, from → to: punctuation inside a line of text (A → B)' },
];

test('5: the breadcrumb separates its path with the chevron; the go-on arrow is drawn only by a control that goes on (or punctuation, listed)', async () => {
  const bar = await read('ui/app/AppTopbar.jsx');
  const crumbs = /<nav className="crumbs"[\s\S]*?<\/nav>/.exec(bar)?.[0] ?? '';
  assert.match(crumbs, /<Icon\b[^>]*name="chevron"/, 'the separator is the chevron');
  assert.doesNotMatch(crumbs, /arrow-right/);
  const { sources } = await all(), sites = new Set();
  for (const { file, source } of sources) if (/<Icon\b[^>]*\bname="arrow-right"/.test(source) || /<Icon\b[^>]*\bname=\{[^}]*["']arrow-right["']/.test(source)) sites.add(file);
  assert.deepEqual([...sites].filter((file) => !ARROW_ICONS.some((entry) => entry.file === file)).sort(), []);
  assert.deepEqual(ARROW_ICONS.filter((entry) => !sites.has(entry.file)).map((entry) => entry.file), [], 'a listed site that draws no arrow any more is deleted');
  const design = await read('ui/DESIGN.md');
  assert.match(design, /breadcrumb[^\n]*chevron/i, 'ui/DESIGN.md says what separates a path');
});

/* ---- 6: the first-run line measures again once the font is in -------------------------------------------------------------------------------------------- */

test('6: useClamped measures again when the web font has loaded (it changes the width of the words)', async () => {
  const line = await read('ui/first-run/FirstRunLine.jsx');
  const body = /function useClamped\([\s\S]*?\n\}/.exec(line)?.[0] ?? '';
  assert.match(body, /document\.fonts\?\.ready\??\.then\(/);
  assert.match(body, /let live = true|alive/, 'a measure after the font is skipped once the effect has been cleaned up');
});

void React;
