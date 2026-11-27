import assert from "node:assert/strict";

/**
 * Shared performance-gate helpers for root tests (see docs/performance.md).
 *
 * Uses warmed, batched `process.cpuUsage()` sampling + median aggregation so OS
 * scheduling preemptions on shared/parallel CI runners do not inflate timings,
 * while genuine CPU regressions still fail decisively.
 */

const cpuDeltaMs = (used) => (used.user + used.system) / 1000;

function summarize(readings, value) {
  const sorted = [...readings].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  return {
    value,
    median,
    p90,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples: sorted,
  };
}

/**
 * Measure per-call CPU time (ms) using warmed, batched `process.cpuUsage()` samples.
 * Accepts an injectable `cpuUsage` hook so flake-reproduction tests can verify
 * behavior deterministically alongside real CPU measurements.
 */
export function measureCpuBatched(
  fn,
  { warmup = 5, samples = 7, batch = 10, cpuUsage = process.cpuUsage } = {},
) {
  let last;
  for (let i = 0; i < warmup; i += 1) last = fn();

  const readings = [];
  for (let s = 0; s < samples; s += 1) {
    const before = cpuUsage();
    for (let b = 0; b < batch; b += 1) last = fn();
    const used = cpuUsage(before);
    readings.push(cpuDeltaMs(used) / batch);
  }

  return summarize(readings, last);
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
    label = "operation",
    referenceFn = null,
    maxRatio = null,
    minReferenceMs = 0.05,
  } = {},
) {
  const stats = measureCpuBatched(fn, { warmup, samples, batch, cpuUsage });
  if (Number.isFinite(maxMedianMs)) {
    assert.ok(
      stats.median < maxMedianMs,
      `${label}: median CPU ${stats.median.toFixed(3)} ms (p90 ${stats.p90.toFixed(3)} ms, max ${stats.max.toFixed(3)} ms) exceeded budget < ${maxMedianMs} ms`,
    );
  }
  let reference = null;
  if (typeof referenceFn === "function" && Number.isFinite(maxRatio)) {
    reference = measureCpuBatched(referenceFn, { warmup, samples, batch, cpuUsage });
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
