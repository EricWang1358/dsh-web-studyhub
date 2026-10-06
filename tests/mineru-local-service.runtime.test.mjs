// The local-route service suite with the local MinerU setup routed through the unified runtime (runtime.pilot.mineruSetup).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./mineru-local-service.test.mjs');
