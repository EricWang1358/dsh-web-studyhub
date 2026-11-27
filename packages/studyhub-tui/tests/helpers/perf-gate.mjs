// Shared CPU-time sampling, quantile aggregation, relative baseline, and jitter-injection
// test helper for TUI performance budgets (`perf-budget.test.mjs`, `scale-nfr.test.mjs`).
import assert from 'node:assert/strict';

/** Process CPU clock (`user + system` in ms). Immune to off-CPU OS scheduling preemption. */
export const cpuClock = Object.freeze({
  name: 'cpu',
  start: () => process.cpuUsage(),
  elapsedMs: (token) => {
    const used = process.cpuUsage(token);
    return (used.user + used.system) / 1000;
  },
});

/** Monotonic wall clock (`performance.now()` in ms). Vulnerable to OS preemption stalls. */
export const wallClock = Object.freeze({
  name: 'wall',
  start: () => performance.now(),
  elapsedMs: (token) => performance.now() - token,
});

/**
 * Wraps a base clock with deterministic additive stall spikes (ms per sample) so flake-repro
 * tests can simulate OS scheduling preemption / GC jitter without real sleeps.
 */
export function createJitteredClock(spikeScheduleMs, baseClock = wallClock) {
  let index = 0;
  return {
    name: `${baseClock.name}+jitter`,
    start: () => baseClock.start(),
    elapsedMs: (token) => {
      const base = baseClock.elapsedMs(token);
      const spike = spikeScheduleMs[index % spikeScheduleMs.length] ?? 0;
      index += 1;
      return base + spike;
    },
  };
}

export function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function trimmedMean(sorted, trimFraction = 0.2) {
  if (sorted.length === 0) return 0;
  const trim = Math.floor(sorted.length * trimFraction);
  const slice = sorted.slice(trim, sorted.length - trim);
  const target = slice.length > 0 ? slice : sorted;
  let sum = 0;
  for (let i = 0; i < target.length; i++) sum += target[i];
  return sum / target.length;
}

const DEFAULT_MIN_BATCH_CPU_MS = process.platform === 'win32' ? 64 : 4;

/**
 * Adaptively scale `batch` so a single CPU measurement bracket spans enough CPU time to
 * clear OS timer quantization (notably Windows `GetProcessTimes` 15.625ms ticks), while
 * staying bounded in both iteration count and wall time.
 */
function calibrateClockBatch(
  fn,
  {
    batch = 1,
    clock = cpuClock,
    minBatchCpuMs = DEFAULT_MIN_BATCH_CPU_MS,
    maxBatch = 100_000,
    maxCalibrateWallMs = 250,
  } = {},
) {
  let effectiveBatch = Math.max(1, Math.floor(batch));
  let lastValue;
  if (!(minBatchCpuMs > 0)) {
    return { batch: effectiveBatch, lastValue };
  }

  let targetMs = minBatchCpuMs;
  const upperBatch = Math.max(effectiveBatch, Math.floor(maxBatch));
  const wallStart = performance.now();
  let sawZeroTick = false;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = clock.start();
    for (let b = 0; b < effectiveBatch; b += 1) lastValue = fn();
    const elapsedMs = clock.elapsedMs(token);

    if (elapsedMs === 0) {
      sawZeroTick = true;
    } else if (sawZeroTick && elapsedMs >= 10) {
      targetMs = Math.max(targetMs, elapsedMs * 4);
      sawZeroTick = false;
    }

    if (elapsedMs >= targetMs || effectiveBatch >= upperBatch) {
      break;
    }
    if (performance.now() - wallStart >= maxCalibrateWallMs) {
      break;
    }

    const factor = elapsedMs > 0 ? Math.max(2, Math.ceil(targetMs / elapsedMs)) : 2;
    effectiveBatch = Math.min(upperBatch, effectiveBatch * factor);
  }

  return { batch: effectiveBatch, lastValue };
}

/**
 * Runs warmup iterations followed by multi-sample batched measurements using `clock` (default:
 * `process.cpuUsage()`), returning sorted quantile and trimmed-mean statistics in ms per call.
 */
export function sampleTiming(fn, opts = {}) {
  const {
    warmup = 3,
    samples = 9,
    batch = 1,
    clock = cpuClock,
    beforeSample,
    minBatchCpuMs,
    maxBatch = 100_000,
  } = opts;

  let lastValue;
  for (let w = 0; w < warmup; w++) {
    if (beforeSample) beforeSample();
    lastValue = fn();
  }

  const shouldCalibrate =
    !beforeSample && (minBatchCpuMs !== undefined ? minBatchCpuMs > 0 : clock === cpuClock);
  let effectiveBatch = Math.max(1, Math.floor(batch));
  if (shouldCalibrate) {
    const calibrated = calibrateClockBatch(fn, {
      batch: effectiveBatch,
      clock,
      minBatchCpuMs: minBatchCpuMs ?? DEFAULT_MIN_BATCH_CPU_MS,
      maxBatch,
    });
    effectiveBatch = calibrated.batch;
    if (calibrated.lastValue !== undefined) lastValue = calibrated.lastValue;
  }

  const raw = new Array(samples);
  for (let i = 0; i < samples; i++) {
    if (beforeSample) beforeSample();
    const token = clock.start();
    for (let b = 0; b < effectiveBatch; b++) {
      lastValue = fn();
    }
    raw[i] = clock.elapsedMs(token) / effectiveBatch;
  }

  const sorted = raw.slice().sort((a, b) => a - b);
  const p50 = quantile(sorted, 0.5);
  return {
    clock: clock.name ?? 'custom',
    batch: effectiveBatch,
    samples: raw,
    sorted,
    min: sorted[0] ?? 0,
    median: p50,
    p50,
    trimmedMean: trimmedMean(sorted),
    max: sorted[sorted.length - 1] ?? 0,
    lastValue,
  };
}

/**
 * Evaluates `fn` with warmup + multi-sample CPU timing and asserts the chosen robust statistic
 * (`median` by default) stays strictly below `budgetMs`.
 */
export function assertPerfBudget(label, fn, budgetMs, opts = {}) {
  const stat = opts.stat ?? 'median';
  const result = sampleTiming(fn, opts);
  const measured = result[stat];
  assert.ok(
    measured < budgetMs,
    `${label} ${stat} ${measured.toFixed(3)}ms (${result.clock}) exceeded budget < ${budgetMs}ms ` +
      `[min=${result.min.toFixed(3)}ms, p50=${result.p50.toFixed(3)}ms, max=${result.max.toFixed(3)}ms, batch=${result.batch}]`,
  );
  return result;
}

/**
 * Interleaved paired relative-performance gate comparing `fastFn` against `refFn` under the same
 * clock (`cpuClock` by default). Supports `minSpeedup` (`fast * minSpeedup < ref`) and/or
 * `maxRatio` (`fast <= ref * maxRatio`).
 */
export function assertRelativePerf(label, fastFn, refFn, opts = {}) {
  const {
    warmup = 3,
    samples = 9,
    fastBatch = 1,
    refBatch = 1,
    clock = cpuClock,
    stat = 'median',
    minSpeedup,
    maxRatio,
    fastBudgetMs,
    beforeFast,
    beforeRef,
    minBatchCpuMs,
    maxBatch = 100_000,
  } = opts;

  let lastFast;
  let lastRef;
  for (let w = 0; w < warmup; w++) {
    if (beforeFast) beforeFast();
    lastFast = fastFn();
    if (beforeRef) beforeRef();
    lastRef = refFn();
  }

  const shouldCalibrate = minBatchCpuMs !== undefined ? minBatchCpuMs > 0 : clock === cpuClock;
  const targetMinBatchMs = minBatchCpuMs ?? DEFAULT_MIN_BATCH_CPU_MS;

  let effectiveFastBatch = Math.max(1, Math.floor(fastBatch));
  if (shouldCalibrate && !beforeFast) {
    const calFast = calibrateClockBatch(fastFn, {
      batch: effectiveFastBatch,
      clock,
      minBatchCpuMs: targetMinBatchMs,
      maxBatch,
    });
    effectiveFastBatch = calFast.batch;
    if (calFast.lastValue !== undefined) lastFast = calFast.lastValue;
  }

  let effectiveRefBatch = Math.max(1, Math.floor(refBatch));
  if (shouldCalibrate && !beforeRef) {
    const calRef = calibrateClockBatch(refFn, {
      batch: effectiveRefBatch,
      clock,
      minBatchCpuMs: targetMinBatchMs,
      maxBatch,
    });
    effectiveRefBatch = calRef.batch;
    if (calRef.lastValue !== undefined) lastRef = calRef.lastValue;
  }

  const fastRaw = new Array(samples);
  const refRaw = new Array(samples);
  for (let i = 0; i < samples; i++) {
    if (beforeFast) beforeFast();
    const ft = clock.start();
    for (let b = 0; b < effectiveFastBatch; b++) lastFast = fastFn();
    fastRaw[i] = clock.elapsedMs(ft) / effectiveFastBatch;

    if (beforeRef) beforeRef();
    const rt = clock.start();
    for (let b = 0; b < effectiveRefBatch; b++) lastRef = refFn();
    refRaw[i] = clock.elapsedMs(rt) / effectiveRefBatch;
  }

  const summarize = (raw, lastValue, batch) => {
    const sorted = raw.slice().sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    return {
      clock: clock.name ?? 'custom',
      batch,
      samples: raw,
      sorted,
      min: sorted[0] ?? 0,
      median: p50,
      p50,
      trimmedMean: trimmedMean(sorted),
      max: sorted[sorted.length - 1] ?? 0,
      lastValue,
    };
  };

  const fast = summarize(fastRaw, lastFast, effectiveFastBatch);
  const ref = summarize(refRaw, lastRef, effectiveRefBatch);
  const fastMs = fast[stat];
  const refMs = ref[stat];
  const speedup = refMs / Math.max(fastMs, 1e-6);

  if (fastBudgetMs !== undefined) {
    assert.ok(
      fastMs < fastBudgetMs,
      `${label} fast ${stat} ${fastMs.toFixed(3)}ms (${fast.clock}) exceeded budget < ${fastBudgetMs}ms`,
    );
  }
  if (minSpeedup !== undefined) {
    assert.ok(
      fastMs * minSpeedup < refMs,
      `${label} expected >=${minSpeedup}x speedup (fast=${fastMs.toFixed(4)}ms, ref=${refMs.toFixed(4)}ms, ratio=${speedup.toFixed(2)}x, clock=${fast.clock})`,
    );
  }
  if (maxRatio !== undefined) {
    assert.ok(
      fastMs <= refMs * maxRatio,
      `${label} expected fast (${fastMs.toFixed(4)}ms) <= ${maxRatio}x ref (${refMs.toFixed(4)}ms, clock=${fast.clock})`,
    );
  }
  return { fast, ref, speedup };
}
