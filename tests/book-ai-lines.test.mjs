/* 复习全书 S3 (docs/review-book.md "AI blocks"): the line a task or a deletion leaves in a point stands exactly where its block is or will be, so the block
   that lands takes its place and nothing moves: a task about words right after their paragraph, a 加一段 in 我的, a follow-up right under its block, a
   重新生成 keeps the old block (no line), a failure in the same place, a deleted block's 撤销 where it was; a block already written hides its line. Pure. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { pointView } from './ui/book/point-parts.js';
  export { withLines, aboutOf, linesOf, deletedLine } from './ui/book/ai-lines.js';
  export { aiBlock, aiBlocks } from './lib/course-book-ai-text.js';`);

const gen = '**讲解**\n\nFirst paragraph.\n\nThe architect records each decision and its reasons.\n\nThird paragraph.';
const block = (id, about, extra = {}) => ui.aiBlock({ id, at: 'x', about, body: `Body of ${id}.`, ...extra }, 'zh');
const node = mine => ({ hid: 'h2', title: 'Entropy', gen, mine });
/** The explain part as the page draws it: text pieces and block ids in order. */
const order = view => (view.weave.get('explain') || []).map(piece => (piece.item ? piece.item.block.id : piece.text.slice(0, 12)));

test('a task about words: its line right after their paragraph; the block that lands stands in the same place and the line is gone', () => {
  const line = { kind: 'writing', id: 'ai9', heading: 'h2', mode: 'explain', words: 'records each decision', title: 'Entropy' };
  const writing = ui.pointView(node(''), [line]);
  assert.deepEqual(order(writing), ['The architec', 'ai9:writing', 'Third paragr']);
  assert.equal(writing.weave.get('explain')[1].item.block.line, line);
  assert.deepEqual(writing.anchors.get('explain') ?? [], [], 'no dashed words for a block that is not there yet');
  const landed = ui.pointView(node(block('ai9', 'records each decision')), [line]);
  assert.deepEqual(order(landed), ['The architec', 'ai9', 'Third paragr'], 'the block takes the line\'s place');
  assert.equal(landed.blocks.some(item => item.block.line), false, 'and the line is not drawn');
});

test('a 加一段 line is in 我的 (after the blocks there); a follow-up line right under the block it continues; words that are nowhere: at the end of 我的', () => {
  const here = ui.pointView(node(block('ai1', 'Entropy', { at: 'h:h2', mode: 'here' })), [{ kind: 'writing', id: 'ai2', heading: 'h2', mode: 'here', title: 'Entropy' }]);
  assert.deepEqual(here.here.map(item => item.block.id), ['ai1', 'ai2:writing']);
  const two = `${block('ai1', 'records each decision')}\n\n${block('ai3', 'records each decision', { mode: 'follow' })}`;
  const follow = ui.pointView(node(two), [{ kind: 'writing', id: 'ai4', heading: 'h2', mode: 'follow', words: 'records each decision', after: 'ai1' }]);
  assert.deepEqual(order(follow), ['The architec', 'ai1', 'ai4:writing', 'ai3', 'Third paragr'], 'a follow-up is written right after the block it continues');
  const lost = ui.pointView(node(''), [{ kind: 'writing', id: 'ai5', heading: 'h2', mode: 'write', words: 'words that are nowhere' }]);
  assert.deepEqual(lost.lost.map(item => item.block.id), ['ai5:writing']);
});

test('重新生成 keeps the old block until the new one lands (no line; the block is rewriting); its failure stands right under it', () => {
  const mine = block('ai1', 'records each decision');
  const again = ui.pointView(node(mine), [{ kind: 'writing', id: 'ai1', heading: 'h2', mode: 'explain', words: 'records each decision', replace: 'ai1' }]);
  assert.deepEqual(order(again), ['The architec', 'ai1', 'Third paragr']);
  assert.equal(again.rewriting.has('ai1'), true);
  const failed = ui.pointView(node(mine), [{ kind: 'failed', id: 'ai1', heading: 'h2', mode: 'explain', words: 'records each decision', replace: 'ai1', error: 'x' }]);
  assert.deepEqual(order(failed), ['The architec', 'ai1', 'ai1:failed', 'Third paragr']);
});

test('a deleted block\'s 撤销 line stands where the block was (among the others); once it is back, the line is gone', () => {
  const first = block('ai1', 'records each decision'), second = block('ai2', 'records each decision'), third = block('ai3', 'records each decision');
  const deleted = ui.aiBlocks(second)[0];
  const undo = { kind: 'undo', id: 'ai2', heading: 'h2', index: 1, block: deleted };
  assert.deepEqual(order(ui.pointView(node(`${first}\n\n${third}`), [undo])), ['The architec', 'ai1', 'ai2', 'ai3', 'Third paragr']);
  assert.equal(ui.pointView(node(`${first}\n\n${third}`), [undo]).blocks[1].block.line, undo);
  assert.equal(ui.pointView(node(`${first}\n\n${second}\n\n${third}`), [undo]).blocks.some(item => item.block.line), false);
});

test('a deletion leaves 撤销 only when this delete took the block out: a block already gone from the file (another writer) leaves none, so 撤销 can never take back their write', () => {
  const deleted = ui.aiBlocks(block('ai2', 'records each decision'))[0], point = { hid: 'h2', files: { mine: 'p.mine.md' }, mine: `${block('ai1', 'x')}\n\n${block('ai2', 'y')}` };
  const view = (write, version) => ({ write, files: { 'p.mine.md': { version } } });
  assert.deepEqual(ui.deletedLine(view('deleted', 4), point, deleted), { key: 'undo-ai2', kind: 'undo', id: 'ai2', heading: 'h2', index: 1, block: deleted, file: 'p.mine.md', version: 4 });
  assert.equal(ui.deletedLine(view('unchanged', 4), point, deleted), null, 'the block was not there any more: nothing to undo');
  assert.equal(ui.deletedLine(null, point, deleted), null);
});

test('what a block will be about: the words, quotes off, at most 120 characters; a 加一段 is about the title; the lines of one point', () => {
  assert.equal(ui.aboutOf('explain', '  「熵」 只增\n不减 ', 'T'), '熵 只增 不减');
  assert.equal(ui.aboutOf('here', 'x', ' Entropy '), 'Entropy');
  assert.equal(ui.aboutOf('write', 'a'.repeat(200)).length, 120);
  assert.deepEqual(ui.linesOf([{ heading: 'h1' }, { heading: 'h2' }], 'h2'), [{ heading: 'h2' }]);
});
