import test from 'node:test';
import { appendFileSync } from 'node:fs';

/* A fixture suite for tests/test-runner-timeout.test.mjs: one test passes, the next never settles (a timer keeps the process alive). */
test('passes first', () => {});
test('never settles', () => new Promise(() => {
  if (process.env.STUDY_FIXTURE_LOG) appendFileSync(process.env.STUDY_FIXTURE_LOG, 'hang started\n');
  setInterval(() => {}, 1000);
}));
test('never reached', () => {});
