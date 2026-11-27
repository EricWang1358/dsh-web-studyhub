import assert from "node:assert/strict";

/**
 * Shared performance-gate helpers for root tests (see docs/performance.md).
 *
 * Uses warmed, batched `process.cpuUsage()` sampling + median aggregation so OS
 * scheduling preemptions on shared/parallel CI runners do not inflate timings,
 * while genuine CPU regressions still fail decisively.
 */

const cpuDeltaMs = (used) => (used.user + used.system) / 1000;
const DEFAULT_MIN_BATCH_CPU_MS = process.platform === "win32" ? 64 : 4;

/**
 * Adaptively scale `batch` so a single `cpuUsage()` bracket spans enough CPU time to clear
 * OS timer quantization (notably Windows `GetProcessTimes` 15.625ms ticks), while staying
 * bounded in both iteration count and wall time.
 */
function calibrateCpuBatch(
  fn,
  {
    batch = 1,
    cpuUsage = process.cpuUsage,
    minBatchCpuMs = DEFAULT_MIN_BATCH_CPU_MS,
    maxBatch = 100_000,
    maxCalibrateWallMs = 250,
  } = {},
) {
  let effectiveBatch = Math.max(1, Math.floor(batch));
  let last;
  if (!(minBatchCpuMs > 0)) {
    return { batch: effectiveBatch, last };
  }

  let targetMs = minBatchCpuMs;
  const upperBatch = Math.max(effectiveBatch, Math.floor(maxBatch));
  const wallStart = performance.now();
  let sawZeroTick = false;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = cpuUsage();
    for (let b = 0; b < effectiveBatch; b += 1) last = fn();
    const elapsedMs = cpuDeltaMs(cpuUsage(before));

    if (elapsedMs === 0) {
      sawZeroTick = true;
    } else if (sawZeroTick && elapsedMs >= 10) {
      // Dynamic coarse-tick detection (real or simulated 15.625ms Windows GetProcessTimes):
      // require >= 4 clock quanta per batch so ratio gates never see 0.000ms or 1-tick spikes.
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

  return { batch: effectiveBatch, last };
}

function summarize(readings, value, batch) {
  const sorted = [...readings].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  return {
    value,
    batch,
    median,
    p90,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples: sorted,
  };
}

/**
 * Measure per-call CPU time (ms) using warmed, adaptively-batched `process.cpuUsage()` samples.
 * Accepts an injectable `cpuUsage` hook so flake-reproduction tests can verify
 * behavior deterministically alongside real CPU measurements.
 */
export function measureCpuBatched(
  fn,
  {
    warmup = 5,
    samples = 7,
    batch = 10,
    cpuUsage = process.cpuUsage,
    minBatchCpuMs = DEFAULT_MIN_BATCH_CPU_MS,
    maxBatch = 100_000,
  } = {},
) {
  let last;
  for (let i = 0; i < warmup; i += 1) last = fn();

  const calibrated = calibrateCpuBatch(fn, { batch, cpuUsage, minBatchCpuMs, maxBatch });
  const effectiveBatch = calibrated.batch;
  if (calibrated.last !== undefined) last = calibrated.last;

  const readings = [];
  for (let s = 0; s < samples; s += 1) {
    const before = cpuUsage();
    for (let b = 0; b < effectiveBatch; b += 1) last = fn();
    const used = cpuUsage(before);
    readings.push(cpuDeltaMs(used) / effectiveBatch);
  }

  return summarize(readings, last, effectiveBatch);
}

/**
 * Measure per-call wall-clock time (ms) using an injectable `now` clock.
 * Intended for diagnostics and flake-reproduction tests demonstrating why
 * single-shot wall-clock gates flake under OS preemption jitter.
 */
export function measureWallSamples(
  fn,
  { warmup = 5, samples = 21, now = () => performance.now() } = {},
) {
  let last;
  for (let i = 0; i < warmup; i += 1) last = fn();

  const readings = [];
  for (let i = 0; i < samples; i += 1) {
    const started = now();
    last = fn();
    readings.push(now() - started);
  }

  return summarize(readings, last);
}

/**
 * Enforce a strict CPU-time median budget (and optional relative ratio against a
 * reference workload) via batched `process.cpuUsage()` sampling.
 */
export function assertCpuBudget(
  fn,
  {
    maxMedianMs,
    warmup = 5,
    samples = 7,
    batch = 10,
    cpuUsage = process.cpuUsage,
    minBatchCpuMs = DEFAULT_MIN_BATCH_CPU_MS,
    maxBatch = 100_000,
    label = "operation",
    referenceFn = null,
    maxRatio = null,
    minReferenceMs = 0.05,
  } = {},
) {
  const stats = measureCpuBatched(fn, { warmup, samples, batch, cpuUsage, minBatchCpuMs, maxBatch });
  if (Number.isFinite(maxMedianMs)) {
    assert.ok(
      stats.median < maxMedianMs,
      `${label}: median CPU ${stats.median.toFixed(3)} ms (p90 ${stats.p90.toFixed(3)} ms, max ${stats.max.toFixed(3)} ms) exceeded budget < ${maxMedianMs} ms`,
    );
  }
  let reference = null;
  if (typeof referenceFn === "function" && Number.isFinite(maxRatio)) {
    reference = measureCpuBatched(referenceFn, { warmup, samples, batch, cpuUsage, minBatchCpuMs, maxBatch });
    const denom = Math.max(minReferenceMs, reference.median);
    const ratio = stats.median / denom;
    assert.ok(
      ratio <= maxRatio,
      `${label}: relative CPU ratio ${ratio.toFixed(2)}x (${stats.median.toFixed(3)} ms vs ref ${reference.median.toFixed(3)} ms) exceeded budget <= ${maxRatio}x`,
    );
    return { ...stats, reference, ratio };
  }
  return stats;
}
