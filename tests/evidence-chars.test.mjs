import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionsOf, nonEvidenceRanges, evidenceOf } from '../lib/sections.js';
import { sectionKey, coverageOf } from '../lib/coverage.js';
import { coveragePlan } from '../lib/coverage-plan.js';
import { strengthPlan } from '../lib/coverage-strength.js';
import { lengthWeights, weightChunks } from '../lib/section-weights.js';
import { loadUi } from './helpers/ui-module.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';

/* A bilingual transcript says everything twice (the original, then its translation). Question density and weights count the language that was SPOKEN only: the translation block, the labels
   and the furniture of a recording are never evidence (lib/sections.js evidenceChars). Text with no such blocks is unchanged. */

const { form } = await loadUi("export * as form from './ui/generate-form.js';");
const world = mergedTranscript();
const leaves = sectionsOf(world.sources).filter(section => section.leaf).map(section => ({ ...section, key: sectionKey(section.sourceId, section.id) }));
const raw = leaves.reduce((sum, leaf) => sum + leaf.chars, 0), evidence = leaves.reduce((sum, leaf) => sum + evidenceOf(leaf), 0);

test('a section of a bilingual transcript counts its original language only', () => {
  const text = '## 1. a.mp3\n\n' + '='.repeat(80) + '\n《a.mp3》全量中英对照逐字稿\nFull Bilingual Transcript: A\n' + '='.repeat(80) + '\n\n【第一部分：开场】\n[Part 1: Opening]\n\n【英文原句】\nHello there everyone.\n\nSecond line.\n\n【中文对照】\n大家好。\n\n第二行。\n\n---\n\n【第二部分：正文】\n[Part 2: Body]\n\n【英文原句】\nBody text.\n\n【中文对照】\n正文。';
  const sections = sectionsOf({ id: 'a', text });
  const parts = sections.filter(section => section.leaf);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].evidenceChars, '【第一部分：开场】\n[Part 1: Opening]\n\n'.length + 'Hello there everyone.\n\nSecond line.\n\n'.length, 'the heading and the English, never the labels or the translation');
  assert.equal(parts[1].evidenceChars, '【第二部分：正文】\n[Part 2: Body]\n\n'.length + 'Body text.\n\n'.length);
  assert.ok(parts.every(part => part.evidenceChars < part.chars));
  const ranges = nonEvidenceRanges(text);
  assert.ok(ranges.some(([from, to]) => text.slice(from, to).startsWith('【中文对照】') && text.slice(from, to).includes('第二行。')));
  assert.ok(ranges.some(([from, to]) => text.slice(from, to).startsWith('====')), 'the furniture of the recording is not evidence');
});

test('a Chinese recording counts the Chinese; English and Markdown labels are read the same way; text without blocks is unchanged', () => {
  const zh = '【第一部分：甲】\n[Part 1: A]\n\n【中文原文】\n中文原文内容。\n\n【英文对照】\nThe original content translated into a longer English sentence.';
  const [part] = sectionsOf({ id: 'z', text: zh }).filter(section => section.leaf);
  assert.equal(part.evidenceChars, '【第一部分：甲】\n[Part 1: A]\n\n'.length + '中文原文内容。\n\n'.length);
  const en = '[Part 1: A]\n\n[English original]\nHello.\n\n[Chinese translation]\n你好。\n\n---\n\n[Part 2: B]\n\n[English original]\nBye.\n\n[Chinese translation]\n再见。';
  assert.deepEqual(sectionsOf({ id: 'e', text: en }).filter(section => section.leaf).map(section => section.evidenceChars), ['[Part 1: A]\n\n'.length + 'Hello.\n\n'.length, '[Part 2: B]\n\n'.length + 'Bye.\n\n'.length]);
  const md = '# T\n\n## 英文原句\n\nSpoken words.\n\n## 中文对照\n\n说的话。\n\n## Next\n\nMore text here.';
  for (const section of sectionsOf({ id: 'm', text: md })) assert.ok(section.evidenceChars <= section.chars);
  assert.equal(sectionsOf({ id: 'm', text: md }).reduce((sum, section) => sum + section.evidenceChars, 0), md.length - '## 英文原句\n'.length - '## 中文对照\n\n说的话。\n\n'.length);
  const plain = '# One\n\nplain text\n\n# Two\n\nmore plain text';
  for (const section of sectionsOf({ id: 'p', text: plain })) assert.equal(section.evidenceChars, section.chars);
  assert.equal(evidenceOf({ chars: 7 }), 7);
});

test('the fixture: the plan counts the evidence, not both languages', () => {
  assert.equal(leaves.length, 81);
  assert.ok(evidence < raw * 0.8 && evidence > raw * 0.6, `${evidence} of ${raw} characters are evidence`);
  const before = Math.round(6 * raw / 10000), after = coveragePlan({ leaves, weights: lengthWeights(leaves), level: 'standard' }).plan.goal;
  assert.equal(before, 343, 'what both languages used to say');
  assert.equal(after, Math.round(6 * evidence / 10000), 'the density is over the evidence');
  assert.ok(after < before * 0.8, `standard: ${before} -> ${after}`);
  const lean = strengthPlan(leaves, lengthWeights(leaves), 'lean').goal, full = strengthPlan(leaves, lengthWeights(leaves), 'full').goal;
  assert.ok(lean < 172 && full < 500, `lean ${lean}, full ${full}`);
  assert.equal(strengthPlan(leaves, lengthWeights(leaves), 'standard').perTenK, 6);
});

test('weights, the importance prompt, the coverage numbers and the form count evidence too', () => {
  const [first] = weightChunks(leaves, world.sources);
  assert.ok(first.evidence.every((item, at) => item.chars === leaves[at].evidenceChars && item.chars < leaves[at].chars), 'the model is told the evidence size');
  const view = coverageOf({ sources: world.sources, cards: [] });
  assert.equal(view.sections.reduce((sum, section) => sum + section.evidenceChars, 0), evidence);
  const stats = form.selectionStats(world.sources.map(source => ({ ...source, format: 'text' })), world.sources.map(source => source.id));
  assert.equal(stats.chars, world.sources.reduce((sum, source) => sum + source.text.length - nonEvidenceRanges(source.text).reduce((lost, [from, to]) => lost + to - from, 0), 0));
  assert.ok(form.suggestCount(stats, 'standard') < 343);
});
