import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCorrections, parseCorrections } from '../lib/transcript.js';

/* A proofreading reply cut off at the output limit inside the corrections array (#763). It used to fail to parse as a whole, so the window asked again for
   the entire 6000-character passage — paying for the same input tokens twice and losing the corrections it had already written. The complete entries are
   salvaged and checked exactly as before; only a reply with nothing salvageable goes back to the model. */

const TEXT = '我们用一个 patient 按日期切分这张表，然后把分区写回磁盘。';
const GOOD = { wrong: 'patient', right: 'partition', context: '我们用一个 patient 按日期切分这张表', reason: '数据库语境下应为 partition（分区）', confidence: 'high' };
const LOW = { ...GOOD, wrong: '磁盘', right: '硬盘', confidence: 'low' };

test('the complete entries of a reply cut off inside the array are kept, not thrown away', () => {
  const reply = '{"corrections":[' + JSON.stringify(GOOD) + ',' + JSON.stringify(LOW) + ',{"wrong":"分区","right":"part';
  const list = parseCorrections(reply);
  assert.equal(list.length, 2, 'the two entries that were written in full');
  assert.deepEqual(list[0], GOOD);
  const applied = applyCorrections(TEXT, list);
  assert.equal(applied.applied.length, 1, 'the high-confidence one still goes through the same checks');
  assert.equal(applied.text, '我们用一个 partition 按日期切分这张表，然后把分区写回磁盘。');
  assert.equal(applied.skipped.length, 1);
  assert.equal(applied.skipped[0].skipped, 'low-confidence', 'a salvaged entry is not trusted more than a parsed one');
});

test('a brace inside a context does not split an entry, and a reply with no complete entry still fails so the window asks again', () => {
  const braced = { ...GOOD, context: '我们用一个 {patient} 按日期切分这张表' };
  const list = parseCorrections('{"corrections":[' + JSON.stringify(braced) + ']}');
  assert.deepEqual(list, [braced]);
  assert.throws(() => parseCorrections('{"corrections":[{"wrong":"patient","right":"parti'), /没有 corrections 数组|Unexpected|Unterminated|JSON/i, 'nothing salvageable: the caller re-asks');
  assert.throws(() => parseCorrections('the model answered in prose'), /没有 corrections 数组|Unexpected|JSON/i, 'prose is not a corrections list: the caller re-asks');
});

test('a plain JSON array and a well-formed object are read exactly as before', () => {
  assert.deepEqual(parseCorrections(JSON.stringify([GOOD])), [GOOD]);
  assert.deepEqual(parseCorrections('\u0060\u0060\u0060json\n{"corrections":[]}\n\u0060\u0060\u0060'), [], 'a fenced empty answer is still an empty answer');
});
