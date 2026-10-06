// The generation queue characterization suite with generation runs routed through the unified runtime.
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./generation-family-baseline-queue.test.mjs');
