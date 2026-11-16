import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../scripts/qa/test-schedule.mjs';
import {
  CORE_GUARDRAIL_TESTS,
  buildReverseDependencyGraph,
  extractLiteralPathRefs,
  selectSmartTests,
} from '../scripts/qa/test-smart.mjs';

test('every declared core guardrail test exists on disk', () => {
  assert.ok(CORE_GUARDRAIL_TESTS.length >= 25);
  assert.equal(new Set(CORE_GUARDRAIL_TESTS).size, CORE_GUARDRAIL_TESTS.length, 'no duplicate core entries');
  for (const rel of CORE_GUARDRAIL_TESTS) {
    assert.ok(existsSync(join(repoRoot, rel)), `core guardrail exists: ${rel}`);
  }
});

test('extractLiteralPathRefs resolves relative and repo-rooted string paths inside test files', () => {
  const src = `
    const ui = await loadUi('./ui/companions/CompanionViewer.jsx');
    const skill = await readFile('skills/study-companion/SKILL.md', 'utf8');
    import helper from './helpers/audio-console.mjs';
  `;
  const refs = extractLiteralPathRefs(src, 'tests/interactive-companions.test.mjs');
  assert.ok(refs.includes('ui/companions/CompanionViewer.jsx'));
  assert.ok(refs.includes('skills/study-companion/SKILL.md'));
  assert.ok(refs.includes('tests/helpers/audio-console.mjs'));
});

test('selectSmartTests includes core guardrails, direct & transitive importers, and damps megahubs', () => {
  const allTestKeys = [
    ...CORE_GUARDRAIL_TESTS,
    'tests/oral-exam.test.mjs',
    'tests/companion-extra.test.mjs',
    'tests/unrelated-a.test.mjs',
    'tests/unrelated-b.test.mjs',
    'tests/slow-browser.test.mjs',
  ];
  const reverseGraph = new Map([
    ['lib/companion/companions.js', new Set(['lib/companion/companion-operations.js'])],
    ['lib/companion/companion-operations.js', new Set(['tests/companion-extra.test.mjs', 'lib/service.js'])],
    // Simulate lib/service.js as a megahub with 60 importers
    ['lib/service.js', new Set(Array.from({ length: 60 }, (_, i) => (i === 0 ? 'tests/unrelated-a.test.mjs' : `tests/hub-${i}.test.mjs`)))],
    ['ui/WrongBook.jsx', new Set(['tests/slow-browser.test.mjs'])],
  ]);
  const slowSet = new Set(['tests/lib-graph.test.mjs', 'tests/slow-browser.test.mjs']);

  const coreRes = selectSmartTests({ mode: 'core', allTestKeys, slowSet });
  assert.equal(coreRes.affectedCount, 0);
  assert.equal(coreRes.selected.length, CORE_GUARDRAIL_TESTS.length);
  assert.ok(coreRes.selected.includes('tests/lib-graph.test.mjs'), 'core guardrails always run even if listed in slowSet');

  const smartRes = selectSmartTests({
    mode: 'smart',
    changedPaths: ['lib/companion/companions.js', 'lib/oral-exam.js', 'ui/WrongBook.jsx'],
    allTestKeys,
    reverseGraph,
    slowSet,
  });

  assert.ok(smartRes.selected.includes('tests/companion-extra.test.mjs'), 'transitive non-hub importer selected');
  assert.ok(smartRes.selected.includes('tests/oral-exam.test.mjs'), 'stem-matched test selected');
  assert.ok(!smartRes.selected.includes('tests/unrelated-a.test.mjs'), 'megahub damped from transitive explosion');
  assert.ok(!smartRes.selected.includes('tests/slow-browser.test.mjs'), 'slow browser test skipped unless includeSlow');
});

test('buildReverseDependencyGraph maps real repository companion modules back to tests/interactive-companions.test.mjs', async () => {
  const graph = await buildReverseDependencyGraph(repoRoot);
  const directImporters = graph.get('lib/companion/companions.js');
  assert.ok(directImporters?.has('tests/interactive-companions.test.mjs'));
});
