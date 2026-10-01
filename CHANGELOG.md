# Changelog

English · [Complete Chinese history](CHANGELOG.zh-CN.md)

## 2.1.1 — 2026-10-02

- **Update notice and one-click upgrade.** StudyHub checks GitHub for a newer release at most every 12 hours (it can be turned off; nothing but the request is sent). In DSH 0.2 it downloads the exact release asset, verifies its SHA-256 and installs it through DSH's plugin manager; restart DSH to finish. Hosts without that API get a guided reinstall with the package address to copy. Restarting DSH alone never updated a plugin; the docs now say so.
- **Word and PowerPoint.** Import `.docx` (headings, lists, tables, footnotes) and `.pptx` (one section per slide, with speaker notes and slide numbers for citations), up to 40 MB. Old `.doc`/`.ppt` files get a clear "save as .docx or PDF" message.
- **Calmer, consistent Settings.** One left edge and one section style; aligned audio provider cards; a reasoning-effort choice for question generation when the model offers levels (with its trade-off); library disk use computed in the background; an SM-2 preview chart of upcoming review days; a guided backup and restore with a preview of the chosen file; the 陪学 profile explains what it affects and now reloads after changes.
- **Many courses.** Course pickers show a few ranked choices, fold "Course / Chapter" names into one group, and list everything else in a searchable window; long lists of courses and sources scroll in place. Near-duplicate course names offer a confirmed merge. The course field has a one-click clear.
- **Learning flow names its course.** Topics are picked from the current course, a course switch sits next to the scope line, and a more relevant course is suggested but never switched to automatically. References show questions instead of raw JSON, and model rate-limit or connection errors read as plain advice.
- **Practice that reuses what you have.** Mistakes group by topic across papers, recommend similar existing questions (no model), and can generate variants for 举一反三; retraining can include similar questions or variants.
- **Mock exams in one place.** Multiple-choice, case paper and oral interview share one format switch, one setup layout with how-it-works steps, and one recent-exams list.
- **Faster, clearer pages.** Dismissing finished jobs is instant; the generate form has a stepper, segmented choices, a summary line and a 帮我想想 assistant that sends only titles and outlines; statistics add a larger trend chart, a 14-day due forecast and mastery by level or question type; the task board was redesigned (menus, checklists, filters, undo; due cards highlight its badge); switches slide; the source viewer wraps readable text; the knowledge-skeleton page hides other courses' empty groups and no longer shows "Skeleton not found".
- SiliconFlow keys are checked against the model list (the old account endpoint now answers 410).

## 2.1.0 — 2026-10-01

- **Easier start after installing.** StudyHub is a labelled page in DSH's left sidebar and opens once by itself after enabling; no chat message is needed. A welcome page offers a one-click **sample course** (design patterns, in the interface language, no model calls, removable in one click) and a **19-step feature tour** that switches pages and highlights the real controls. Navigation now leads with library, sources, create deck, mistakes, exams and statistics.
- **Fool-proof setup.** Features that need a model or a transcription provider show a setup card before you invest effort; model readiness is checked without calling a model. Errors appear where you are looking, in plain language, with a fix. The DSH composer no longer covers StudyHub or its dialogs, and dropped files no longer land in the chat.
- **One import entry.** Choose the course, then drop several PDFs, notes, JSON decks or subtitles at once; each file shows its own status. After import the dialog closes and the new source is highlighted. **A PDF is one document**, not one source per page.
- **Materials-first generation.** Generating from your sources is the default; JSON import is the second way in. Job progress and drafts sit at the top of the home, and stage text is localised.
- **Audio.** Free **SiliconFlow SenseVoice** transcription reachable from mainland China; per-file pre-flight with one-click fixes; **lossless M4A splitting** for recordings over an hour; one blocked file no longer silently cancels the rest of a batch.
- **Case-study practice.** Generate a long case with marked questions and structured rubrics from course materials, in the style of a past paper, or paste a case and your answer to be graded. Answers are graded criterion by criterion (case linkage, explicit assumptions, justification…) with verbatim evidence, missing points and rewrite suggestions. Mock exams gain a **case paper** with reading time, multi-colour highlights, ~3 minutes per mark pacing and a paper-practice mode; weak criteria become drills.
- **Courses are first-class.** Stable course ids, transactional rename/merge, and a course exam profile (format, marks, writing/reading time, sections, exam date, examiner guidance, focus topics) with an exam countdown. The library format moves to version 4; the first write keeps a backup, and older plugin builds cannot open an upgraded library.
- **Study preset.** A 「学习模式 · StudyHub」 agent preset ships with the plugin: StudyHub tools, sub-agents, web search and ask-user only — no shell or file editing — and it asks when "materials" is ambiguous. Requires DSH `>=0.2.0-rc.2 <0.3`.

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
