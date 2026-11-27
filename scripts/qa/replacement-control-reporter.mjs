// Emit only completed test cases. Node wraps the original assertion in ERR_TEST_FAILURE.
export function controlVerdict(names, red, green, message) {
  const completed = (run, name) => run.cases.find(row => row.name === name && !row.skipped);
  const recovered = names.length > 0 && green.status === 0 && names.every(name => completed(green, name)?.passed);
  const broken = names.map(name => completed(red, name));
  if (!recovered || !broken.every(row => row && (row.passed || row.code === 'ERR_ASSERTION'))) return 'INVALID';
  if (red.status === 0 && broken.every(row => row.passed)) return 'SURVIVED';
  const observed = broken.some(row => !row.passed && (!message || row.message?.includes(message)));
  return red.status === 1 && observed ? 'CAUGHT' : 'INVALID';
}

export default async function* report(events) {
  for await (const { type, data } of events) {
    if (type === 'test:stderr' || type === 'test:stdout') {
      yield JSON.stringify({ diagnostic: data.message }) + '\n';
      continue;
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const error = data.details?.error;
    const cause = error?.cause ?? error;
    yield JSON.stringify({
      name: data.name,
      passed: type === 'test:pass',
      skipped: Boolean(data.skip || data.todo),
      code: cause?.code,
      message: cause?.message ?? error?.message,
    }) + '\n';
  }
}
