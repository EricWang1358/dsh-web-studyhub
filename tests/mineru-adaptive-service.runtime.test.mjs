// The mineru-adaptive-service suite with PDF conversion routed through the unified runtime (runtime.pilot.pdfConvert).
process.env.STUDY_RUNTIME_SWITCH = 'runtime';
await import('./mineru-adaptive-service.test.mjs');
