# Changelog

English · [Complete Chinese history](CHANGELOG.zh-CN.md)

## 2.0.3 — 2026-10-01

- Complete English support across material reading, selection questions, generation/review, audio controls, study workflows, citation markers and conversation handoffs.
- Application errors, background progress, provider wrappers and task notifications follow each request’s interface language. Concurrent English/Chinese requests remain isolated; original sources, questions, notes and provider evidence are preserved.
- First-time users follow the browser’s preferred language; an explicit existing choice takes priority. New generation requests default to the interface language unless a content language is configured.
- English documentation and separate English/Chinese browser setup guides accompany the complete package and six standalone components. Existing web users continue installing only plugins through DSH’s plugin manager.

## 2.0.2 — 2026-10-01

- Added desktop/web setup guidance, official Windows and Apple silicon installers, and Linux/browser-only startup.
- Complete packages declare independently switchable workbench, runtime, materials, bank, learning, generation and audio components. Disabled capabilities stay disabled and saved data remains.
- Clarified model provider setup, eligible API-key Coding Plans, and the distinction between subscriptions and separately billed APIs.

## 2.0.1 — 2026-10-01

- Clarified audio task windows, timing and completed history; each child agent has one entry. This fixed display, without changing cross-recording queuing or fixing the reported host-level lack of overlapping child-agent execution.
- Isolated background work per runtime/component and introduced explicit APIs, grants and acyclic dependencies. Frontend features load on demand and can retry locally.
- Preserved old fields and extension data while narrowing storage reads and reusing unchanged shards. Storage benchmarks improved; actual answer writes did not yet show a clear speedup.

## 2.0.0-alpha.1 — 2026-10-01

- Introduced separately installable capability plugins, public APIs, original source files and versioned selections, reviewed incremental deck additions, and complete backups retaining original files.
- Existing libraries with absent optional fields remain readable. Audio runs independently and publishes through the materials API when available.

Earlier 1.x release details, validation records and limitations are preserved in the [complete Chinese history](CHANGELOG.zh-CN.md).
