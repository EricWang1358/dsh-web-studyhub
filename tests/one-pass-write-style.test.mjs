import test from 'node:test';
import assert from 'node:assert/strict';
import { writePrompts } from '../lib/one-pass/prompts.js';
import { WRITE_STYLES, DEFAULT_WRITE_STYLE, writeStyleText } from '../lib/one-pass/write-style.js';
import { WRITE_STYLE_NAMES } from '../lib/one-pass/write-style-names.js';
import { writePortion } from '../lib/one-pass/portion.js';
import { onePassModel, material, writeAll } from './helpers/one-pass-model.mjs';

const request = { language: 'zh-CN', difficulty: 'mixed' };
const sections = [{ label: 'S1', title: 'One', quota: 2, pieces: [{ title: 'One', text: 'A rule holds unless its condition fails.', section: 'S1' }] }];

test('every style name has its wording, and nothing else: the settings validate by the names alone (they do not carry the prompts to the UI)', () => {
  assert.deepEqual(Object.keys(WRITE_STYLES), [...WRITE_STYLE_NAMES]);
  assert.ok(WRITE_STYLE_NAMES.includes(DEFAULT_WRITE_STYLE));
});

test('the one-pass write call asks in the scenario style by default', () => {
  assert.equal(writeStyleText(undefined), WRITE_STYLES.scenario);
  const { prompt } = writePrompts(request, sections);
  assert.equal(prompt, writePrompts(request, sections, [], { style: 'scenario' }).prompt);
  assert.match(prompt, /WHAT TO TEST\./);
  assert.match(prompt, /HOW TO ASK\./);
  assert.match(prompt, /EXPLANATION\. Four moves/);
  assert.doesNotMatch(prompt, /Where the point allows it/);
});

test('the plainer quick wording stays reachable by its style key', () => {
  const { prompt } = writePrompts(request, sections, [], { style: 'quick' });
  assert.match(prompt, /Where the point allows it, put the learner in a small concrete situation/);
  assert.doesNotMatch(prompt, /WHAT TO TEST\./);
});

test('an unknown style falls back to the default wording', () => {
  assert.equal(writeStyleText('nope'), WRITE_STYLES.scenario);
  assert.deepEqual(Object.keys(WRITE_STYLES), ['scenario', 'quick']);
});

/* The style reaches every write call of a run (lib/one-pass/portion.js reads it from the request's performance): the portion's write, the re-ask of a section left
   empty, and the second ask of a reply that could not be read. The rewrite of the options carries no style: it only evens the options of cards already written. */
const QUICK_LINE = /Where the point allows it, put the learner in a small concrete situation/;
const asked = (style, extra = {}) => {
  const world = material({ sections: 3, quota: 2 });
  const model = onePassModel({
    write: (data, number) => number === 2 ? writeAll({ ...data, sections: data.sections.filter(item => item.section !== 'S3') }) : writeAll(data),
    raw: { write: (data, number) => (number === 1 ? 'not json at all' : undefined) }, ...extra });
  return { model, done: writePortion({ complete: model.complete, request: { kind: 'quiz', language: 'English', sources: [world.source], performance: style ? { writeStyle: style } : undefined },
    assignments: world.assignments, random: () => 0.5 }) };
};

test('the quick style reaches the write call, its second ask and the re-ask of an empty section', async () => {
  const { model, done } = asked('quick');
  await done;
  const writes = model.calls.filter(call => call.stage === 'write');
  assert.equal(writes.length, 3, 'the write, its second ask (the first reply unreadable), then S3 alone');
  assert.equal(writes[1].context.retry, 1);
  assert.equal(writes[2].context.unit, 'section-S3');
  for (const write of writes) { assert.match(write.prompt, QUICK_LINE); assert.doesNotMatch(write.prompt, /WHAT TO TEST\./); }
});

test('without a style in the request, every write call asks in the scenario style', async () => {
  const { model, done } = asked(undefined);
  await done;
  const writes = model.calls.filter(call => call.stage === 'write');
  assert.equal(writes.length, 3);
  for (const write of writes) { assert.match(write.prompt, /WHAT TO TEST\./); assert.doesNotMatch(write.prompt, QUICK_LINE); }
});
