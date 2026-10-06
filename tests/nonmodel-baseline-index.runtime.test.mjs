// The S5-0 index baseline with the build routed through the unified runtime; defect expectations that the migration fixes differ by mode in the suite.
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./nonmodel-baseline-index.test.mjs');
