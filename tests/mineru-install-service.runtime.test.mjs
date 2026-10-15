// The mineru.install.* service suite with the install routed through the unified runtime (runtime.pilot.mineruInstall).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./mineru-install-service.test.mjs');
