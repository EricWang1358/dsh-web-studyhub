# StudyHub case study

[`studyhub-case-study.pdf`](studyhub-case-study.pdf) is a case study of StudyHub in two parts, written for the course *Architecting Scalable Systems*. It is a self-study document, not an official one.

- **Part A, the case.** The product described in the structure of a typical "Appendix A" case study: context, actors, use cases for two phases, requirements, initial architecture (layers, logical overview), domain model and the packaging of one use case.
- **Part B, the solution architecture analysis.** What the Lead Solution Architect would hand over: drivers and quality attribute scenarios, twelve decisions with their trade-offs (ADR-01 to ADR-12), the critical flows, the data and performance story, runtime and recovery, AI cost and failure, delivery and quality engineering, security, scalability (including a scale-out scenario) and an honest assessment of strengths, weaknesses and risks.

It describes the code as it is, not as an earlier document said it was. While it was written, comparing it with the code found places where the documentation had fallen behind (the default number of parallel parts, the number of lazy views, the number of job-runtime switches, how far automatic repair goes). Those were corrected in the same change.

## Keeping it true

A number in the case study is not typed by hand when the code can say it. `scripts/case-study/facts.mjs` reads the limits, defaults and counts that the document quotes from the modules and files that define them, and `scripts/case-study/content.mjs` writes them into the text and the figures when the document is built. Two things stay manual and are the reviewer's job:

- the **prose that describes design** (decisions, flows, trade-offs, the assessment) in `scripts/case-study/content.mjs`;
- the **2.4.0 performance measurements** in section 14, which are quoted from [`docs/performance.md`](../performance.md) with their date.

[`facts.snapshot.json`](facts.snapshot.json) is the committed copy of the structural facts. `tests/case-study.test.mjs` compares it with the code, so a pull request that changes a quoted limit, default or count (for example the default number of parallel parts, the migration switches, the lazy views, the store version, the file size limits) fails that test until the case study is rebuilt.

**When to update**

| You changed | Do |
| --- | --- |
| A limit, default or count that the test names | `npm run case-study`, read the diff of the PDF, commit the PDF and the snapshot |
| How a flow works (generation, jobs, storage, polling, live class), a new context or plugin, a decision | Update the prose in `scripts/case-study/content.mjs` (and a figure in `scripts/case-study/draw.mjs` if the picture changed), then `npm run case-study` |
| Only the version or release date | Nothing: they are read from the code and the changelog the next time the document is built |

`npm run case-study` writes the PDF with Chromium (the same browser the QA scripts use). Without a browser, `node scripts/case-study/build.mjs --facts-only` updates only the snapshot, and the PDF can be rebuilt later.

## Where the facts come from

| Fact | Read from |
| --- | --- |
| Contexts, migration switches, job states, store version | `lib/runtime/builtins.js`, `lib/runtime-config.js`, `lib/jobs/contract-schema.js`, `lib/store.js` |
| Generation defaults and bounds, per-call limits, review re-asks | `lib/generation-settings.js`, `lib/limits.js`, `lib/generation-limits.js`, `lib/generation-failure.js`, `lib/large-documents.js` |
| Import limits | `lib/office/limits.js`, `lib/large-documents.js`, `lib/audio-formats.js`, `lib/audio-file.js`, `lib/audio-upload.js`, `ui/ImportHub.jsx` |
| Job archive, task history, polling rhythm, live class | `lib/job-archive.js`, `lib/runtime/tasks.js`, `ui/poll-schedule.js`, `lib/live-protocol.js`, `lib/live.js` |
| Plugins and tools | `package.json` exports, `lib/runtime/tools.js`, `lib/index.js` |
| Views loaded lazily | `ui/workspace-views.jsx` |
