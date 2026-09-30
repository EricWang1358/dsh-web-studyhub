export async function readExamTarget(call, runId) {
  const run = await call('review.get', { runId });
  if (run?.mode !== 'exam') throw new Error('找不到这场笔试');
  return run.complete || run.closed
    ? { run, report: await call('exam.report', { runId }) }
    : { run, report: null };
}
