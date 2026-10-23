import test from 'node:test';

/* A fixture suite for tests/test-runner-timeout.test.mjs: each subtest is under the limit, the parent's total is over it. */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('slow parent', async t => {
  await t.test('sub a', () => sleep(700));
  await t.test('sub b', () => sleep(700));
});
