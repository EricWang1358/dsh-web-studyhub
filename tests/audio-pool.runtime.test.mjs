// The text-pool suite with batches (and singles) routed through the unified runtime.
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./audio-pool.test.mjs');
