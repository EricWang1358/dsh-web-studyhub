# Context boundaries validation

Scope: implementation after `3cd9a8d`, following the architecture correction requested for `a55edee`. Published `v2.0.0-alpha.1` remains unchanged. Final installer verification uses the fresh, separate `output/context-boundaries-pack-verified` directory.

## Requirements evidence

| Requirement | Current evidence |
| --- | --- |
| R1: owned state and work | `runtime/work.js`, `runtime/tasks.js` and explicit service projections replace mutable kernel authority. Same-library separate runtime, live registry, upload identity, assist and panel ownership regressions pass. |
| R2: bounded APIs and acyclic dependencies | `runtime/domain-contracts.js` names exact read dependencies, grants and writes. Architecture tests inspect the actual context import graph and installed runtime DAG; foreign reads and nested readonly mutation are rejected. Publication and source aggregation retain one-lock transactions. |
| R3: external facade | `StudyService` delegates to runtime APIs with private request options. No context receives it or an unrestricted store. Public action names, notification methods and error behavior remain compatible. |
| R4: transition retirement | Coach, notes, recording, workflows, skeleton, jobs and library have named owners; transition and legacy registration/kernel files are removed. Existing workflow, oral practice, note and coach tests pass. |
| R5: independent loading and unload | All 18 contexts run meaningful isolated operations without workbench. Third-party work covers FIFO, progress, deduplication and cancellation. Revoked owner/domain callbacks cannot publish late; sibling owners survive unload. |
| R6: frontend modules | Seven feature views use authored lazy boundaries. Native distribution emits 24 classic factory modules, uses host React and passed the installed DSH 0.2.0-rc.1 `ClientModuleSystem` loader. Standalone preview retains app.js/app.css; demo uses ESM chunks. |
| R7: archives | The five old root archives were ignored local artifacts, not tracked files. They were removed; `*.tgz` remains ignored. Seven freshly packed archives install and compose successfully. |
| R8: enforcement and verification | Forbidden imports are enforced by lint and actual graph tests. Full lint, 810 tests, native/preview build, demo build and fresh installer smoke pass. Baseline architecture/frontend boundary tests witnessed failure before implementation. |

## Checks

- `npm run lint`: pass.
- `npm test`: 810 passed; 0 failed, cancelled or skipped. Includes nested budget-expiry, cancellation, archived-target and stale-review cases.
- `npm run build`: pass; 24 native classic module arrivals, one host React, all seven lazy feature importers exercised.
- `npm run build:demo`: pass.
- `node scripts/release-alpha.mjs --outdir=output/context-boundaries-pack-verified`: seven local verification archives.
- Fresh install of those seven archives: pass; separate physical package copies compose with one runtime contribution per context, and unloading workbench retains the leaf contributions.
- Scoped storage regressions: unrelated collections are not decoded; absent-plugin and unknown data survive; rollback, retained-object isolation, concurrent writers, legacy migration and corrupted-shard protection pass.

Detailed local logs are under ignored `output/context-boundaries-*`. Repeated checks were limited to fixes or unresolved evidence; no assertions, timeouts or test concurrency were relaxed.

## Performance measurements

Windows, Node v22.22.3; fixture of 5,000 cards and 50,000 attempts; three warmups and 20 measured iterations. Baseline implementation was exported from `3cd9a8d`. Values are milliseconds on this machine, not a production latency guarantee.

| Operation | Before median / p95 | After median / p95 |
| --- | --- | --- |
| Settings-only store write | 57.698 / 80.198 | 22.952 / 30.843 |
| Synthetic study store write | 227.755 / 274.567 | 124.933 / 155.268 |
| Actual `review.answer`, initial quiet pair | 89.662 / 115.863 | 88.826 / 109.575 |
| Actual `review.answer`, final paired rerun | 133.121 / 159.078 | 136.219 / 175.035 |

The initial bounded implementation regressed actual answering to 577 ms median. Profiling identified repeated deep copies. Transactions now borrow a private projection decoded from committed shard text, retain readonly mutation checks and detach returned data. Reads and writes have separate field sets; untouched shard names/text are reused. Restored append/run hints avoid rewriting existing attempt chunks. The final actual answer workload is comparable to baseline; the storage-level gains do not imply a large end-to-end answer speedup. Both runs persisted 23 distinct attempts including warmups.

Reproduction scripts: `scripts/benchmark-store.mjs` and `scripts/benchmark-study.mjs`. The latter excludes review start/move/reveal preparation from answer timing. Schema compilation remains deferred because profiling did not identify validation as a material cost.

## Simplification

`ce-simplify-code` reviewed reuse, quality and efficiency. The reuse reviewer found one exact audio notification duplicate and it now calls the existing job notifier. A second reviewer dispatch hit the harness's total agent-thread limit, so quality and efficiency ran inline with the same prompt assets; neither found another safe behavior-preserving change. Applied counts: reuse 1, quality 0, efficiency 0; no safety checks removed. Full lint and regression verification followed.

## Review regressions and browser evidence

- A composed read previously mixed committed revisions when an owner read interleaved a writer. `readSnapshot` now captures one committed revision and invokes each authorized owner's projection with that revision. Undeclared reads, denied grants and owner writes during a read session are rejected.
- Local browser fault injection rejected the first lazy import. Reload recovered the feature while the unrelated live component remained at mount 1 and its heartbeat continued. The old global retry failed this scenario. Each deferred feature now owns its retry boundary.
- Task capabilities retained after domain unload, owner cancellation or runtime disposal cannot enqueue or execute new work. Held selection models are aborted by their own request owner; a sibling request remains active.
- Queued cancellation is checked before producer disposal, so disposal cannot conceal a missing cancellation. A separate task test checks live FIFO completion and visible progress.
- The first scoped write into an empty or version-one library previously cached callback-owned nested objects. A retained-object mutation reproduced the defect; all committed cache entries now reconstruct lazily from committed shard text.
- Generation reserves its draft identity before saving an early checkpoint. Existing held parallel-worker tests reject premature publication and permit publication after cancellation.
- Subtitle identity includes its timestamp labels and duration. Identical words with corrected times produce a new source. Public correction-review tests verify the first 15 edits survive cancellation or permanent model failure in the second batch in both materials and retained audio results. Models in these tests are deterministic local fakes.
- Final native build loaded in installed DSH 0.2.0-rc.1. The host Markdown preview rendered the material and its table, the selection-learning dialog opened, and the learning workspace remained available. Browser warnings/errors were empty. Earlier desktop and 390 × 844 mobile checks verified the source table fit without horizontal page overflow.

No live model/provider request was made through a study feature during validation.

## Independent review outcome and final manual validation

Code review: skipped (ce-code-review unavailable)

The actual full invocation `20261001-092019-b009dc83` terminated with `status: failed`: automatic policy rejected mandatory cleanup of terminal peer job directories. No cleanup retry or substitute completed receipt was created. Nine local reviewers completed and their original, pre-fix reports are retained in `context-boundaries-review/`. Two peer attempts stopped before provider execution because `jq` was unavailable; no external review or corroboration occurred. Merge, validator and report stages did not complete.

The caller used the explicitly permitted unavailable-review fallback and manually checked the final diff against R1–R8, all raw findings, source ownership, declared grants, transaction safety, plugin load/unload, archives and browser behavior. Outcome findings were reproduced or source-verified and fixed: revoked task handles, selection-owner cancellation, initial/migration callback cache aliasing, subtitle timing identity, all-volume correction ownership, mixed subtitle/audio inputs and standalone audio tool coverage. Root also fixed the active-draft publication race found by the full suite. The raw reports intentionally describe the earlier defects and are not an unresolved final review verdict.

The requested manual arbitration retains explicit built-in composition adapters and cancellation plumbing. Moving every policy branch or existing worker shape into more modules would not establish a missing behavior requirement; third-party contexts already use the generic, guarded task API. This follows the user's clarification that performance and extensibility matter more than completely splitting the shared implementation. These suggestions are advisory rather than deferred correctness defects.

Performance coverage remains limited to settings writes, synthetic study writes and actual answering; the benchmark excludes navigation/preparation and does not establish a speedup for a full learner session. Browser validation also checked that adding an audio path while a subtitle was selected displayed the rejection and retained the original subtitle without submitting an import. Source file reads share the upload guard and discard completion after cancellation/unmount.
