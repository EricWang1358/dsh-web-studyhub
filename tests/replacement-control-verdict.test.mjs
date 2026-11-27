import assert from 'node:assert/strict';
import test from 'node:test';
import { controlVerdict } from '../scripts/qa/replacement-control-reporter.mjs';

test('a defect only counts when the same active case fails an assertion and passes after restoration', () => {
  const name = 'second report';
  const names = [name];
  const pass = { name, passed: true };
  const fail = { name, passed: false, code: 'ERR_ASSERTION', message: 'prior notice is visible' };
  const run = (status, ...cases) => ({ status, cases });
  const clean = run(0, pass);
  assert.equal(controlVerdict(names, run(1, fail), clean, 'prior notice'), 'CAUGHT');
  assert.equal(controlVerdict(names, clean, clean), 'SURVIVED');
  assert.equal(controlVerdict(names, run(1, fail), clean, 'wrong assertion'), 'INVALID');
  assert.equal(controlVerdict(names, run(1, { ...fail, code: 'ERR_MODULE_NOT_FOUND' }), clean), 'INVALID');
  assert.equal(controlVerdict(names, run(1, { ...fail, name: 'unrelated test' }), clean), 'INVALID');
  assert.equal(controlVerdict(names, run(1, fail), run(0, { ...pass, skipped: true })), 'INVALID');
  assert.equal(controlVerdict(names, run(1, fail), run(1, fail)), 'INVALID');
  assert.equal(controlVerdict([...names, 'test moved to a helper'], run(1, fail), clean), 'INVALID');
});
