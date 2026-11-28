import { run } from 'node:test';

/** Files with real browser frame budgets and quarantined suites must run without CPU competition from this suite's other workers. */
export function runWithTimingFiles(options, timingFiles, isolatedFiles = []) {
  const timing = timingFiles.filter(Boolean);
  const timingSet = new Set(timing);
  const isolated = isolatedFiles.filter(file => file && !timingSet.has(file));
  const exclusive = new Set([...timing, ...isolated]);
  const regular = options.files.filter(file => !exclusive.has(file));
  const phases = [];
  if (timing.length) phases.push({ files: timing, concurrency: 1 });
  if (regular.length) phases.push({ files: regular, concurrency: options.concurrency });
  if (isolated.length) phases.push({ files: isolated, concurrency: 1 });
  if (!phases.length) return run(options);
  if (phases.length === 1) return run({ ...options, ...phases[0] });
  return joinRuns(options, phases);
}

/** Node emits one root plan and summary per run. Keep all per-file events and give TAP, spec, JUnit and custom reporters
 * one correctly numbered root, with the native pass/fail, skip and cancellation counts from both runs. */
async function* joinRuns(options, phases) {
  let offset = 0, duration = 0, success = true;
  const totals = {}, diagnostics = new Map();
  for (const phase of phases) {
    if (options.signal?.aborted) break;
    let count;
    for await (const event of run({ ...options, ...phase })) {
      const { type, data } = event;
      if (!data.file && type === 'test:plan' && data.nesting === 0) {
        count = data.count;
      } else if (!data.file && type === 'test:summary') {
        success &&= data.success;
        duration += data.duration_ms;
        for (const [key, value] of Object.entries(data.counts)) totals[key] = (totals[key] || 0) + value;
      } else if (count !== undefined && !data.file && type === 'test:diagnostic' && data.nesting === 0
          && /^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [\d.]+$/.test(data.message)) {
        const [label, value] = data.message.split(' ');
        diagnostics.set(label, (diagnostics.get(label) || 0) + Number(value));
      } else if (offset && data.nesting === 0 && Number.isInteger(data.testNumber)) {
        yield { type, data: { ...data, testNumber: offset + data.testNumber } };
      } else {
        yield event;
      }
    }
    offset += count ?? 0;
  }
  yield { type: 'test:plan', data: { nesting: 0, count: offset } };
  for (const [label, value] of diagnostics) {
    yield { type: 'test:diagnostic', data: { nesting: 0, message: `${label} ${value}`, level: 'info' } };
  }
  yield { type: 'test:summary', data: { success, counts: totals, duration_ms: duration } };
}
