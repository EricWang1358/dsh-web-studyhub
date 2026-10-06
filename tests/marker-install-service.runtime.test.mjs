// The marker.install.* service suite with the install routed through the unified runtime (runtime.pilot.markerInstall).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./marker-install-service.test.mjs');
