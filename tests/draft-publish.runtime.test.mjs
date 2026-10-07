// tests/draft-publish.test.mjs with the publication of a draft on the unified runtime (switch generationPublish).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
process.env.STUDY_RUNTIME_PATHS = 'generationPublish';
await import('./draft-publish.test.mjs');
