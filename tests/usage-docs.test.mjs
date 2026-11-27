import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { USAGE_LIMITS, usageFrequencyPath } from '../lib/usage-frequency.js';
import { buildReport } from '../lib/usage-report.js';
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

function makeCell(days) {
  const entries = Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1));
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return { total, older: 0, last: entries.at(-1)?.[0] || '', days };
}

test('the observation rules and thresholds the document describes are the ones the code uses', () => {
  const today = '2026-11-20';
  const baseline = {
    'nav.library': makeCell({ '2026-11-18': 8, '2026-11-19': 8, '2026-11-20': 8 }),
  };

  // Frequency + day-spread threshold: requires n >= 8 AND days >= 3 (both quiet-busy and shortcut rules).
  const belowCount = buildReport({
    since: '2026-11-10',
    controls: {
      ...baseline,
      'nav.notes': makeCell({ '2026-11-18': 3, '2026-11-19': 2, '2026-11-20': 2 }), // n=7, days=3
      'review.flip': makeCell({ '2026-11-18': 3, '2026-11-19': 2, '2026-11-20': 2 }), // n=7, days=3
    },
    areas: {},
  }, { period: 30, today, language: 'en' });
  assert.equal(belowCount.observations.some((o) => o.id === 'quiet-busy' && o.key === 'nav.notes'), false, 'n=7, days=3 stays below quiet-busy threshold');
  assert.equal(belowCount.observations.some((o) => o.id === 'shortcut' && o.key === 'review.flip'), false, 'n=7, days=3 stays below shortcut threshold');

  const belowDays = buildReport({
    since: '2026-11-10',
    controls: {
      ...baseline,
      'nav.notes': makeCell({ '2026-11-19': 4, '2026-11-20': 4 }), // n=8, days=2
      'review.flip': makeCell({ '2026-11-19': 4, '2026-11-20': 4 }), // n=8, days=2
    },
    areas: {},
  }, { period: 30, today, language: 'en' });
  assert.equal(belowDays.observations.some((o) => o.id === 'quiet-busy' && o.key === 'nav.notes'), false, 'n=8, days=2 stays below quiet-busy threshold');
  assert.equal(belowDays.observations.some((o) => o.id === 'shortcut' && o.key === 'review.flip'), false, 'n=8, days=2 stays below shortcut threshold');

  const meetsFreqAndDays = buildReport({
    since: '2026-11-10',
    controls: {
      ...baseline,
      'nav.notes': makeCell({ '2026-11-18': 3, '2026-11-19': 3, '2026-11-20': 2 }), // n=8, days=3
      'review.flip': makeCell({ '2026-11-18': 3, '2026-11-19': 3, '2026-11-20': 2 }), // n=8, days=3
    },
    areas: {},
  }, { period: 30, today, language: 'en' });
  assert.equal(meetsFreqAndDays.observations.some((o) => o.id === 'quiet-busy' && o.key === 'nav.notes'), true, 'n=8, days=3 triggers quiet-busy observation');
  assert.equal(meetsFreqAndDays.observations.some((o) => o.id === 'shortcut' && o.key === 'review.flip'), true, 'n=8, days=3 triggers shortcut observation');

  // Share threshold for top-control: requires share >= 30% (0.3).
  const belowShare = buildReport({
    since: '2026-11-10',
    controls: {
      'nav.library': makeCell({ '2026-11-18': 10, '2026-11-19': 10, '2026-11-20': 9 }), // 29 / 100 = 29%
      'nav.wrongbook': makeCell({ '2026-11-18': 9, '2026-11-19': 8, '2026-11-20': 8 }), // 25
      'nav.sources': makeCell({ '2026-11-18': 9, '2026-11-19': 8, '2026-11-20': 8 }), // 25
      'nav.generate': makeCell({ '2026-11-18': 7, '2026-11-19': 7, '2026-11-20': 7 }), // 21
    },
    areas: {},
  }, { period: 30, today, language: 'en' });
  assert.equal(belowShare.observations.some((o) => o.id === 'top-control'), false, '29% share stays below top-control threshold');

  const meetsShare = buildReport({
    since: '2026-11-10',
    controls: {
      'nav.library': makeCell({ '2026-11-18': 10, '2026-11-19': 10, '2026-11-20': 10 }), // 30 / 100 = 30%
      'nav.wrongbook': makeCell({ '2026-11-18': 9, '2026-11-19': 8, '2026-11-20': 8 }), // 25
      'nav.sources': makeCell({ '2026-11-18': 9, '2026-11-19': 8, '2026-11-20': 8 }), // 25
      'nav.generate': makeCell({ '2026-11-18': 7, '2026-11-19': 7, '2026-11-20': 6 }), // 20
    },
    areas: {},
  }, { period: 30, today, language: 'en' });
  const topObs = meetsShare.observations.find((o) => o.id === 'top-control');
  assert.ok(topObs, '30% share triggers top-control observation');
  assert.equal(topObs.key, 'nav.library');
  assert.match(topObs.text, /30%/);

  assert.match(en, /8\+ times/);
  assert.match(en, /3\+ days/);
  assert.match(en, /30%/);
});
