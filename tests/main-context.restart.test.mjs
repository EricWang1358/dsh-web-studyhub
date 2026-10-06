// The main-context characterization suite with generation runs on the unified runtime AND kept on disk for a restart (switch generationRestart).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
process.env.STUDY_RUNTIME_PATHS = 'generationRestart';
await import('./main-context.test.mjs');
