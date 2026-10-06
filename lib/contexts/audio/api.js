import { createJobServices } from '../../runtime/jobs.js';
import { isAudioJob } from '../../job-status.js';

const input = { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, jobId: { type: 'string' },
  timeoutSeconds: { type: 'number' }, all: { type: 'boolean' } } };
const output = { type: 'object', additionalProperties: true };
export function createAudioOperations(root, work) {
  const { jobs, generationControllers, settled } = work;
  const { activeJob, publicJob } = createJobServices(work);
  const ownJobs = root => [...jobs.values()].filter(job => job.root === root && isAudioJob(job));
  return {
    results: { input, output, description: 'Read retained audio transcripts, including standalone results without materials installed.',
      execute: async (_args, context) => ({ results: (await context.state.read()).audioResults }) },
    'result.get': { input, output, description: 'Read one independently retained transcript.', execute: async (args, context) => {
      const result = (await context.state.read()).audioResults.find(item => item.id === args.id);
      if (!result) throw new Error('Audio result not found');
      return result;
    } },
    jobs: { input, output, description: 'Read only this audio context’s jobs.', execute: () => ({ jobs: ownJobs(root).map(publicJob) }) },
    'job.wait': { input, output, description: 'Wait for an audio job without requiring generation or the workbench.', execute: async args => {
      const job = args.jobId ? ownJobs(root).find(candidate => candidate.id === args.jobId) : ownJobs(root).at(-1);
      if (!job) return { status: 'none' };
      if (activeJob(job) || settled.has(job.id)) {
        let timer;
        await Promise.race([settled.get(job.id), new Promise(resolve => { timer = setTimeout(resolve, Math.min(60, Math.max(1, args.timeoutSeconds || 60)) * 1000); })]);
        clearTimeout(timer);
      }
      return publicJob(job);
    } },
    'job.cancel': { input, output, description: 'Cancel this context’s own audio jobs while retaining transcription checkpoints.', execute: args => {
      const targets = args.all ? ownJobs(root).filter(activeJob) : ownJobs(root).filter(job => job.id === args.jobId);
      for (const job of targets) {
        job.cancelRequestedAt ||= new Date().toISOString();
        generationControllers.get(job.id)?.abort(new Error('Audio job cancelled; retained transcription can be resumed'));
      }
      return { jobs: targets.map(publicJob) };
    } },
  };
}
