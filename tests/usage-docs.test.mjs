import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { USAGE_LIMITS, usageFrequencyPath } from '../lib/usage-frequency.js';
import { usageFrequencySchemas } from '../lib/contexts/system/contracts.js';

/* docs/usage-frequency.md (+ zh) state what the product guarantees. These tests keep the numbers and names in step with the code. */

const [en, zh] = await Promise.all(['docs/usage-frequency.md', 'docs/usage-frequency.zh-CN.md'].map(path => readFile(path, 'utf8')));
const files = JSON.parse(await readFile('package.json', 'utf8')).files;

test('both documents name every operation, the file and the limits of the code', () => {
  for (const doc of [en, zh]) {
    for (const name of Object.keys(usageFrequencySchemas)) assert.ok(doc.includes(`\`${name}\``), name);
    assert.ok(doc.includes('study/usage-frequency.json'));
    assert.ok(doc.includes(String(USAGE_LIMITS.keys)), 'the key cap');
    assert.ok(doc.includes(String(USAGE_LIMITS.days)), 'the day window');
    assert.ok(doc.includes('24,000') && USAGE_LIMITS.cells === 24000);
    assert.ok(doc.includes(String(USAGE_LIMITS.recordsPerBatch)));
    assert.ok(doc.includes('150'));
    assert.ok(doc.includes('2.5.2'), 'developer-side aggregation is announced, not built');
  }
  assert.match(usageFrequencyPath(), /study[\\/]usage-frequency\.json$/);
});

test('the privacy contract is stated in both languages', () => {
  for (const needle of [/Off by default/, /never sends it anywhere|never sent anywhere|StudyHub never sends it/i, /not in your library/i, /text field/, /own sentences/, /assistant cannot see or change it/i]) assert.match(en, needle);
  for (const needle of [/默认关闭/, /从不把它发送到任何地方/, /不在学习库里/, /文本输入框/, /应用自己的文案/, /助手看不到、也改不了/]) assert.match(zh, needle);
});

test('the documents link each other and ship with the package', () => {
  assert.match(en, /\]\(usage-frequency\.zh-CN\.md\)/);
  assert.match(zh, /\]\(usage-frequency\.md\)/);
  assert.match(en, /\]\(feature-tiers\.md\)/);
  for (const name of ['docs/usage-frequency.md', 'docs/usage-frequency.zh-CN.md']) assert.ok(files.includes(name), name);
});

test('the observation rules and thresholds the document describes are the ones the code uses', async () => {
  const code = await readFile('lib/usage-report.js', 'utf8');
  assert.match(code, /item\.n >= 8 && item\.days >= 3/);
  assert.match(code, /30%|0\.3/);
  assert.match(en, /8\+ times/);
  assert.match(en, /3\+ days/);
  assert.match(en, /30%/);
});
