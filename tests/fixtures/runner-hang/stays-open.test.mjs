import test from 'node:test';

/* A fixture suite for tests/test-runner-timeout.test.mjs: every test passes, but a handle left open keeps the file's process alive. */
test('passes and leaves a timer running', () => { setInterval(() => {}, 1000); });
