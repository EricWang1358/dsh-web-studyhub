// The main-context characterization suite (supplement, budget finalization, cancellation) with generation runs on the unified runtime.
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./main-context.test.mjs');
