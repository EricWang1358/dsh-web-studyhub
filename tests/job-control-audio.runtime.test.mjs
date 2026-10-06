// The audio job-control suite with batches (and singles) routed through the unified runtime.
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./job-control-audio.test.mjs');
