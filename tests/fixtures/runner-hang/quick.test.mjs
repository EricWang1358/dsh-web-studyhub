import test from 'node:test';

/* A fixture suite for tests/test-runner-timeout.test.mjs: a file that finishes. */
test('quick', async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
