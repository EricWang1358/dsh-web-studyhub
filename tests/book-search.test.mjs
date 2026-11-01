/* #489 item 4: 在书里找 finds any words of the book, in reading order, over the text course.book.open gives (逐节读 draws one point at a time, so the page cannot be what is searched). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { plainText, searchBook, searchIndex, SEARCH_ROWS } from './ui/book/book-search.js';`);

const leaf = (hid, number, title, gen, mine = '', qa = '') => ({ hid, number, title, depth: 2, leaf: true, gen, mine, qa, children: [] });
const book = {
  status: 'ok',
  nodes: [{ hid: 'c1', number: '1', title: 'Chapter One', depth: 1, leaf: false, children: [
    leaf('a', '1.1', 'Latency', '**讲解**\n\n尾延迟看 P99 分位数 [^1]。\n\n[^1]: [「出处的话」](studyhub://source/s1)\n\n[练 5 道：Latency](studyhub://practice?heading=a&n=5) · [本节问答：Latency](studyhub://qa?heading=a)', '我的笔记：p99  延迟 两次 p99。'),
    leaf('b', '1.2', 'Throughput', '吞吐量和延迟不一样。\n\n[练 5 道：Throughput](studyhub://practice?heading=b&n=5)', '', '<!-- sh:qa card=x fid=y -->\n问：什么是背压？'),
  ] }],
  unplaced: { title: '未归位', text: '### 旧的一节\n\n留在这里的 p99 笔记。', file: 'unplaced.md' },
};
const index = ui.searchIndex(book), find = query => ui.searchBook(index, query);

test('nothing to look for is not a search; words that are nowhere are an empty answer, not a null', () => {
  assert.equal(find(''), null);
  assert.equal(find('   '), null);
  assert.deepEqual(find('没有这个词'), { total: 0, rows: [] });
});

test('case, width and extra whitespace are ignored, and the first place comes with the words around it, as written', () => {
  const { total, rows } = find('Ｐ９９');
  assert.equal(total, 2);
  assert.deepEqual(rows.map(row => row.hid), ['a', 'unplaced'], 'in reading order, 未归位 last');
  assert.equal(rows[0].count, 3, 'every place in the point, its notes too');
  assert.equal(rows[0].match, 'P99');
  assert.match(rows[0].before, /尾延迟看 $/);
  assert.match(rows[0].after, /^ 分位数/);
  assert.equal(find('p99 延迟').rows[0].match, 'p99 延迟', 'two spaces in the text match one in the words, and the line shown is one line');
});

test('what the page does not show as words is not found: link targets, ids, footnote labels, the 练 and 问答 line of every point', () => {
  for (const words of ['studyhub', 'heading=', 'sh:qa', '[^1]', '练 5 道', '本节问答']) assert.equal(find(words).total, 0, words);
  assert.equal(find('出处的话').rows[0].hid, 'a', 'the words of a 出处 are shown, so they are found');
  assert.equal(find('背压').rows[0].hid, 'b', 'a Q&A of the point');
});

test('a title alone is found (a chapter too), with no place in the text to show', () => {
  const [row] = find('Chapter One').rows;
  assert.deepEqual([row.hid, row.number, row.count, row.match], ['c1', '1', 1, undefined]);
  assert.equal(find('Throughput').rows[0].count, 1);
});

test('the list is cut at SEARCH_ROWS and says how many have it', () => {
  const many = { status: 'ok', unplaced: { title: '未归位', text: '' }, nodes: Array.from({ length: ui.SEARCH_ROWS + 5 }, (_, at) => leaf(`p${at}`, `${at}`, `Point ${at}`, '同一个词')) };
  const answer = ui.searchBook(ui.searchIndex(many), '同一个词');
  assert.equal(answer.total, ui.SEARCH_ROWS + 5);
  assert.equal(answer.rows.length, ui.SEARCH_ROWS);
});

test('a book that is not open has nothing to search', () => {
  assert.deepEqual(ui.searchIndex(null), []);
  assert.deepEqual(ui.searchIndex({ status: 'rebuild-pending' }), []);
});

test('half a million characters: the index is made once, and each key after it is quick', () => {
  const big = { status: 'ok', unplaced: { title: '未归位', text: '' }, nodes: Array.from({ length: 400 }, (_, at) => leaf(`p${at}`, `${at}`, `Point ${at}`, `第 ${at} 节。`.repeat(200))) };
  const made = performance.now(), bigIndex = ui.searchIndex(big), indexMs = performance.now() - made;
  const asked = performance.now();
  for (const word of ['第', '第 1', '第 12', '没有的词']) ui.searchBook(bigIndex, word);
  const perKey = (performance.now() - asked) / 4;
  assert.ok(indexMs < 2000, `the index took ${Math.round(indexMs)} ms`);
  assert.ok(perKey < 100, `a key took ${Math.round(perKey)} ms`);
});
