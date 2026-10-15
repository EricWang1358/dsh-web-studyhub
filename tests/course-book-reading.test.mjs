/* 复习全书 reading (docs/review-book.md, "Reading a point"): the pure rules of ui/book/point-parts.js and ui/book/reading.js. A point's generated file cut
   into its labelled parts (zh and en), the 练 5 道 · 本节问答 footer taken off, the one-sentence takeaway (its own part, else the first sentence of 讲解,
   which then leaves 讲解; shown without its 「一句话：」), the AI blocks placed right after the paragraph that holds their words (or in 我的, or lost), the cheap
   repeat check of a whole-point block, the default fold of a block (over 1,500 characters and not kept), and the steps of 逐节读 with the step of any 目录
   heading. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export * from './ui/book/point-parts.js';
  export { bookSteps, stepIndexOf } from './ui/book/reading.js';
  export { tocEntries, bookRows } from './ui/book/model.js';
  export { aiBlock } from './lib/course-book-ai-text.js';`);

const zh = ['**考情** 样卷考过。', '', '**知识梳理**', '', '- 熵度量无序 [^1]', '- 孤立系统熵不减', '', '**讲解**', '', '熵是系统无序程度的度量[^1]。它在孤立系统里只增不减。', '',
  '第二段讲解。', '', '**例子**', '', '冰块融化。', '', '**补充（资料以外）**', '', '- 玻尔兹曼公式', '', '**出处**', '', '[^1]: [「熵度量无序」](studyhub://source/tb-p3) · 课本', '',
  '[练 5 道：熵](studyhub://practice?heading=h2&n=5) · [本节问答：熵](studyhub://qa?heading=h2)'].join('\n');
const en = ['**Key points**', '', '- Entropy measures disorder', '', '**Explanation**', '', 'Entropy is a measure of disorder, e.g. in a gas at 3.5 K. It never decreases.', '',
  '**Example**', '', 'Ice melts.', '', '**Sources**', '', '[^1]: [“Entropy”](studyhub://source/tb-p3)', '',
  '[Practise 5: Entropy](studyhub://practice?heading=h2&n=5) · [Questions and answers: Entropy](studyhub://qa?heading=h2)'].join('\n');

test('a generated file is cut into its labelled parts; the footer of links is off; a file without labels is one untitled part', () => {
  const parts = ui.splitPoint(zh);
  assert.equal(parts.footer, true);
  assert.equal(parts.parts.exam, '样卷考过。');
  assert.equal(parts.parts.points, '- 熵度量无序 [^1]\n- 孤立系统熵不减');
  assert.equal(parts.parts.explain, '熵是系统无序程度的度量[^1]。它在孤立系统里只增不减。\n\n第二段讲解。');
  assert.equal(parts.parts.example, '冰块融化。');
  assert.equal(parts.parts.extra, '- 玻尔兹曼公式');
  assert.match(parts.parts.cites, /^\[\^1\]: /);
  assert.equal(parts.labels.extra, '补充（资料以外）', 'a part keeps the label it was written with');
  assert.equal(ui.citeCount(parts.parts.cites), 1);
  const english = ui.splitPoint(en);
  assert.equal(english.parts.points, '- Entropy measures disorder');
  assert.equal(english.labels.explain, 'Explanation');
  assert.equal(english.footer, true);
  const plain = ui.splitPoint('Heat.\n\n**Bold term** is kept as text.');
  assert.deepEqual([plain.lead, Object.keys(plain.parts).length, plain.footer], ['Heat.\n\n**Bold term** is kept as text.', 0, false]);
  const added = ui.splitPoint(`${zh}\n\nMy addition at the end.`);
  assert.equal(added.tail, 'My addition at the end.', 'what the learner wrote after the footnotes is not one of them');
  assert.equal(ui.citeCount(added.parts.cites), 1);
  assert.equal(ui.pointView({ gen: `${zh}\n\nMy addition at the end.`, mine: '' }).story.at(-1).name, 'tail', 'and it is shown with the text');
  const old = ui.splitPoint('**本节的题**\n\n- [练习：Q](studyhub://card/d1/q1)\n\n**讲解**\n\nText.');
  assert.deepEqual(old.other, [{ label: '本节的题', text: '- [练习：Q](studyhub://card/d1/q1)' }], 'an unknown label stays a part of its own, in its place');
});

test('the takeaway: its own part, else the first sentence of 讲解 (which then leaves 讲解); none when the first sentence is no sentence', () => {
  const zhTake = ui.takeawayOf(ui.splitPoint(zh));
  assert.deepEqual(zhTake, { text: '熵是系统无序程度的度量[^1]。', rest: '它在孤立系统里只增不减。\n\n第二段讲解。', own: false });
  const enTake = ui.takeawayOf(ui.splitPoint(en));
  assert.equal(enTake.text, 'Entropy is a measure of disorder, e.g. in a gas at 3.5 K.', 'a decimal point and an abbreviation do not end it');
  assert.equal(enTake.rest, 'It never decreases.');
  assert.deepEqual(ui.takeawayOf(ui.splitPoint('**一句话**\n\n熵只增不减。\n\n**讲解**\n\n长讲解。')), { text: '熵只增不减。', rest: '长讲解。', own: true });
  assert.equal(ui.takeawayOf(ui.splitPoint('**讲解**\n\n- a list first\n- then more')), null, 'a list is not a sentence');
  assert.equal(ui.takeawayOf(ui.splitPoint('**讲解**\n\n$$x^2$$ shows it.')), null, 'a display formula is not a sentence');
  assert.equal(ui.firstSentence('公式 $a. b$ 不在这里断。后面。').text, '公式 $a. b$ 不在这里断。', 'a formula is never cut');
  assert.equal(ui.firstSentence('Only one sentence').text, 'Only one sentence');
  assert.equal(ui.firstSentence(`${'长'.repeat(300)}。`), null, 'too long to be a takeaway');
  assert.equal(ui.pointSummary(zh), '熵是系统无序程度的度量。');
  assert.equal(ui.pointSummary('Heat is energy.\n\nMore.'), 'Heat is energy.');
});

const notes = '熵是系统无序程度的度量。它在孤立系统里只增不减。冰块融化时熵增加。热量从高温流向低温。';
test('a whole-point block that restates the notes is a repeat; one that adds new words is not; a short one never is', () => {
  const restated = '原文说：熵是系统无序程度的度量。\n\n意思就是：它在孤立系统里只增不减。\n\n原文说：冰块融化时熵增加。\n\n热量从高温流向低温。';
  assert.ok(ui.repeatShare(restated, notes) >= 0.6, `share ${ui.repeatShare(restated, notes)}`);
  const fresh = '想象一个厨房，厨师把调料随手乱放，越放越乱。这就是一个和讲解完全不同的比喻。再来一个例子，图书馆的书被借来借去，最后找不到原来的位置。';
  assert.ok(ui.repeatShare(fresh, notes) < 0.6, `share ${ui.repeatShare(fresh, notes)}`);
  assert.equal(ui.repeatShare('', notes), 0);
  const english = 'The source says entropy measures disorder in a system. In other words it never decreases in an isolated system.';
  assert.ok(ui.repeatShare(english, 'Entropy measures disorder in a system. It never decreases in an isolated system.') >= 0.6);
  assert.ok(ui.repeatShare('A chef keeps the kitchen tidy so that nothing is lost between orders.', 'Entropy measures disorder in a system.') < 0.6);
});

const block = (id, about, body, extra = {}) => ui.aiBlock({ id, at: extra.at || 'x', about, body, mode: extra.mode, state: extra.state }, 'zh');
const node = (mine, gen = zh) => ({ hid: 'h2', gen, mine, qa: '' });
test('the view of a point: the story parts, the blocks in the order of the own file with the part their words are in, repeats, the whole-point and the lost blocks', () => {
  const here = block('a1', '熵', `${'原文说：熵是系统无序程度的度量[^1]。意思就是：它在孤立系统里只增不减。'.repeat(3)}`, { at: 'h:h2', mode: 'here' });
  const words = block('a2', '只增不减', 'An explanation.', { mode: 'explain' });
  const lost = block('a3', 'nowhere at all', 'Orphan.', { state: 'kept' });
  const view = ui.pointView(node(`My note.\n\n${here}\n\n${words}\n\n${lost}`));
  assert.equal(view.takeaway.text, '熵是系统无序程度的度量[^1]。');
  assert.equal(view.mine, 'My note.');
  assert.deepEqual(view.blocks.map(item => [item.block.id, item.status, item.part]), [['a1', 'same', null], ['a2', 'same', 'explain'], ['a3', 'gone', null]]);
  assert.deepEqual(view.anchors.get('explain'), [{ id: 'a2', quote: '只增不减' }], 'the dashed words go on the part that holds them');
  assert.deepEqual([...view.repeats], ['a1'], 'the whole-point block that restates the notes');
  assert.deepEqual(view.here.map(item => item.block.id), ['a1'], 'a block for the whole point stays in 我的');
  assert.deepEqual(view.lost.map(item => item.block.id), ['a3'], 'a block whose words are gone goes to the end of 我的');
  assert.equal(ui.pointView(node(block('a5', '熵', 'x'.repeat(2000), { at: 'h:h2', mode: 'here' }))).repeats.size, 0, 'longer, but nothing of the notes in it');
  assert.deepEqual(ui.pointView(node('', 'Heat.')).story.map(part => part.name), ['lead']);
});

test('a block about words goes right after the paragraph that holds them (讲解, 例子 or the notes), its words dashed in the paragraph before it', () => {
  const inExplain = block('a2', '只增不减', 'An explanation.', { mode: 'explain' }), inNotes = block('a6', 'the decision log', 'About the log.', { mode: 'write', state: 'kept' });
  const view = ui.pointView(node(`My note about the decision log.\n\nSecond note.\n\n${inExplain}\n\n${inNotes}`));
  // 讲解 without its takeaway: the first paragraph holds the words, a second one follows the block.
  assert.deepEqual(view.weave.get('explain').map(piece => piece.item?.block.id ?? piece.text), ['它在孤立系统里只增不减。', 'a2', '第二段讲解。']);
  assert.deepEqual(view.weave.get('explain')[0].anchors, [{ id: 'a2', quote: '只增不减' }]);
  assert.deepEqual(view.weave.get('explain')[2].anchors, []);
  assert.deepEqual(view.weave.get('mine').map(piece => piece.item?.block.id ?? piece.text), ['My note about the decision log.', 'a6', 'Second note.'], 'words in the notes: after that paragraph, in 我的');
  assert.deepEqual(view.blocks.map(item => [item.block.id, item.part]), [['a2', 'explain'], ['a6', 'mine']]);
  assert.equal(view.weave.has('example'), false, 'a part no block is about is not cut');
  assert.deepEqual(ui.pointView(node(block('a7', '玻尔兹曼', 'Extra.', { mode: 'explain' }))).blocks.map(item => item.part), ['extra'], 'a folded part holds words too');
  // A follow-up of a whole-point block stays under it (its words are the heading's, which no text holds); one of a block about words follows those words.
  const here = block('b1', '熵', 'The whole point.', { at: 'h:h2', mode: 'here' }), follow = block('b2', '熵', 'A follow-up.', { mode: 'follow' });
  const kept = ui.pointView(node(`${here}\n\n${follow}`));
  assert.deepEqual(kept.here.map(item => item.block.id), ['b1', 'b2']);
  assert.equal(kept.lost.length, 0);
  assert.deepEqual(ui.pointView(node(`${block('c1', 'nowhere', 'A.', { mode: 'follow' })}`)).lost.map(item => item.block.id), ['c1'], 'a follow-up with no block before it and no words found is lost');
});

test('an AI block starts folded when it is longer than 1,500 characters and not kept; every other block starts open', () => {
  const of = (body, state) => ui.foldsByDefault({ body, state });
  assert.equal(ui.AI_FOLD_CHARS, 1500);
  assert.equal(of('x'.repeat(1500), 'new'), false, 'exactly 1,500 is not longer');
  assert.equal(of('x'.repeat(1501), 'new'), true);
  assert.equal(of('x'.repeat(1501), 'kept'), false, 'a block the learner kept starts open');
  assert.equal(of('x'.repeat(5000), 'kept'), false);
  assert.equal(of('A short one.', 'new'), false);
  assert.equal(of('', 'new'), false);
  assert.equal(ui.pointView(node(block('a4', '熵', 'x'.repeat(1600)))).blocks.length, 1);
});

test('the takeaway is shown without its own label (一句话： / In one sentence:), the file keeps it', () => {
  assert.equal(ui.withoutGistLabel('一句话：熵只增不减。'), '熵只增不减。');
  assert.equal(ui.withoutGistLabel('一句话: Entropy rises.'), 'Entropy rises.');
  assert.equal(ui.withoutGistLabel('In one sentence: entropy rises.'), 'entropy rises.');
  assert.equal(ui.withoutGistLabel('**一句话：** 熵只增不减。'), '熵只增不减。');
  assert.equal(ui.withoutGistLabel('**一句话**：熵只增不减。'), '熵只增不减。', 'the colon after the closing bold marks');
  assert.equal(ui.withoutGistLabel('熵是一句话：不是标签。'), '熵是一句话：不是标签。', 'only a label at the start');
  assert.equal(ui.withoutGistLabel(undefined), '');
  const labelled = '**讲解**\n\n一句话：熵是无序度。它只增不减。\n\n第二段。';
  const view = ui.pointView({ gen: labelled, mine: '' });
  assert.equal(view.story.find(part => part.name === 'takeaway').text, '熵是无序度。', 'shown without the label');
  assert.equal(view.takeaway.text, '一句话：熵是无序度。', 'the view keeps what the file says');
  assert.equal(ui.pointSummary(labelled), '熵是无序度。', 'the folded line of the point too');
  assert.equal(ui.pointSummary('**一句话**\n\n熵只增不减。\n\n**讲解**\n\n长。'), '熵只增不减。');
  assert.equal(ui.pointView({ gen: '**讲解**\n\n熵是无序度。它只增不减。', mine: '' }).story[0].text, '熵是无序度。', 'a takeaway without a label is as it is');
});

const book = { status: 'ok', title: 'B', unplaced: { title: '未归位', text: 'Left over.', file: 'unplaced.md' }, nodes: [
  { hid: 'h1', key: 'bk:c1', title: 'One', number: '1', depth: 1, leaf: false, children: [
    { hid: 'h2', key: 'bk:s1', title: 'Sec', number: '1.1', depth: 2, leaf: false, children: [
      { hid: 'h3', key: 'bk:p1', title: 'P1', number: '1.1.1', depth: 3, leaf: true, gen: 'A.', mine: '## Typed <!-- sh:id h9 -->\n\nMine.', children: [] }] },
    { hid: 'h4', key: 'bk:p2', title: 'P2', number: '1.2', depth: 2, leaf: true, gen: 'B.', mine: '', children: [] }] },
  { hid: 'h5', key: 'bk:p3', title: 'Two', number: '2', depth: 1, leaf: true, gen: 'C.', mine: '', children: [] }] };
test('逐节读: the points in reading order with their chapter and section path, 未归位 last; the step of a heading, a typed one and a chapter', () => {
  const steps = ui.bookSteps(book);
  assert.deepEqual(steps.map(step => [step.hid, step.path.map(item => item.hid)]), [['h3', ['h1', 'h2']], ['h4', ['h1']], ['h5', []], ['unplaced', []]]);
  const toc = ui.tocEntries(book), rows = ui.bookRows(book.nodes);
  assert.equal(ui.stepIndexOf(steps, toc, rows, 'h4'), 1);
  assert.equal(ui.stepIndexOf(steps, toc, rows, 'bk:p3'), 2, 'a node key of the 总纲');
  assert.equal(ui.stepIndexOf(steps, toc, rows, 'h9'), 0, 'a heading typed in a point\'s own file');
  assert.equal(ui.stepIndexOf(steps, toc, rows, 'h1'), 0, 'a chapter: its first point');
  assert.equal(ui.stepIndexOf(steps, toc, rows, 'h2'), 0);
  assert.equal(ui.stepIndexOf(steps, toc, rows, 'nothing'), -1);
  assert.deepEqual(ui.bookSteps({ ...book, unplaced: { title: '未归位', text: ' ' } }).map(step => step.hid), ['h3', 'h4', 'h5']);
});
