// The step identity suite with generation runs on the unified runtime.
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./generation-step-identity.test.mjs');
