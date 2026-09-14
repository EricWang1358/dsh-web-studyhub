# Generation cancellation and execution budget

Study jobs belong to `study_workspace`, not the run_code job registry. Use
`job.cancel {jobId}` or `job.cancel {all:true}` for all active/queued jobs in the
current library. An explicit ID from another library is rejected. Repeating a
cancel request is safe. The Study panel offers both stop controls.

Queued cancellation is terminal immediately and prevents worker admission.
Running cancellation reports `cancelling` until the provider has settled and
native child cleanup has completed. Abort propagates into continuable children,
one-shot workers and direct model streams. No subsequent model stage or batch
starts. Approved checkpoint drafts are retained and remain available through
`job.wait`, including after cancellation or timeout. Publication remains fenced
until worker cleanup finishes.

Each job has a 20-minute execution budget, starting when its queue slot opens.
The existing 10-minute per-phase bound also applies. Reaching the job budget
aborts active work and prevents subsequent batches. Cleanup can extend beyond
the budget; the UI must not claim a worker has stopped until it has. This is a
cost/latency guard, not a promise of a full deck in 20 minutes. Failed work must
not be automatically re-enqueued or bypassed through ingest.

The tests cover cross-library isolation, idempotent cancellation, skipped queued
work, native child cleanup settlement, retained partial drafts and the total
execution deadline. Live model throughput still requires measurement.

Existing processes retain their loaded code and in-memory queue. Editing these
files cannot retrofit cancellation into those closures; this implementation
applies after the backend loads the updated plugin. Do not claim old jobs were
cancelled merely because the source was changed.
