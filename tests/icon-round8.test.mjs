import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { actionProblems, buttonElements, clickDoes, goOnProblems, labelHelpers, labelsOf, localHandlers, propOf, specProblems, varsOf, wiringOf } from './helpers/go-on.mjs';

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
