/* 复习全书 M6 (docs/plans/review-book.md): the 查找页 and the export as the learner's printable CP. The lookup (目录 with codes, 按题型 = the 速查表,
   按概念, 易错点) is generated from the book, its codes stable after sections are inserted or moved (I4); the export is deterministic (a golden file),
   its markers out, its question links numbered (a deleted question and the practice / Q&A links dropped), its footnotes named per file, noprint left
   out, its 答案册 under the same numbers, the folder's files joined the single text, and Pandoc reads both when it is installed (I10). No model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { exportBook as runExport, estimatePages, PAGE_RULE } from '../lib/course-book-export.js';
import { bookLookup, codeOf, definedTerms, renderLookup, withoutNoprint } from '../lib/course-book-lookup.js';
import { courseBookExport } from '../lib/course-book-export-op.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { mergeBookSettings, resolveBookSettings } from '../lib/book-settings.js';
import { CASE_TYPES, typeText } from '../lib/case-types.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { cardOf, exportBook, answerCard } from './helpers/course-book-export-book.mjs';

const golden = mode => fileURLToPath(new URL(`./fixtures/course-book-export${mode === 'linked' ? '' : `-${mode}`}.golden.md`, import.meta.url));
const numbersIn = text => [...text.matchAll(/\*\*(H\d+-Q\d+|U-Q\d+)\*\*/g)].map(match => match[1]);

test('the export is deterministic: a golden file per question mode (linked, all, none), byte for byte; the folder\'s files joined are the single text', async () => {
  for (const questions of ['linked', 'all', 'none']) {
    const done = runExport(exportBook(), { cardOf, answerKey: true, questions });
    assert.equal(runExport(exportBook(), { cardOf, answerKey: true, questions }).text, done.text, `${questions}: same book, same bytes`);
    if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden(questions), done.text);
    assert.equal(done.text, (await readFile(golden(questions), 'utf8')).replace(/\r\n/g, '\n'), `${questions}: the golden export (UPDATE_GOLDEN=1 writes it again)`);
    assert.equal(done.questionMode, questions);
    assert.equal(runExport(exportBook(), { cardOf, answerKey: true, questions, form: 'folder' }).files.map(file => file.text).join('\n'), done.text);
  }
  assert.equal(runExport(exportBook(), { cardOf }).questionMode, 'linked', 'linked by default');
  assert.throws(() => runExport(exportBook(), { cardOf, questions: 'some' }), /questions must be one of/);
  const single = runExport(exportBook(), { cardOf, answerKey: true, questions: 'all' });
  assert.equal(single.filename, '复习全书-SA-含答案册.md');
  const folder = runExport(exportBook(), { cardOf, answerKey: true, form: 'folder', questions: 'all' });
  assert.equal(folder.files.map(file => file.text).join('\n'), single.text);
  assert.deepEqual(folder.files.map(file => file.name), ['000-front.md', '001-h2.gen.md', '002-h2.mine.md', '003-h2.qa.md', '004-h3.gen.md', '005-unplaced.md', '006-answers.md']);
  assert.equal(folder.manifest.name, 'book.yaml');
  assert.deepEqual([...folder.manifest.text.matchAll(/^ {2}- (.+)$/gm)].map(match => match[1]), folder.files.map(file => file.name), 'the ordered file list');
  assert.match(folder.manifest.text, /^title: "复习全书 · SA"$/m);
  const plain = runExport(exportBook(), { cardOf, questions: 'all' });
  assert.doesNotMatch(plain.text, /答案册/, 'no answer key unless asked');
  assert.equal(plain.filename, '复习全书-SA.md');
  assert.ok(single.text.startsWith(plain.text.trimEnd()), 'the answer key comes last');
});

test('questions: linked prints only the linked ones (numbered as they appear, options the first time), none prints none; the key and the estimate follow', () => {
  const linked = runExport(exportBook(), { cardOf, answerKey: true }), all = runExport(exportBook(), { cardOf, answerKey: true, questions: 'all' });
  const none = runExport(exportBook(), { cardOf, answerKey: true, questions: 'none' });
  assert.doesNotMatch(linked.text, /本节的题|一个系统由两台/, 'linked: no point\'s own list, the unlinked question not printed');
  assert.match(linked.text, /^- 另见 \*\*H2-Q1\*\* Fill the blank\./m, 'linked: numbered in the order the links appear');
  assert.match(linked.text, /^- \*\*H2-Q2\*\* Which is right\?\n {2}- A\. Add them\n {2}- B\. Multiply them\n {2}- C\. Average them$/m, 'linked: the options the first time');
  const [body, key] = linked.text.split('## 答案册 {#answers}');
  assert.deepEqual([...new Set(numbersIn(key))], ['H2-Q1', 'H2-Q2'], 'the key has exactly the printed questions');
  assert.deepEqual([...new Set(numbersIn(body))], ['H2-Q1', 'H2-Q2']);
  assert.equal(linked.questions, 2);
  assert.deepEqual(numbersIn(none.text), [], 'none: no numbered question anywhere');
  assert.doesNotMatch(none.text, /Which is right|Fill the blank/);
  assert.match(none.text, /## 答案册 \{#answers\}\n\n这本书里没有题。/);
  assert.equal(none.questions, 0);
  assert.equal(all.questions, 3);
  assert.ok(none.text.length < linked.text.length && linked.text.length < all.text.length, 'each mode prints less than the next');
  assert.ok(none.estimate.withAnswers <= linked.estimate.withAnswers && linked.estimate.withAnswers <= all.estimate.withAnswers, 'the estimate follows');
});

test('a zh export has no English text of the built-in question types; an en one has no Chinese; a course\'s own type stays as written', () => {
  // (a formula of symbols only, such as A = MTBF / (MTBF + MTTR), reads the same in both)
  const english = CASE_TYPES.flatMap(type => [...type.steps, ...(type.formulas || []), ...(type.mistakes || [])]).filter(text => /\b[a-z]{3,}\b/.test(text));
  const zh = runExport(exportBook(), { cardOf }).text, row = zh.split('\n').find(line => line.startsWith('| **可用性**'));
  for (const text of english) assert.ok(!zh.includes(text), `zh: no "${text}"`);
  assert.doesNotMatch(row, /\b[a-z]{3,}\b/, `zh: no English word in the 速查表 row: ${row}`);
  assert.match(row, /串联时把可用性相加/);
  const en = runExport({ ...exportBook(), language: 'en' }, { cardOf }).text, enRow = en.split('\n').find(line => line.startsWith('| **Availability**'));
  assert.ok(enRow.includes('Adding availabilities instead of multiplying them in series'));
  assert.doesNotMatch(enRow.replace(/把串联的可用性相加|多一台服务器的费用。/g, ''), /[一-鿿]/, 'en: the type in English (the card\'s own words aside)');
  const own = { id: 'availability', label: '可用性', signals: ['uptime'], steps: ['My own step'], mistakes: ['My own mistake'], own: true };
  assert.deepEqual(typeText(own, 'zh'), { steps: ['My own step'], formulas: [], mistakes: ['My own mistake'], signals: ['uptime'] }, 'a course\'s own type as written');
});

test('markers out, ids as anchors and margin codes, links resolved: numbered questions with their options once, a deleted question and practice / Q&A links dropped', () => {
  const { text } = runExport(exportBook(), { cardOf, answerKey: true, questions: 'all' });
  assert.doesNotMatch(text, /<!--/, 'no marker comment is left');
  assert.doesNotMatch(text, /studyhub:\/\//, 'no studyhub link is left');
  assert.doesNotMatch(text, /\[\[|\]\]/, '[[term]] is the term');
  assert.match(text, /^### 1\.1 Availability 〔H2〕 \{#h2\}$/m);
  assert.match(text, /^#### 我的推导 〔H9〕 \{#h9\}$/m, 'a typed heading keeps its id as an anchor, under its point');
  assert.match(text, /^\*\*本节的题\*\*\n\n- \*\*H2-Q1\*\* Which is right\?\n {2}- A\. Add them\n {2}- B\. Multiply them\n {2}- C\. Average them\n- \*\*H2-Q2\*\* 一个系统/m, 'the point\'s own questions first, options as items');
  assert.match(text, /^- 另见 \*\*H2-Q3\*\* Fill the blank\. A = MTBF \/ \(MTBF \+ ＿＿\)$/m, 'a linked cloze: its stem with the blank');
  assert.match(text, /^- \*\*H2-Q1\*\* Which is right\?\n\n> \*\*追问：\*\*/m, 'the second time: the number and the stem, no options');
  assert.doesNotMatch(text, /an old question|练 5 道|本节问答：/, 'the deleted question, 练 5 道 and 本节问答 are gone');
  assert.match(text, /^\[\^h2g-1\]: 「Availability is the proportion of time」 · Lecture 4$/m, 'a 出处 keeps its words');
  assert.match(text, /^关于：「Availability」\n\nAn AI paragraph under the heading\.$/m, 'an AI block: its content, no marker');
  const [body, key] = text.split('## 答案册 {#answers}');
  assert.deepEqual([...new Set(numbersIn(key))], [...new Set(numbersIn(body.split('## 1 Introduction')[1]))], 'the answer key under the same numbers, in the same order');
  assert.match(key, /\*\*H2-Q1\*\* 答案：B\. Multiply them\n\n解析：Independent parts in series multiply\./);
  assert.match(key, /\*\*H2-Q3\*\* 答案：MTTR/);
  assert.match(key, /\*\*推理链\*\*\n\n1\. A = 1000 \/ \(1000 \+ 2\) = 0\.998/, 'an answer card in full');
});

test('an English book exports in English: the lookup, the questions\' heading, the answer key', () => {
  const { text, filename } = runExport({ ...exportBook(), language: 'en', title: 'Review book · SA' }, { cardOf, answerKey: true, questions: 'all' });
  for (const part of ['## Lookup {#lookup}', '### Contents {#lookup-toc}', '### By question type {#lookup-types}', '**Answer order**: Stem facts → Explicit assumptions',
    '| Type · signals in the stem | Steps · formulas | Common mistakes · the cost to state |', '**Availability** (', '### Mistakes by point {#lookup-mistakes}',
    '**Questions of this point**', '## Answer key {#answers}', '**H2-Q1** Answer: B. Multiply them']) assert.ok(text.includes(part), part);
  assert.equal(filename, 'Review-book-SA-with-answers.md');
});

test('footnotes are named per file and never collide; every reference has its definition', () => {
  const { text } = runExport(exportBook(), { cardOf });
  const refs = [...text.matchAll(/\[\^([^\]]+)\](?!:)/g)].map(match => match[1]), defs = [...text.matchAll(/^\[\^([^\]]+)\]:/gm)].map(match => match[1]);
  assert.deepEqual(defs, ['h2g-1', 'h2m-1', 'h3g-1', 'unplaced-1'], 'four [^1] of four files, four names');
  assert.equal(new Set(defs).size, defs.length);
  for (const ref of refs) assert.ok(defs.includes(ref), `[^${ref}] has its definition`);
  // The structure Pandoc needs, checked without it: every anchor once, every internal link to an anchor that is there, fences closed.
  const anchors = [...text.matchAll(/\{#([^}\s]+)\}$/gm)].map(match => match[1]);
  assert.equal(new Set(anchors).size, anchors.length, 'every anchor once');
  for (const [, target] of text.matchAll(/\]\(#([^)\s]+)\)/g)) assert.ok(anchors.includes(target), `#${target} is an anchor`);
  assert.equal((text.match(/^\s*```/gm) || []).length % 2, 0, 'fences closed');
  // A heading pasted with its id into another file keeps the code, not a second anchor.
  const pasted = runExport(exportBook({ qa: `## 我的推导 <!-- sh:id h9 -->\n\n## Copied <!-- sh:id h2 -->\n\n${exportBook().nodes[0].children[0].qa}` }), { cardOf }).text;
  const again = [...pasted.matchAll(/\{#([^}\s]+)\}$/gm)].map(match => match[1]);
  assert.equal(new Set(again).size, again.length, 'still every anchor once');
  assert.match(pasted, /^#### Copied 〔H2〕$/m);
});

test('noprint: left out of the export, its estimate and its lookup; the page\'s lookup still sees it; a marker never closed keeps its text', () => {
  const { text, estimate } = runExport(exportBook(), { cardOf });
  assert.doesNotMatch(text, /只给自己看的草稿|草稿词/);
  const without = runExport(exportBook({ mine: exportBook().nodes[0].children[0].mine.replace(/<!-- sh:noprint -->[\s\S]*?<!-- \/sh:noprint -->/, '') }), { cardOf });
  assert.equal(without.text, text, 'the same export as without the region');
  assert.equal(estimate.book, without.estimate.book);
  const page = bookLookup(exportBook(), exportBook());
  assert.ok(page.concepts.some(item => item.term === '草稿词'), 'the page\'s 查找 lists what the learner wrote, printed or not');
  assert.equal(withoutNoprint('a <!-- sh:noprint -->b'), 'a b', 'an opener never closed: only the marker goes');
});

test('the lookup: 目录 with codes, 按题型 (速查表) from the answer cards, 按概念 from cards, bold definitions and [[markers]], 易错点 per point', () => {
  const book = exportBook(), lookup = bookLookup(book, book);
  assert.deepEqual(lookup.toc.map(entry => [entry.code, entry.level, entry.title]),
    [['H1', 2, '1 Introduction'], ['H2', 3, '1.1 Availability'], ['H9', 4, '我的推导'], ['H3', 3, '1.2 Performance'], ['U', 2, '未归位']]);
  assert.deepEqual(lookup.types.map(type => [type.id, type.label, type.places, type.cards.map(card => card.cardId)]), [['availability', '可用性', ['h2'], ['q2']]],
    'only the types with an answer card in the book (no course types of its own)');
  const [availability] = lookup.types;
  assert.ok(availability.steps.length >= 4 && availability.formulas.length >= 1);
  assert.ok(availability.mistakes.includes('把串联的可用性相加') && availability.mistakes.includes('串联时把可用性相加，而不是相乘'), 'the type\'s and the cards\' mistakes');
  assert.deepEqual(availability.costs, ['多一台服务器的费用。']);
  assert.deepEqual(lookup.answerOrder, ['题干事实', '明示假设', '设计/计算', '为什么满足目标', '失败与代价', '如何验证']);
  assert.deepEqual(lookup.concepts.map(item => [item.term, item.places, item.from]),
    [['MTTR', ['h2'], ['bold']], ['串联', ['h2'], ['marker']], ['可用性', ['h2'], ['bold', 'card']], ['吞吐量', ['h3'], ['bold']], ['草稿词', ['h2'], ['bold']]]);
  assert.deepEqual(lookup.mistakes.map(place => [place.code, place.items.map(item => [item.kind, item.text])]),
    [['H2', [['asked', '为什么串联要相乘？'], ['pitfall', '把串联的可用性相加']]]]);
  const own = bookLookup(book, { ...book, caseTypes: [...book.caseTypes, { id: 'mine', label: 'Mine', signals: [], steps: ['Do it'], own: true }] });
  assert.ok(own.types.some(type => type.id === 'mine'), 'a course\'s own type is listed even without a card');
  const markdown = renderLookup(lookup, { number: (deckId, cardId, hid) => (hid === 'h2' && cardId === 'q2' ? 'H2-Q2' : null) });
  assert.match(markdown, /^\| \*\*可用性\*\*（可用性、可用率、宕机、停机、故障、MTBF） · 在哪里：\[H2\]\(#h2\)（H2-Q2） \| ① 列出路径上的部件/m);
  assert.match(markdown, /^ {2}- 易错：把串联的可用性相加（H2-Q2）$/m);
  const empty = bookLookup({ ...book, answerCards: [] }, { caseTypes: book.caseTypes, answerCards: [] });
  assert.deepEqual(empty.types, [], 'no answer card, no course type: nothing about question types');
  assert.doesNotMatch(renderLookup(empty), /按题型/);
});

test('defined terms: bold at the start of a definition, any bold term of a 定义 line, [[markers]]; the book\'s own labels and code are never terms', () => {
  const text = ['**幂等**：同一请求做多次结果不变。', '- **CAP** is a theorem.', '> **最终一致性**（eventual consistency）是一种模型。', '**定义**：**限界上下文** 与 **聚合**。',
    '**考情** 样卷考过。', '**题型**：可用性', '> **追问：** 为什么？', '**讲解**', '**微服务**架构很常见。', '见 [[熔断]] 和 [[ 降级 ]]。', '```', '**代码**：不算', '```'].join('\n');
  assert.deepEqual(definedTerms(text).map(item => item.term), ['幂等', 'CAP', '最终一致性', '限界上下文', '聚合', '熔断', '降级']);
});

test('the page estimate is a fixed rule: 40 wide characters a line, 45 lines a page, a blank line half a line, anchors not counted', () => {
  assert.deepEqual([PAGE_RULE.columns, PAGE_RULE.rows], [40, 45]);
  assert.equal(estimatePages(''), 0);
  assert.equal(estimatePages('字'.repeat(40 * 45)), 1);
  assert.equal(estimatePages('字'.repeat(40 * 45 + 1)), 2);
  assert.equal(estimatePages('a'.repeat(80 * 45)), 1, 'two narrow characters fill one wide place');
  assert.equal(estimatePages(Array.from({ length: 45 }, () => '## 字 {#h123456789}').join('\n')), 1);
  assert.equal(estimatePages(Array.from({ length: 46 }, () => 'x').join('\n')), 2);
});

test('book.pageLimit: absent by default, a whole number 1–2000, null takes it away', () => {
  assert.deepEqual(resolveBookSettings(undefined), { qaToBook: 'manual' });
  assert.deepEqual(mergeBookSettings(undefined, { pageLimit: 30 }), { qaToBook: 'manual', pageLimit: 30 });
  assert.deepEqual(mergeBookSettings({ qaToBook: 'auto', pageLimit: 30 }, { pageLimit: null }), { qaToBook: 'auto' });
  assert.deepEqual(resolveBookSettings({ pageLimit: 0 }), { qaToBook: 'manual' });
  for (const bad of [0, 2001, 1.5, '30']) assert.throws(() => mergeBookSettings(undefined, { pageLimit: bad }), /Invalid book setting/);
});

/* ---------- on the real state: the op, the stable codes, Pandoc ---------- */

const lectureKey = sources => groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
const outlineOf = (state, nodes, createdAt = '2026-10-09T00:00:00.000Z') => ({ ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] },
  fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments), nodes, other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt });
function library() {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources);
  const outline = outlineOf(state, [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
    { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }]);
  state.sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1');
  state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: [{ id: 'what', title: 'What architects do',
    anchors: [`${lecture}#0`], body: { fingerprint: 'f'.repeat(16), points: ['**架构决策**：记录下来的选择 [^1]。'], explain: 'They keep a log [^1].', cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } }] }),
  createdAt: '2026-10-09T01:00:00.000Z' });
  return { state, outline, lecture };
}
const leavesOf = nodes => nodes.flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));
const bookOf = state => state.sources.find(source => source.provenance === 'course-book-doc');

test('course.book.export on the state: all of a point\'s questions numbered, a deleted one skipped, an answer card in the lookup and the key; nothing is written', () => {
  const { state } = library();
  const card = state.decks.find(deck => deck.id === 'deck-l1').cards[0];
  card.answerCard = answerCard();
  // 200 more questions of the first point: the page lists 200, the export prints them all.
  const deck = state.decks.find(item => item.id === 'deck-l1');
  deck.cards.push(...Array.from({ length: 200 }, (_, i) => ({ ...structuredClone(deck.cards[2]), id: `extra-${i}` })));
  openCourseBook(state, {});
  const [what] = leavesOf(openCourseBook(state, {}).nodes);
  assert.deepEqual([what.questions.length, what.questionTotal], [200, 225]);
  const other = state.decks.find(deck => deck.id === 'deck-l1').cards[1];
  bookOf(state).bookDoc.files['what.mine.md'].text = `See [练习：gone](studyhub://card/deck-l1/deleted) and [练习：it](studyhub://card/deck-l1/${other.id}).`;
  const before = JSON.stringify(state);
  const done = courseBookExport(state, { answerKey: true, questions: 'all' });
  assert.equal(JSON.stringify(state), before, 'read only');
  assert.equal(done.status, 'ok');
  const own = numbersIn(done.text.split('## 1 Introduction')[1].split('## 答案册')[0]).filter(number => number.startsWith(codeOf(what.hid)));
  assert.equal(new Set(own).size, 225, 'every question of the point, past the page\'s 200');
  assert.match(done.text, new RegExp(`See and \\*\\*${codeOf(what.hid)}-Q\\d+\\*\\* What does`), 'the deleted link is left out, the live one numbered');
  assert.match(done.text, /^\| \*\*可用性\*\*/m, 'the answer card\'s type in the 速查表');
  assert.match(done.text, /^- \*\*架构决策\*\*：\[H\d+\]\(#h\d+\)$/m, 'a bold definition of the notes in 按概念');
  assert.equal(courseBookExport(state, { answerKey: true, questions: 'all' }).text, done.text, 'deterministic on the state');
  const linked = courseBookExport(state, { answerKey: true });
  assert.equal(linked.questionMode, 'linked');
  assert.deepEqual([...new Set(numbersIn(linked.text))], [`${codeOf(what.hid)}-Q1`], 'by default only the linked question');
  assert.ok(linked.estimate.withAnswers < done.estimate.withAnswers, 'and fewer pages');
  assert.deepEqual(Object.keys(courseBookExport(state, { estimateOnly: true })).sort(), ['course', 'estimate', 'status']);
  assert.throws(() => courseBookExport(state, { form: 'zip' }), error => error.code === 'course-book-export-args');
  assert.throws(() => courseBookExport(state, { questions: 'some' }), error => error.code === 'course-book-export-args');
  assert.throws(() => courseBookExport(state, { answerKey: 'yes' }), error => error.code === 'course-book-export-args');
  assert.equal(courseBookExport({ ...state, sources: state.sources.filter(source => !source.courseOutline) }, {}).status, 'empty');
});

test('the codes stay when sections are inserted and moved (I4): the lookup and the export point to the same codes, only the numbers change', () => {
  const { state, outline, lecture } = library();
  openCourseBook(state, {});
  bookOf(state).bookDoc.files['what.mine.md'].text = '**备忘**：一条自己的定义。';
  const first = openCourseBook(state, {});
  const codes = Object.fromEntries(leavesOf(first.nodes).map(leaf => [leaf.title, codeOf(leaf.hid)]));
  const was = bookLookup(first, first).concepts.find(item => item.term === '备忘');
  assert.deepEqual(was.places, [codes['What architects do'].toLowerCase()]);
  // A new point first, the two old ones swapped.
  const rebuilt = outlineOf(state, [{ id: 'c1', title: 'Introduction', children: [{ id: 'new', title: 'A new point', anchors: [`${lecture}#2`] },
    { id: 'who2', title: 'Stakeholders', anchors: [`${lecture}#1`] }, { id: 'what2', title: 'What architects do', anchors: [`${lecture}#0`] }] }], '2026-10-10T00:00:00.000Z');
  state.sources = state.sources.map(source => (source.id === outline.id ? { ...source, archived: true } : source)).concat(rebuilt);
  const after = openCourseBook(state, {});
  const now = Object.fromEntries(leavesOf(after.nodes).map(leaf => [leaf.title, [codeOf(leaf.hid), leaf.number]]));
  assert.deepEqual([now['What architects do'][0], now.Stakeholders[0]], [codes['What architects do'], codes.Stakeholders], 'the same codes');
  assert.deepEqual([now['What architects do'][1], now.Stakeholders[1]], ['1.3', '1.2'], 'the numbers moved');
  assert.ok(!Object.values(codes).includes(now['A new point'][0]), 'a new point gets a new code');
  const lookup = bookLookup(after, after);
  assert.deepEqual(lookup.concepts.find(item => item.term === '备忘')?.places, was.places, 'the concept points to the same code');
  assert.match(courseBookExport(state, {}).text, new RegExp(`^### 1\\.3 What architects do 〔${codes['What architects do']}〕 \\{#${codes['What architects do'].toLowerCase()}\\}$`, 'm'));
});

test('the op through the service: course.book.export answers the book, writes nothing to the library', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-book-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose());
  await study.call('snapshot');
  const { state } = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  await study.call('course.book.open');
  const revision = (await study.store.read()).revision;
  const done = await study.call('course.book.export', { form: 'folder', answerKey: true });
  assert.equal(done.status, 'ok');
  assert.equal(done.files.at(-1).name.endsWith('-answers.md'), true);
  assert.equal((await study.store.read()).revision, revision, 'nothing written');
  assert.equal((await study.call('course.book.export', {})).text, done.files.slice(0, -1).map(file => file.text).join('\n'), 'the single text is the folder without the key');
});
