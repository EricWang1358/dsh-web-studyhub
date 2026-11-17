import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import React from 'react';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { countedNouns, missingSingulars, SINGULAR_KEY } from './helpers/plurals.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { actionProblems, buttonElements, clickDoes, externalProblems, goOnProblems, labelHelpers, labelsOf, localHandlers, propOf, specProblems, varsOf, wiringOf } from './helpers/go-on.mjs';

/* #1073, round 8 of the review of PR #1118 (the round-7 review, 2e391b83). The gate read a click's handler, but not the prop it calls: 查看图谱, 改题型和题数,
   从这份资料出题 and 管理题组 leave through a prop wired in ui/app/page-views.jsx and passed with no →, and 创建题组 (`onCreate`) was taken for "here" by its name
   while its wiring is `intents.goGenerate()`. Now a prop is read where it is wired (tests/helpers/go-on.mjs, wiringOf), and what the wiring does beats the name. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ARROW_END = /\biconEnd=(?:"arrow-right"|\{[^}]*arrow-right)/;
let cache;
const all = async () => {
  if (!cache) {
    const sources = await uiSources();
    cache = { sources, byFile: new Map(sources.map(({ file, source }) => [file, source])), helpers: labelHelpers(sources) };
  }
  return cache;
};
/** What the click of the Button of `file` whose words match `label` does, read where its props are wired. */
async function wiredClick(file, label) {
  const { byFile, helpers } = await all(), source = byFile.get(file), vars = varsOf(source);
  const found = buttonElements(source).filter(({ children }) => labelsOf(children, helpers, vars).some((words) => label.test(words)));
  assert.ok(found.length, `${file}: ${label}`);
  return found.map(({ open, at }) => ({ open, does: clickDoes(propOf(open, 'onClick'), localHandlers(source), new Set(), { wiring: helpers.wiring, file, at }) }));
}

/* ---- 1: a prop is read where it is wired -------------------------------------------------------------------------------------------------------------- */

test('1: a prop is read where it is wired: the JSX site of the component, a pass-through, an object handed in, a member destructured from one', () => {
  const sources = [
    { file: 'ui/Bar.jsx', source: 'export default function Bar({ onShowGraph, on }) {\n  return <>\n<Button onClick={() => onShowGraph?.(null)}>{ui("查看图谱")}</Button>\n<Button onClick={() => on.tune(ids)}>{ui("改题型和题数")}</Button>\n</>;\n}' },
    { file: 'ui/Map.jsx', source: 'export default function Map({ actions = {} }) {\n  const { onShowGraph, tune } = actions;\n  const lineOn = { tune, later: hide };\n  return <Bar onShowGraph={onShowGraph} on={lineOn} />;\n}' },
    { file: 'ui/app/views.jsx', source: 'function Home() {\n  return <Map actions={{ onShowGraph: (scope) => { set.setGraphScope(scope); nav.navigate("graph"); }, tune: (ids) => intents.goGenerate({ ids }) }} />;\n}' },
  ];
  const helpers = labelHelpers(sources), [bar] = sources;
  assert.equal(clickDoes('() => onShowGraph?.(null)', localHandlers(bar.source)), '', 'without the wiring the prop says nothing');
  const problems = goOnProblems(bar.source, { file: bar.file, helpers });
  assert.deepEqual(problems.map((problem) => problem.label), ['查看图谱', '改题型和题数'], 'both leave through their wiring, and have no →');
  assert.equal(goOnProblems(bar.source.replaceAll('<Button onClick', '<Button iconEnd="arrow-right" onClick'), { file: bar.file, helpers }).length, 0);
});

test('1: a prop wired to leave in one place and to stay in another is undecided (its words decide), and a dismissal is never traced', () => {
  const sources = [
    { file: 'ui/Row.jsx', source: 'export function Row({ onPick, onClose }) {\n  return <>\n<Button onClick={onPick}>{ui("选这一项")}</Button>\n<Button onClick={onClose}>{ui("关闭")}</Button>\n</>;\n}' },
    { file: 'ui/A.jsx', source: 'function A() { return <Row onPick={() => nav.navigate("x")} onClose={() => nav.navigate("home")} />; }' },
    { file: 'ui/B.jsx', source: 'function B() { return <Row onPick={() => setPicked(true)} onClose={() => setOpen(false)} />; }' },
  ];
  const wiring = wiringOf(sources), [row] = sources, locals = localHandlers(row.source);
  assert.equal(clickDoes('onPick', locals, new Set(), { wiring, file: row.file, at: row.source.indexOf('onPick}') }), '');
  assert.equal(clickDoes('onClose', locals, new Set(), { wiring, file: row.file, at: row.source.indexOf('onClose}') }), 'here', 'closing is not going on, wherever it closes to');
});

test('1: what the wiring does beats the name of the prop: `onCreate` wired to intents.goGenerate() leaves', () => {
  const sources = [
    { file: 'ui/Empty.jsx', source: 'export default function Empty({ onCreate }) {\n  return <Button variant="primary" onClick={onCreate}>{ui("创建题组")}</Button>;\n}' },
    { file: 'ui/app/views.jsx', source: 'function V() { return <Empty onCreate={() => intents.goGenerate()} />; }' },
  ];
  assert.equal(clickDoes('onCreate'), 'here', 'by its name alone, `create` acts here');
  const [empty] = sources;
  assert.equal(goOnProblems(empty.source, { file: empty.file, helpers: labelHelpers(sources) }).length, 1, 'traced, it leaves and wants →');
});

test('1/2: on the frequent screens, the controls that leave through a prop end in →', async () => {
  for (const [file, label] of [['ui/study-map/CatalogHeading.jsx', /^查看图谱$/], ['ui/study-map/SelectionBar.jsx', /^查看图谱$/], ['ui/first-run/FirstRunLine.jsx', /^改题型和题数$/],
    ['ui/Sources.jsx', /^从这份资料出题$/], ['ui/ArchivedDeckRow.jsx', /^管理题组$/], ['ui/EmptyStudyActions.jsx', /^创建题组$/], ['ui/charts/DashboardCharts.jsx', /^管理课程$/]]) {
    for (const { open, does } of await wiredClick(file, label)) {
      if (/\sicon=/.test(open)) continue; // the row's own 从这份资料出题 leads with its sparkle: a Button with its own leading icon takes no arrow
      assert.match(open, ARROW_END, `${file}: ${label} ends in →`);
      if (!/DashboardCharts/.test(file)) assert.equal(does, 'leave', `${file}: ${label} is read as leaving through its wiring`);
    }
  }
  // 修改课程的考试设置… and 打开「课程」 open the course's settings dialog over the page (settingsEntry.setCourseSettings): no →.
  for (const [file, label] of [['ui/CaseCreate.jsx', /^修改课程的考试设置/], ['ui/CourseSettings.jsx', /^打开「\{0\}」$/]]) {
    for (const { open, does } of await wiredClick(file, label)) { assert.doesNotMatch(open, ARROW_END, `${file}: ${label}`); assert.equal(does, 'here'); }
  }
});

test('1/2: the whole of ui/ agrees with the rule read through the wiring, and fewer Buttons are left to their words (a ratchet)', async () => {
  const { sources, helpers } = await all();
  const seen = {}, used = new Set(), found = [];
  for (const { file, source } of sources) {
    for (const { label, open, want } of goOnProblems(source, { file, helpers, used, seen })) found.push(`${file}: ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of actionProblems(source, { file, helpers, used, seen })) found.push(`${file}: action ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of specProblems(source, { file })) found.push(`${file}: spec ${label} wants ${want}  ${open.slice(0, 80)}`);
  }
  assert.deepEqual(found, []);
  // Round 7 left 323 to their words; read through the wiring, 247. What is left: hooks' members (plan.start, recap.generate), props wired to a hook in one
  // place and to the page in another, Menu triggers spread in with no click, and host calls.
  assert.ok(seen.unknown <= 247, `the click decides for most Buttons (${JSON.stringify(seen)})`);
});

test('1: what the gate reads does not depend on the order of the files', async () => {
  const { sources } = await all();
  const classify = (list) => {
    const helpers = labelHelpers(list), rows = [];
    for (const { file, source } of list) {
      const locals = localHandlers(source);
      for (const { open, at } of buttonElements(source)) rows.push(`${file}@${at}:${clickDoes(propOf(open, 'onClick'), locals, new Set(), { wiring: helpers.wiring, file, at })}`);
    }
    return rows.sort();
  };
  assert.deepEqual(classify([...sources].reverse()), classify(sources));
});

/* ---- 2: a name is not the gate ------------------------------------------------------------------------------------------------------------------------ */

test('2: 创建题组 on the empty home ends in → beside 开始学习 → and 查看待发布草稿 →', async () => {
  const source = await read('ui/EmptyStudyActions.jsx');
  for (const label of ['开始学习', '查看待发布草稿', '创建题组']) {
    const button = buttonElements(source).find(({ children }) => children.includes(`ui("${label}")`));
    assert.match(button.open, ARROW_END, label);
  }
});

/* ---- 5: one look for a DSH chat; 去原文看这段 like every control that opens the reader at a quote ------------------------------------------------------------ */

test('5: every link to a DSH chat is an AgentLink, which leads with the external mark; no site hands it a second look', async () => {
  const agentLink = await read('ui/AgentLink.jsx');
  const [button] = buttonElements(agentLink);
  assert.match(button.open, /\sicon="external"/, 'AgentLink leads with external');
  assert.doesNotMatch(button.open, /\siconEnd=/, 'and nothing trails');
  assert.equal(externalProblems('<AgentLink childId={id} openAgent={openAgent} label={ui("在 DSH 中打开完整会话")} iconEnd="external" />').length, 2, 'a trailing mark handed to AgentLink is two faults');
  assert.equal(externalProblems('<AgentLink childId={id} openAgent={openAgent} label={ui("查看后台助手")} />').length, 0);
  const { sources } = await all();
  assert.deepEqual(sources.flatMap(({ file, source }) => externalProblems(source).map((problem) => `${file}: ${problem.label} ${problem.want}`)), []);
  for (const [file, label] of [['ui/tasks/OutputPanel.jsx', '在 DSH 中打开完整会话'], ['ui/GenerationTrace.jsx', '查看后台助手']]) {
    const source = await read(file);
    const at = source.indexOf(`label={ui(${file.includes('tasks') ? "'" : '"'}${label}`);
    const open = source.slice(source.lastIndexOf('<AgentLink', at), source.indexOf('/>', at) + 2);
    assert.match(open, /^<AgentLink\b/, `${file}: ${label} is an AgentLink`);
    assert.doesNotMatch(open, /\s(?:icon|iconEnd)=/, `${file}: ${label} takes AgentLink's own look`);
  }
});

test('5: 去原文看这段 under a retelling ends in → with nothing in front, like 看原文 and a citation card', async () => {
  const source = await read('ui/review/RetellPanel.jsx');
  const button = buttonElements(source).find(({ children }) => children.includes('去原文看这段'));
  assert.match(button.open, ARROW_END);
  assert.doesNotMatch(button.open, /\sicon=/);
});

/* ---- 3: English counts say "1 question", never "question(s)"------------------------------------------------------------------------------------------- */

const englishCatalogue = async () => {
  const catalogue = {}, fileOf = {};
  for (const name of (await readdir(new URL('../ui/locales/', import.meta.url))).filter((entry) => /^en(?:\..+)?\.json$/.test(entry)).sort()) {
    for (const [key, value] of Object.entries(JSON.parse(await read(`ui/locales/${name}`)))) if (!Object.hasOwn(catalogue, key)) { catalogue[key] = value; fileOf[key] = name; }
  }
  return { catalogue, fileOf };
};
/** The screens a learner meets every day: home and the study map, deck rows, practice and review, the wrong book, materials, generating and its draft, jobs,
    notes, the today board and the book. A count on them says "1 question". */
const FREQUENT = /^ui\/(?:StudyMap|study-map\/|Dashboard|charts\/Dashboard|DailyPlan|daily-plan\/|first-run\/|DeckRow|deck-|ArchivedDeckRow|EmptyStudyActions|Review|review\/|QuestionRun|practice|WrongBook|wrongbook|Sources|sources\/|source-|Generate|generate|GenerationPath|GenerationTrace|generation-status|TooBigChoice|ReferenceQuestions|Draft\.jsx|IndexBadge|ImportHub|tasks\/|job-visibility|Notes|BlogNotes|notes\/|app\/page-views|app\/use-drafts|app\/AppBanners|board\/|book\/|exam\/|ResultBreakdown|Manage\.jsx|RemoveDeckDialog|Skeleton|OralExam|audio\/AudioCorrections)/;
/** Counts on those screens left plural, and why: a limit or a threshold the app sets is never 1. */
const PLURAL_LEFT = [
  { key: '标题请控制在 {0} 字以内，更多内容写在下一行作为备注。', why: 'the length limit of a to-do title, a constant far above 1' },
  { key: '默认 {0} 个片段 / {1} 字符；可调整，最高 {2} 个片段 / {3} 字符。', why: 'the default and the most of the reference excerpts, constants above 1' },
  { key: '先提取知识点和逐字原文，再确定答案、必要情景和选项依据；每批最多 {0} 题，出题与自查后独立审阅，通过的题保留在草稿。', why: 'the batch size of a generation, a constant above 1' },
  { key: '最长 {0} 分钟（不算排队）；到时会停止，已通过检查的题保留在草稿里。', why: 'the time limit of a generation, a constant above 1' },
  { key: '最长 {0} 分钟（不算排队）；到时会停止，题组不会有变化。', why: 'the time limit of a top-up, a constant above 1' },
  { key: '每个阶段最多等待 {0} 分钟。', why: 'the wait limit of a stage, a constant above 1' },
  { key: '所选资料约 {0} 页、{1} 个字符，一次生成最多 {2} 个字符。', why: 'shown only when the selection is too big for one generation: thousands of characters' },
  { key: '所选资料约 {0} 个字符，一次生成最多 {1} 个字符。', why: 'shown only when the selection is too big for one generation: thousands of characters' },
  { key: '共 {0} 种题型，但只有 {1} 题：前 {1} 种题型各出 1 道，其余这次不出。', why: 'shown only when there are more question types than questions, so at least 2 types ({1} has its singular)' },
  { key: 'PDF 超过 {0} 页。请按章节拆分后再导入。', why: 'the page limit of an import, a constant in the hundreds' },
  { key: '提取出的文字超过 {0} 字符。请按章节拆分后再导入。', why: 'the text limit of an import, a constant in the hundreds of thousands' },
  { key: '⋯ 差异较长，仅展示前 {0} 行对比', why: 'the cut of a long diff, a constant above 1' },
  { key: '明显偏久：用时超过同类已完成步骤中位数的 {0} 倍，并且超过 {1} 分钟（同类还没有完成的步骤时，只看 {1} 分钟）。', why: '{0} is the factor of the rule (3), not a count; {1} has its singular' },
  { key: '累计答错 {0} 次，或最近 {1} 次作答里答错 {2} 次以上（{3}%；作答不满 {1} 次时也这样算）。', why: 'the 顽固题 thresholds: lib/practice-settings.js keeps failures ≥ 2 and the window ≥ 3' },
  { key: '最近 {0} 次全部答对后，这个标记就会消失。题目本身也可能有问题：展开这一行，有几个办法。', why: 'the 顽固题 window: lib/practice-settings.js keeps it ≥ 3' },
  { key: '这一组有 {0} 道题，一次最多 {1} 道：先练前 {1} 道。', why: 'shown only when the group has more questions than a round takes, so far more than one' },
  { key: '共选了 {0} 道题，一次最多 {1} 道：先练前 {1} 道。', why: 'shown only when more questions are selected than a round takes, so far more than one' },
];
/** Elsewhere (settings, converters and installers, the reader's tools, the book planner, coverage diagnostics, agent prompts) counts still plural, by catalogue: a
    ratchet, each number only shrinks as those screens are touched. Round 8 started at 235 of them (and 106 "noun(s)" everywhere, now none). */
const LEFT_ELSEWHERE = { 'en.agent.json': 13, 'en.audio-pipeline.json': 1, 'en.audio.json': 7, 'en.book-pick.json': 4, 'en.case.json': 6, 'en.coach.json': 1, 'en.companions.json': 1,
  'en.course.json': 5, 'en.coverage.json': 34, 'en.custom-plan.json': 6, 'en.custom.json': 5, 'en.delete.json': 1, 'en.exam-prep-settings.json': 2, 'en.exam-prep.json': 3,
  'en.exam.json': 1, 'en.flow.json': 2, 'en.focus.json': 8, 'en.frequency.json': 2, 'en.generate-short.json': 3, 'en.generation-settings.json': 1, 'en.guided.json': 1,
  'en.import.json': 3, 'en.jev.json': 2, 'en.json': 2, 'en.largedocs.json': 26, 'en.loop.json': 12, 'en.materials.json': 3, 'en.mineru.json': 14, 'en.original.json': 4,
  'en.outline.json': 6, 'en.pages.json': 1, 'en.peek.json': 1, 'en.polish-reader.json': 1, 'en.practice.json': 4, 'en.reader.json': 13, 'en.selection.json': 12,
  'en.shared.json': 8, 'en.shell.json': 1, 'en.tiers.json': 4, 'en.translation.json': 4, 'en.usage.json': 4, 'en.wave5a.json': 2, 'en.web-gemini.json': 1 };

test('3: the gate finds a count with a plural noun anywhere in the value, the whole of a fraction, and no range', () => {
  assert.deepEqual(countedNouns('Removed {1} unanswered questions on p. {0} and later'), [{ index: 1, noun: 'questions' }]);
  assert.deepEqual(countedNouns('At about {0} minutes per mark, allow {1} minutes of writing'), [{ index: 0, noun: 'minutes' }, { index: 1, noun: 'minutes' }]);
  assert.deepEqual(countedNouns('Index built · {0}/{1} pages'), [{ index: 1, noun: 'pages' }], 'the noun of a fraction counts the whole');
  assert.deepEqual(countedNouns('Window {0} started: pages {1}–{2} ({3} pages)').map(({ index }) => index), [3]);
  assert.deepEqual(countedNouns('{0} file(s) were not added'), [{ index: 0, noun: 'file(s)' }]);
  assert.deepEqual(countedNouns('{0} is ready · {1} needs a look'), [], 'a verb after a count is not a plural');
  const catalogue = { 'k': '{0} questions · about {1} minutes', 'k#one': '{0} question · about {1} minutes' };
  assert.deepEqual(missingSingulars(catalogue, 'k'), [1, '0,1'], 'each count its singular, and both together');
});

test('3: no English value writes "noun(s)"', async () => {
  const { catalogue, fileOf } = await englishCatalogue();
  assert.deepEqual(Object.entries(catalogue).filter(([, value]) => typeof value === 'string' && /\w\(s\)/.test(value)).map(([key, value]) => `${fileOf[key]}: ${value}`), []);
});

test('3: on the frequent screens every count with a plural noun has its singular, or is listed with why; elsewhere the number left only shrinks', async () => {
  const { catalogue, fileOf } = await englishCatalogue();
  const sources = await uiSources();
  const usedBy = (key) => sources.filter(({ source }) => source.includes(key)).map(({ file }) => file);
  const missing = [], elsewhere = {};
  for (const [key, value] of Object.entries(catalogue)) {
    if (SINGULAR_KEY.test(key) || typeof value !== 'string' || !missingSingulars(catalogue, key).length) continue;
    if (usedBy(key).some((file) => FREQUENT.test(file))) { if (!PLURAL_LEFT.some((entry) => entry.key === key)) missing.push(`${fileOf[key]}: ${key} → ${value}`); }
    else elsewhere[fileOf[key]] = (elsewhere[fileOf[key]] || 0) + 1;
  }
  assert.deepEqual(missing, []);
  for (const entry of PLURAL_LEFT) {
    assert.ok(Object.hasOwn(catalogue, entry.key), `${entry.key}: still in the catalogue`);
    assert.ok(missingSingulars(catalogue, entry.key).length, `${entry.key}: has its singulars now, so it leaves the list`);
    assert.ok(entry.why.length > 15, `${entry.key}: say why`);
  }
  for (const [name, count] of Object.entries(elsewhere)) assert.ok(count <= (LEFT_ELSEWHERE[name] ?? 0), `${name}: ${count} plural counts without a singular (at most ${LEFT_ELSEWHERE[name] ?? 0})`);
  for (const key of Object.keys(catalogue).filter((name) => SINGULAR_KEY.test(name))) {
    const plural = key.replace(SINGULAR_KEY, '');
    assert.ok(Object.hasOwn(catalogue, plural), `${key}: the plural it is the singular of`);
    for (const index of (/#one:([\d,]+)$/.exec(key)?.[1] ?? '0').split(',')) assert.ok(catalogue[key].includes(`{${index}}`), `${key}: says the count {${index}}`);
  }
});

test('3: uiFormat and uiRich take the singular of the count that is 1, wherever it stands; "Practise" is the verb', async () => {
  const { catalogue } = await englishCatalogue();
  assert.equal(catalogue['重练这 {0} 道错题'], 'Practise these {0} missed questions');
  assert.equal(catalogue['重练这 {0} 道错题#one'], 'Practise this {0} missed question');
  const { setUiLanguage, uiFormat, uiRich } = await loadUi("export { setUiLanguage, uiFormat } from './ui/i18n.js'; export { uiRich } from './ui/i18n-rich.jsx';");
  setUiLanguage('en');
  try {
    assert.equal(uiFormat('答错 {0} 次', [1]), 'Missed 1 time', 'the wrong book row');
    assert.equal(uiFormat('答错 {0} 次', [3]), 'Missed 3 times');
    assert.equal(uiFormat('已从本轮移出第 {0} 页及之后的 {1} 道未答题，题库中仍保留。', [4, 1]), 'Removed 1 unanswered question on p. 4 and later from this round; it stays in your deck.');
    assert.equal(uiFormat('{0} 个活跃日 · 累计作答 {1} 次', [1, 1]), '1 active day · 1 attempt in total', 'both counts are 1');
    assert.equal(uiFormat('{0} 个活跃日 · 累计作答 {1} 次', [2, 1]), '2 active days · 1 attempt in total');
    assert.equal(uiFormat('{0} 个活跃日 · 累计作答 {1} 次', [1, 5]), '1 active day · 5 attempts in total');
    assert.equal(uiFormat('{0} 个活跃日 · 累计作答 {1} 次', [3, 5]), '3 active days · 5 attempts in total');
    const words = (parts) => parts.map((part) => typeof part === 'string' ? part : String(part.props.children.props?.children ?? part.props.children)).join('');
    assert.equal(words(uiRich('累计作答 {0} 次', React.createElement('b', null, 1))), '1 attempt in total', 'a count inside an element');
  } finally { setUiLanguage('zh'); }
});
