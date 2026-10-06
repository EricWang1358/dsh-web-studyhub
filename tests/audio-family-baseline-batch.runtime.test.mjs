// The S2-0 batch baseline suite with batches (and singles) routed through the unified runtime.
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./audio-family-baseline-batch.test.mjs');
