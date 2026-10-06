// tests/draft-repair.test.mjs with the background repair on the unified runtime (switch generationRepair).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
process.env.STUDY_RUNTIME_PATHS = 'generationRepair';
await import('./draft-repair.test.mjs');
