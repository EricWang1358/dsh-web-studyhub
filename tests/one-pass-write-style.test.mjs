import test from 'node:test';
import assert from 'node:assert/strict';
import { writePrompts } from '../lib/one-pass/prompts.js';
import { WRITE_STYLES, DEFAULT_WRITE_STYLE, writeStyleText } from '../lib/one-pass/write-style.js';

const request = { language: 'zh-CN', difficulty: 'mixed' };
const sections = [{ label: 'S1', title: 'One', quota: 2, pieces: [{ title: 'One', text: 'A rule holds unless its condition fails.', section: 'S1' }] }];

test('the one-pass write call asks in the scenario style by default', () => {
  assert.equal(DEFAULT_WRITE_STYLE, 'scenario');
  const { prompt } = writePrompts(request, sections);
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
