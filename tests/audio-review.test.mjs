import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReview, decideUncertain, itemKey, pendingUncertain } from '../lib/audio-review.js';
import { buildDocuments } from '../lib/transcript.js';

const parts = [
  { titleZh: '分区', titleEn: 'Partitions', english: ['we split the table into a patient by date', 'queries then read one patient only'],
    chinese: ['我们按日期把表拆成病人', '查询只读取一个病人'] },
  { titleZh: '索引', titleEn: 'Indexes', english: ['an index on the collar speeds up lookups'], chinese: ['列上的索引加快查找'] },
];
const texts = buildDocuments({ filename: 'db.mp3', titleEn: 'Databases', parts, limit: 200 });
const unsure = (wrong, right, context) => ({ wrong, right, context, reason: '语境', confidence: 'low', skipped: 'low-confidence' });
const corrections = () => ({ applied: [], appliedCount: 0, skippedCount: 4, skipped: [
  unsure('patient', 'partition', 'split the table into a patient by date'),
  unsure('collar', 'column', 'an index on the collar speeds'),
  unsure('split', 'spilt', 'we split the table'),
  { wrong: 'x', right: 'y', context: 'x', skipped: 'empty' },
] });

test('confirmed suggestions are applied across volumes with their translation, the rest stay listed', () => {
  assert.equal(texts.length, 2);
  const record = corrections();
  const decisions = new Map([
    [itemKey(record.skipped[0]), { verdict: 'apply', right: 'partition', translation: { wrong: '病人', right: '分区' }, reason: '数据库语境' }],
    [itemKey(record.skipped[1]), { verdict: 'apply', right: 'column', translation: null, reason: '列' }],
    [itemKey(record.skipped[2]), { verdict: 'reject', reason: '原文正确' }],
  ]);
  const result = applyReview({ texts, corrections: record, decisions, at: 'T' });
  assert.equal(result.applied, 2); assert.equal(result.rejected, 1); assert.equal(result.unsure, 0);
  assert.match(result.texts[0], /into a partition by date/);
  assert.match(result.texts[0], /拆成分区\n\n查询只读取一个病人/, 'only the paired translation paragraph changes');
  assert.match(result.texts[0], /read one patient only/, 'the same word elsewhere is untouched');
  assert.match(result.texts[1], /index on the column speeds/);
  assert.equal(result.corrections.appliedCount, 2); assert.equal(result.corrections.skippedCount, 2);
  assert.ok(result.corrections.applied.every(item => item.reviewed));
  assert.deepEqual(result.corrections.skipped.map(item => item.review?.verdict ?? null), ['reject', null]);
  assert.deepEqual(pendingUncertain(result.corrections), [], 'reviewed items are never asked again');
});

test('undecided, unsure and unsafe items stay pending or listed and the texts stay byte-identical', () => {
  const record = corrections();
  const untouched = applyReview({ texts, corrections: record, decisions: new Map() });
  assert.deepEqual(untouched.texts, texts); assert.equal(pendingUncertain(untouched.corrections).length, 3);
  const moved = { ...record, skipped: [unsure('patient', 'partition', 'no longer in the transcript')] };
  const lost = applyReview({ texts, corrections: moved, decisions: new Map([[itemKey(moved.skipped[0]), { verdict: 'apply', right: 'partition' }]]) });
  assert.equal(lost.applied, 0); assert.equal(lost.unsure, 1); assert.deepEqual(lost.texts, texts);
  assert.equal(lost.corrections.skipped[0].review.verdict, 'unsure');
});

test('the model is asked in batches with the paragraph and its translation, and bad replies are ignored', async () => {
  const record = corrections(), prompts = [];
  const decisions = await decideUncertain({ corrections: record, texts, subject: 'DB', complete: async (system, prompt) => {
    const { items } = JSON.parse(prompt); prompts.push(items);
    return JSON.stringify({ decisions: [{ n: 1, verdict: 'apply', right: 'partition' }, { n: 2, verdict: 'maybe' }, { n: 9, verdict: 'apply' }] });
  } });
  assert.equal(prompts.length, 1); assert.equal(prompts[0].length, 3);
  assert.match(prompts[0][0].paragraph, /into a patient by date/); assert.equal(prompts[0][0].translation, '我们按日期把表拆成病人');
  assert.deepEqual([...decisions.keys()], [itemKey(record.skipped[0])]);
});

test('a transcript saved with the old 80-dash divider is reviewed too, and each divider is written back as it was (#232)', () => {
  const record = corrections(), old = '-'.repeat(80);
  const [whole] = buildDocuments({ filename: 'db.mp3', titleEn: 'Databases', parts });
  assert.match(whole, /\n\n---\n\n/, 'a new transcript has the standard divider');
  const legacy = whole.replace('\n\n---\n\n', `\n\n${old}\n\n`);
  const decisions = new Map([[itemKey(record.skipped[0]), { verdict: 'apply', right: 'partition', translation: { wrong: '病人', right: '分区' } }]]);
  for (const [name, text, divider] of [['standard', whole, '---'], ['legacy', legacy, old]]) {
    const result = applyReview({ texts: [text], corrections: record, decisions, at: 'T' });
    assert.equal(result.applied, 1, name);
    assert.match(result.texts[0], /into a partition by date/, name);
    assert.ok(result.texts[0].includes(`\n\n${divider}\n\n【第二部分`), `${name}: the divider is written back as it was`);
    assert.deepEqual(applyReview({ texts: [text], corrections: record, decisions: new Map() }).texts, [text], `${name}: nothing decided is byte-identical`);
  }
});
