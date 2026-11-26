// The React task console reads lib/job-contract.js. Generate the control and stage shapes
// here so that an upstream contract change reaches the Java compatibility adapter at build time.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { jobContract } from '../../../lib/job-contract.js';

const output = process.argv[2];
const templates = {};
for (const state of ['queued', 'running', 'paused', 'cancelling', 'cancelled', 'failed', 'complete', 'interrupted']) {
  const paused = state === 'paused';
  const job = { id: '', label: '', type: 'spring-workflow', status: paused ? 'running' : state,
    paused, pausedAt: paused ? 1 : undefined, control: {}, done: 0, total: 1 };
  templates[state] = jobContract(job, { pause: paused ? 'checkpoint' : 'unsupported' });
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(templates));
