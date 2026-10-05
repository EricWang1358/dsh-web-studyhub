/* The model calls of a job as the snapshot carries them (`job.calls`, the one shape of lib/job-calls.js). A job from an older backend has
   none: every reader gets an empty list, never undefined. */
export const callsOf = (job) => (Array.isArray(job?.calls) ? job.calls : []);
