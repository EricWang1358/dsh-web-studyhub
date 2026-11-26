---
name: design-background-work
description: "Load before you add or change work that runs in steps or in the background: a job, pipeline step, model call, retry, timeout, import, indexing or generation run (后台任务、重试、超时、生成、导入、索引). Its questions come from this repo's own PRs and issues and are in the skill body, not in this description: read it before you answer."
---

# Design work that runs in steps or in the background

**Outcome:** background work the user can see, stop and trust, that fails loudly by kind and does each step once.

**Done:** each question is answered; failure, stop and restart were each run once.

Each question is the catch of a general-mistake class mined from this repo's PRs and issues. The classes recur on different features, so ask every question, not only the ones that look related to the file you touch.

## Questions

- [C43] For each way this step can fail, is the failure permanent, transient or the guard's own fault, and does each kind get a different response (recorded and skipped, retried, degraded and reported as a fault) so that a retry makes progress and one kind cannot abort or block everything?
- [C13] What does this handler or call cost each time, measured in the real host, is the work scoped to what changed, and can unchanged data be reused?
- [C44] Which of what the common path loads or builds will most sessions never use, and what measure fails when that grows?
- [C32] What state from the earlier attempt, cycle or context is still present when this one starts or resumes, is each part reset, re-derived or checked as valid for the new use (including after a failed start), and does a resume compare its own record with the facts in the store?
- [C19] At the instant this code decides, reads or applies a result, is everything it reads final and does it still belong to the request or state it came from, including during a request in flight, a fast second request, or layout still settling?
- [C11] If this step fails or returns empty, what does the user see, and does the work retry or resume without paying twice?
- [C34] For this background work, can the user see it in the shared task console, stop it, and see its usage there?
- [C28] Which of these units are independent, is the concurrency adjustable, and does a per-stage timeline show where the wall clock goes?
- [C48] For each external thing this step pulls (image tag, package mirror, download), is its version pinned, is a stall bounded by a time limit, and is a transient failure retried?
- [C39] For each setting this operation uses across steps or on a continuation, is it taken as issued or as it is now, is that written down, and does a test change the setting mid-run and on a continuation?
- [C33] When this code reports cancelled, timed out or finished, has the work it stands for actually stopped and released what it held (process, request, queue slot, files)?
- [C35] If this operation is cut off after each step and started again, or the user repeats the same request, which finished steps are repeated or duplicated, and is each one keyed by a stable id or receipt?
- [C29] For each finding this gate can raise, is it fatal, fixable or advisory, and does the gate act accordingly?

For any question you cannot answer at once, read that class's entry (condition, boundary, pairs): `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`, with the class id in place of C03.

## Red flags

- "It is quick, run it in the page."
- "On any error, retry the whole thing."
- "The timeout fired, so it stopped."
- "Reuse the state from the last run."
- "Fetch the latest version."

## Pinned commands

- `npm run qa:failed-continue`
- `npm run qa:time-limit`
- `npm run qa:dsh-runtime`
