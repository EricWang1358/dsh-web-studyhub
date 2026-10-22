/* A custom reporter module for tests/test-runner-timeout.test.mjs: a generator function, the other kind node --test takes besides a stream. */
export default async function* countingReporter(source) {
  let passed = 0;
  for await (const event of source) if (event.type === 'test:pass') passed++;
  yield `custom reporter: ${passed} passed\n`;
}
