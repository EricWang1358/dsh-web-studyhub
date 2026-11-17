import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { IN_PLACE, LEAVES_WITHOUT_ARROW, actionProblems, buttonElements, clickDoes, externalProblems, goOnProblems, labelHelpers, labelsOf, localHandlers,
  propOf, specProblems, varsOf } from './helpers/go-on.mjs';

/* #1073, round 7 of the review of PR #1118 (the round-6 review, beea14c6): the gate reads what it skipped (the round's next step, a host call that starts a run, a
   long handler, a form's submit), a way back is a way back whatever its click, the reader of StudyHub is a place (→), not a window outside (external), a pager steps
   on with →, and the English counts say "1 deck". The browser half (the citation card's arrow, the first-run model line, the narrow ▶'s focus) is
   tests/icon-round7-browser.test.mjs. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ARROW_END = /\biconEnd=(?:"arrow-right"|\{[^}]*arrow-right)/;
const all = async () => {
  const sources = await uiSources();
  return { sources, byFile: new Map(sources.map(({ file, source }) => [file, source])), helpers: labelHelpers(sources) };
};
/** The opening tags of the Buttons of `file` whose words match `label`. */
function buttonsOf(source, label, helpers) {
  const vars = varsOf(source);
  return buttonElements(source).filter(({ children }) => labelsOf(children, helpers, vars).some((words) => label.test(words)));
}

/* ---- 1: the round's next step is a spec; a way back among them leads with ← ------------------------------------------------------------------------------- */

test('1: a next-step spec { label, run } whose words are a way back says `back`, and the Button that draws the specs follows it', () => {
  const file = 'ui/Review.jsx';
  assert.equal(specProblems('const s = { label: ui("回到学习流"), run: () => onBackToWorkflow(id) };', { file }).length, 1, 'a way back without `back`');
  assert.equal(specProblems('const s = { label: ui("回到学习流"), run: () => onBackToWorkflow(id), back: true };', { file }).length, 0);
  assert.equal(specProblems('const s = { label: ui("继续下一批新题"), run: () => go(), back: false };\n<Button iconEnd="arrow-right" onClick={onward.run}>{onward.label}</Button>', { file }).length, 1,
    'the specs say `back`, so the Button that draws {onward.label} reads it rather than always ending in →');
  assert.equal(specProblems('const s = { label: ui("继续下一批新题"), run: () => go(), back: false };\n<Button icon={onward.back ? "arrow-left" : undefined} iconEnd={onward.back ? undefined : "arrow-right"} onClick={onward.run}>{onward.label}</Button>', { file }).length, 0);
});

test('1: the round result page draws 回到学习路径 / 回到原题 / 回到学习流 / 回到之前的第 N 题 with ← in front, never →', async () => {
  const source = await read('ui/Review.jsx');
  assert.deepEqual(specProblems(source, { file: 'ui/Review.jsx' }), []);
  const onward = buttonElements(source).find(({ children }) => children.trim() === '{onward.label}');
  assert.ok(onward, 'the onward Button');
  assert.match(onward.open, /icon=\{onward\.back \? "arrow-left"/, 'leads with ← when it goes back');
  assert.match(onward.open, /iconEnd=\{onward\.back \? undefined : "arrow-right"\}/, 'ends in → only when it goes on');
  for (const words of [/ui\("回到学习流"\), run: [^}]*back: true/, /uiFormat\("回到之前的第 \{0\} 题", \[[^\]]*\]\), run: [^}]*back: true/,
    /destination\?\.kind === "original" \? \{ label: destination\.label, run: destination\.go, back: true \}/]) assert.match(source, words);
});

/* ---- 2: what the gate skipped ------------------------------------------------------------------------------------------------------------------------------ */

test('2: a long handler of the page is read through its whole body, not given up on', () => {
  const body = `const loadAndGo = async () => {\n${'  setBusy(true); await call("x.load", { id, other: value, more: values });\n'.repeat(6)}  navigate("library");\n};`;
  assert.ok(body.length > 300);
  assert.equal(clickDoes('loadAndGo', localHandlers(body)), 'leave');
  const form = '<form onSubmit={(event) => { event.preventDefault(); navigate("library"); }}>\n<Button type="submit">{ui("保存并返回")}</Button>\n</form>';
  assert.equal(goOnProblems(form).length, 1, 'a submit is read through its form\'s onSubmit: this one is a way back without ←');
});

test('2: a host call that starts a practice run (call(\'review.start\') then enterRun) leaves: 闪回练一下这道题 ends in →', async () => {
  const { byFile, helpers } = await all();
  const source = byFile.get('ui/companions/CompanionViewer.jsx');
  assert.equal(clickDoes('() => practicePrereqCard(card)', localHandlers(source)), 'leave');
  const found = buttonsOf(source, /^闪回练一下这道题$/, helpers);
  assert.equal(found.length, 1);
  assert.match(found[0].open, ARROW_END);
});

test('2: 在练习页看结果 leaves the reader for the practice page: it ends in →, and its prop says so', async () => {
  const { byFile, helpers } = await all();
  const source = byFile.get('ui/review/InlineRun.jsx');
  for (const label of [/^在练习页看结果$/, /^去练习页继续$/]) {
    const [button] = buttonsOf(source, label, helpers);
    assert.match(button.open, ARROW_END, String(label));
    assert.equal(clickDoes(propOf(button.open, 'onClick'), localHandlers(source)), 'leave', String(label));
  }
});

test('2: a way back is a way back whatever its click: 返回文件导入 leads with ←', async () => {
  assert.equal(goOnProblems('<Button variant="link" onClick={() => { setOpen(false); setFile(null); }}>{ui("返回文件导入")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button variant="link" icon="arrow-left" onClick={() => { setOpen(false); setFile(null); }}>{ui("返回文件导入")}</Button>').length, 0);
  const { byFile, helpers } = await all();
  const [button] = buttonsOf(byFile.get('ui/ImportHub.jsx'), /^返回文件导入$/, helpers);
  assert.match(button.open, /\sicon="arrow-left"/);
});

test('2: the live class\'s 选中内容出题 / 保存为资料 / 校对后保存 start a job and stay; only the capture controls are listed in place', async () => {
  const source = await read('ui/LiveClass.jsx'), locals = localHandlers(source), { helpers } = await all();
  for (const label of [/^选中内容出题$/, /^保存为资料$/, /^校对后保存$/]) {
    const [button] = buttonsOf(source, label, helpers);
    assert.equal(clickDoes(propOf(button.open, 'onClick'), locals), 'here', String(label));
    assert.doesNotMatch(button.open, ARROW_END, String(label));
  }
  const live = IN_PLACE.filter((entry) => entry.file === 'ui/LiveClass.jsx' && entry.handler);
  assert.ok(live.length && live.every((entry) => !/perform/.test(entry.handler)), 'the entry names the capture controls, not every perform()');
  assert.doesNotMatch(await read('ui/App.jsx'), /\bonJobs=/, 'the live class\'s refresh after a queued job is not named like a way to the 任务 page');
});

test('2: 按校准方案立即出题 starts the generation and then opens 任务 (onOpenTasks): its click leaves, so it keeps →', async () => {
  const source = await read('ui/ExamCoachPage.jsx');
  assert.equal(clickDoes('handleDirectGenerate', localHandlers(source)), 'leave');
  const { helpers } = await all();
  assert.match(buttonsOf(source, /^按校准方案立即出题$/, helpers)[0].open, ARROW_END);
});

/* ---- 3: StudyHub's own reader is a place (→); `external` is a window outside ----------------------------------------------------------------------------- */

test('3: `external` only marks a window outside StudyHub, and a control that opens the reader at a quote or a page ends in → with nothing in front', async () => {
  assert.equal(goOnProblems('<Button icon="external" onClick={() => onOpenSource(id, quote)}>{ui("看原页")}</Button>').length, 1, 'the reader is StudyHub\'s own');
  assert.equal(goOnProblems('<Button icon="file" onClick={() => onOpen(found.source, found.quote, found.page)}>{ui("看原页图")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button iconEnd="arrow-right" onClick={() => onOpenSource(id, quote)}>{ui("看原页")}</Button>').length, 0);
  assert.equal(externalProblems('<IconButton icon="external" label={ui("大窗打开阅读器")} onClick={() => onExpand(place)} />').length, 1);
  assert.equal(externalProblems('<IconButton icon="external" label={ui("在浏览器中打开")} onClick={() => host.openFile(file)} />').length, 0);
  assert.equal(externalProblems("items.push({ id: 'x', icon: 'external', label: ui('看原文'), run: handlers.seek });").length, 1);
  assert.equal(externalProblems('<a href={url} target="_blank" rel="noreferrer">{ui("查看发布页")}<Icon className="sh-icon--inline" name="external" /></a>').length, 0);
  const { byFile, helpers } = await all();
  const want = [['ui/CitationDisclosure.jsx', /资料|看原页/], ['ui/book/BookLinks.jsx', null], ['ui/book/BookQa.jsx', /^看原文$/], ['ui/exam-prep/PointTree.jsx', /^看原(?:题|页)$/],
    ['ui/outline/LeafNotes.jsx', null], ['ui/Draft.jsx', /^原文$/], ['ui/document-preview/practice/FigurePageLink.jsx', /^看原页图$/], ['ui/document-preview/reader/WrongPanel.jsx', /^看原文$/]];
  for (const [file, label] of want) {
    const source = byFile.get(file);
    const found = label ? buttonsOf(source, label, helpers) : buttonElements(source).filter(({ open }) => /onSource|onOpenSource/.test(propOf(open, 'onClick')));
    assert.ok(found.length, `${file}: ${label}`);
    for (const { open, children } of found) {
      assert.match(open, ARROW_END, `${file}: ${label} opens the reader: →`);
      assert.doesNotMatch(open + children.slice(0, 120), /icon="(?:external|file)"|name="external"/, `${file}: ${label} has nothing in front`);
    }
  }
  for (const file of ['ui/tasks/GenerationParts.jsx', 'ui/review/SourceColumn.jsx']) assert.doesNotMatch(byFile.get(file), /icon="external"/, `${file}: an icon-only way into the reader is not external`);
  const sources = (await uiSources()).flatMap(({ file, source }) => externalProblems(source, { file }).map((problem) => `${file}: ${problem.label} ${problem.want}`));
  assert.deepEqual(sources, []);
  assert.match(await read('ui/DESIGN.md'), /StudyHub's own reader/);
});

test('3/4: the citation card is not exempt from the Button\'s flex any more', async () => {
  assert.doesNotMatch(await read('tests/icon-round4.test.mjs'), /citations__button/);
  assert.doesNotMatch((await read('ui/review/question.css')).match(/\.citations \.citations__button \{[^}]*\}/)[0], /display:\s*block/);
});

/* ---- 5: a pager steps on with → (and back with ←) ------------------------------------------------------------------------------------------------------- */

test('5: a control that steps through the same content (下一题, 下一个知识点, 下一页, 跳至第 N 页) ends in →, its twin backwards leads with ←', async () => {
  assert.equal(goOnProblems('<Button onClick={() => onPage(page + 1)}>{ui("下一页")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button iconEnd="arrow-right" onClick={() => onPage(page + 1)}>{ui("下一页")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button onClick={() => onPage(page - 1)}>{ui("上一页")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button icon="arrow-left" onClick={() => onPage(page - 1)}>{ui("上一页")}</Button>').length, 0);
  assert.ok(!LEAVES_WITHOUT_ARROW.some((entry) => entry.file === 'ui/book/BookStep.jsx'), 'the book\'s pager is not an exception any more');
  const { byFile, helpers } = await all();
  for (const [file, label] of [['ui/book/BookStep.jsx', /^下一个知识点$/], ['ui/WrongBook.jsx', /^下一页$/], ['ui/Exam.jsx', /^下一题$/], ['ui/ReviewToolbar.jsx', /^下一题$/],
    ['ui/companions/CompanionViewer.jsx', /^跳至第 \{0\} 页$/]]) {
    const found = buttonsOf(byFile.get(file), label, helpers);
    assert.ok(found.length, `${file}: ${label}`);
    for (const { open } of found) assert.match(open, ARROW_END, `${file}: ${label}`);
  }
  for (const [file, label] of [['ui/book/BookStep.jsx', /^上一个知识点$/], ['ui/WrongBook.jsx', /^上一页$/], ['ui/Exam.jsx', /^上一题$/], ['ui/ReviewToolbar.jsx', /^上一题$/]]) {
    for (const { open } of buttonsOf(byFile.get(file), label, helpers)) assert.match(open, /\sicon="arrow-left"/, `${file}: ${label}`);
  }
  assert.match(await read('ui/DESIGN.md'), /pager[^.]*下一个知识点/);
});

/* ---- the whole of ui/ ---------------------------------------------------------------------------------------------------------------------------------------- */

test('the whole of ui/ agrees with the rule, and far fewer Buttons are left to their words', async () => {
  const { sources, helpers } = await all();
  const seen = {}, used = new Set(), found = [];
  for (const { file, source } of sources) {
    for (const { label, open, want } of goOnProblems(source, { file, helpers, used, seen })) found.push(`${file}: ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of actionProblems(source, { file, helpers, used, seen })) found.push(`${file}: action ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of specProblems(source, { file })) found.push(`${file}: spec ${label} wants ${want}  ${open.slice(0, 80)}`);
  }
  assert.deepEqual(found, []);
  // Round 6 left 648 Buttons with words to their words (the review's scan: 442 of them with no icon at all); round 7 reads 323. A ratchet: it only goes down.
  // What is left: props whose name says nothing (onStart, onGenerate, onAction, onNext, onRun, ...), Menu triggers spread in with no click to read, and host calls.
  assert.ok(seen.unknown <= 323, `the click decides for most Buttons (${JSON.stringify(seen)})`);
});

/* ---- 6: the first-run model line --------------------------------------------------------------------------------------------------------------------------- */

test('6: the first-run model line shows the whole id in the shared Tooltip (never title=), and the provider keeps its separator', async () => {
  const source = await read('ui/first-run/FirstRunLine.jsx');
  assert.match(source, /<Tooltip\b[^>]*content=\{[^}]*label/, 'a Tooltip with the model label');
  assert.doesNotMatch(source, /frl-step__text[^>]*\stitle=/);
  const { firstRunModelLabel } = await loadUi("export { modelLabelParts as firstRunModelLabel } from './ui/first-run/FirstRunLine.jsx';");
  assert.deepEqual(firstRunModelLabel('SiliconFlow · Qwen/Qwen3-235B-A22B-Instruct-2507'), { provider: 'SiliconFlow ·', id: 'Qwen/Qwen3-235B-A22B-Instruct-2507' });
  assert.deepEqual(firstRunModelLabel('fake-model'), { provider: '', id: 'fake-model' });
});

/* ---- 8: English singulars ------------------------------------------------------------------------------------------------------------------------------- */

/** The English counts that keep one form, each with why (filled as the singulars are written). */
// Round 7 wrote 185 singulars; these 11 stay plural.
const SINGULAR_LEFT = [
  { key: '{0} 等 {1} 个', why: '{0} is the first name of a list, not a count' },
  { key: '选了 {0} 份资料，{1} 份会出题，{2} 份不会：{3}{4}', why: 'shown only when some materials get questions and some do not, so at least 2 are selected' },
  { key: '选了 {0} 份，{1} 份已出题，{2} 份没出题', why: 'shown only when some materials have questions and some do not, so at least 2 are selected' },
  { key: '分 {0} 轮；这次先出第 1 轮（约 {1} 题），其余 {2} 轮会自动接着做，可以在「任务」里暂停或停下。', why: 'shown only when a generation is split into rounds, so at least 2 rounds' },
  { key: '分 {0} 轮；这次只出第 1 轮（约 {1} 题），其余 {2} 轮要到草稿页点「为没覆盖的部分补题」，一次补一轮。', why: 'shown only when a generation is split into rounds, so at least 2 rounds' },
  { key: '分 {0} 轮；这次先出第 1 轮（约 {1} 题）。', why: 'shown only when a generation is split into rounds, so at least 2 rounds' },
  { key: '已出过题的 {0} 份', why: '{0} counts materials and "questions" is not what it counts: "1 with questions already" is right' },
  { key: '共 {0} 种题型，但只有 {1} 题：前 {1} 种题型各出 1 道，其余这次不出。', why: 'shown only when there are more question types than questions, so at least 2 types' },
  { key: '共 {0} 题，一轮最多 {1} 题：先练到期、薄弱和新题里排在前面的 {1} 题。', why: 'shown only when there are more questions than a round takes, so far more than one' },
  { key: '{0} 等 {1} 份', why: '{0} is the first name of a list, not a count' },
  { key: '共选了 {0} 道题，一次最多 {1} 道：先练前 {1} 道。', why: 'shown only when more questions are selected than a round takes, so far more than one' },
];

const NOUN = /^\{0\} (?:[a-z-]+ )?([A-Za-z]+s)\b/;
const NOT_PLURAL = new Set(['is', 'was', 'has', 'does', 'its', 'this', 'appears', 'needs']);

test('8: every English count that leads with {0} and a plural noun has a singular (`#one`), or is listed with why', async () => {
  const catalogue = {};
  for (const name of (await readdir(new URL('../ui/locales/', import.meta.url))).filter((entry) => /^en(?:\..+)?\.json$/.test(entry))) Object.assign(catalogue, JSON.parse(await read(`ui/locales/${name}`)));
  const missing = [];
  for (const [key, value] of Object.entries(catalogue)) {
    if (/#one(?::[\d,]+)?$/.test(key) || typeof value !== 'string') continue; // round 8: `#one:N` is the singular of the count {N}
    const noun = NOUN.exec(value)?.[1];
    if (!noun || NOT_PLURAL.has(noun.toLowerCase())) continue;
    if (!Object.hasOwn(catalogue, `${key}#one`) && !SINGULAR_LEFT.some((entry) => entry.key === key)) missing.push(`${key} → ${value}`);
  }
  assert.deepEqual(missing, []);
  for (const entry of SINGULAR_LEFT) {
    assert.ok(Object.hasOwn(catalogue, entry.key), `${entry.key}: still in the catalogue`);
    assert.ok(entry.why.length > 15, `${entry.key}: say why`);
  }
  for (const key of Object.keys(catalogue).filter((name) => name.endsWith('#one'))) {
    assert.ok(Object.hasOwn(catalogue, key.slice(0, -4)), `${key}: the plural it is the singular of`);
    assert.match(catalogue[key], /\{0\}/, `${key}: says the count`);
  }
  const { setUiLanguage, uiFormat } = await loadUi("export { setUiLanguage, uiFormat } from './ui/i18n.js';");
  setUiLanguage('en');
  try {
    assert.equal(uiFormat('{0} 个题组', [1]), '1 deck');
    assert.equal(uiFormat('{0} 道题 · 共 {1} 分 · 建议作答约 {2} 分钟', [1, 4, 5]), '1 question · 4 marks · about 5 min of writing');
    assert.equal(uiFormat('{0} 个任务正在进行', [1]), '1 job running');
    assert.equal(uiFormat('{0} 个任务正在进行', [2]), '2 jobs running');
    assert.equal(uiFormat('· {0} 条', [1]), '· 1 citation', 'the count of citations under an answer');
  } finally { setUiLanguage('zh'); }
});
