// The search-index characterization suite with the build routed through the unified runtime (runtime.pilot.retrievalIndex).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./wp28b-index.test.mjs');
