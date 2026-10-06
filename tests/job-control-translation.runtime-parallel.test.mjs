process.env.STUDY_RUNTIME_SWITCH = 'runtime';
process.env.STUDY_TRANSLATION_PARALLEL = '1';
await import('./job-control-translation.test.mjs');
