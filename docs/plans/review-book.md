# 复习全书 (Review Book) — agreed design and milestones

Status: decided by the owner and the coordinator on 2026-10-10. The owner delegated all remaining decisions. Build ONE milestone at a time; each milestone is reviewed by the coordinator (tests, guards, screenshots, diff) before the next starts. Do not build ahead of the current milestone.

## 1. What it is
A per-course study book made of several Markdown files that are stitched together in order. It is reference and study material for the learner, never evidence for generation. It is meant to be read, edited, exported and printed (the owner prints it as a cheat-sheet book, 开卷速查教材).

Existing pieces it builds on (do not duplicate): 总纲 `course-outline` (lib/course-outline*.js, ui/outline/*), the explanation layer `course-outline-notes` (lib/course-book*.js, generation/book/, ui/outline/LeafNotes.jsx), practice page (ui/Review.jsx, QuestionRun), card follow-ups (lib/followup.js, ui/ExplanationFollowup.jsx), reader (ui/document-preview/*), `course.outline.qa` (branch codex/book-qa-op).

## 2. Decisions
1. One book per course.
2. The book is stored inside the app (one hidden personal record, provenance `course-book-doc`, in `isLibraryListSource`; refused by `assertMaterials`; excluded from the retrieval/semantic index, from material lists, from search and from every generation input). Real `.md` files exist only through EXPORT (a folder + one concatenated file). No live external editing; the owner edits exported files outside if needed.
3. Files: each 总纲 leaf has two files, `<leaf>.gen.md` (machine-owned: AI explanation, 考情, example) and `<leaf>.mine.md` (user-owned: notes, added Q&A, 易错点, AI-added paragraphs). Stitch order: gen, then mine. Plus a `manifest` (ordered tree: chapters, sections, leaf ids, anchors + title fingerprint for re-mapping) and an `unplaced` file for text whose leaf is gone.
4. AI writes only to gen files, to new mine-file regions it creates, or to the `sh:qa` block of the Q&A it was asked to add. AI never edits existing user text.
5. Editing a gen file by the user marks it `forked`; regeneration then stores the new text as a suggestion (采用/忽略) and never overwrites.
6. Questions are plain Markdown links; clicking NAVIGATES to the real practice page and returns to the same heading. The link `practice?heading=<id>&n=5` means "the next 5 not yet done of this leaf's questions" (order due, weak, new; resumes an open run with the same scope).
7. Q&A goes into the book only via the button 「加入复习全书」 (and 「已加入 · 撤回」); setting `book.qaToBook: manual (default) | auto` (auto is done by the practice UI calling the same op; no backend hook).
8. The two modes of the page: 预览 and 原文 (raw Markdown of the open file in the CodeMirror markdown editor).
9. Upgrade-only: an older release does not hide the new records (note in docs/rollback like the outline PR).
10. Quality of generated text is tuned later through prompts; the structure must not depend on it.

## 3. Invariants (each needs a test)
- I1 Every write is a server-side read-modify-write on the CURRENT saved book, compare-and-set by a per-file version, serialized per course (one writer queue). A crash never leaves a half-written book (write whole, atomic).
- I2 Regeneration (new materials, new outline, new papers) never changes a `.mine.md` file and never overwrites a forked gen file.
- I3 Outline rebuild: leaves are re-mapped by anchors then title; files that cannot be mapped move to `unplaced` and are flagged 「已无对应知识点」; nothing the learner wrote, edited or forked is ever deleted (an unforked gen file of an unmapped leaf is regenerable and is dropped).
- I4 Heading ids are stable: assigned once, never renumbered or reused when sections are inserted, moved or removed; footnote ids are namespaced per file so stitched files never collide.
- I5 Question links: only `studyhub://card/<deckId>/<cardId>`, `studyhub://practice?heading=<id>&n=<k>`, `studyhub://qa?heading=<id>` are interpreted; a link to a deleted/replaced card renders as 「这道题已被删除」, never throws, and is skipped by export. Links only navigate; they never run an action. Any other link opens normally (noopener). The preview renders no raw HTML.
- I6 The book is never material/evidence: not listed in 资料, not accepted by `assertMaterials`, not in the retrieval index, not in the library search, not in the main-session context as a source.
- I7 Versions: last 20 versions per book, bounded by total size (fewer when large); 「回退到上一版」 restores one file or the last change.
- I8 Rendering is lazy per file (only the open/visible chapter), typing in 原文 never re-renders the whole book.
- I9 Compatibility: no notes → empty state with 生成复习全书; no questions → plain 「这一节还没有题」 and the existing 补题 entry; no sample paper → nothing about exams; no model → reading and editing still work, generation actions show the shared model gate (own unique feature key).
- I10 Export is pure concatenation (+ link resolution), deterministic (same book → same bytes), ordinary Markdown that Pandoc can read.

## 4. Milestones (each: tests, all guards, real-browser test at 1280 and 420 px, screenshots, docs; push a branch, no PR; coordinator verifies, then opens the PR)

### M1 — read-only book (branch codex/book-m1 from codex/book-qa-op)
Scope: book model + manifest + assembly from outline and notes (`course.book.open`: creates the files when none exist, otherwise returns them; no model call); `bookIndex` (heading tree, stable ids, question links per heading); the page (entry 「打开书页」 on the 总纲 page and on an opened leaf): wide = 目录 | rendered Markdown; narrow = single column with a collapsible 目录; live 目录 with 「你在这里」; preview renderer = existing Markdown component + resolver for the three link kinds + 角标 opening the reader; clicking a question link navigates to the practice page with the existing return context (回到复习全书) and restores heading + scroll; 本节问答 link shows `course.outline.qa` as a list; link states (deleted/replaced). No editing yet.
Reuse of the WIP branch codex/book-page-wip: heading ids, bookIndex, link parsing may be salvaged; its single-text region-marker storage is replaced by the file model.
Acceptance: I4, I5, I6, I8, I9, I10 (export not yet), outline-rebuild remapping (I3) with a test; dangling-link, 0-question, 0-notes, 1-leaf, no-paper fixtures; return-to-position after practice (browser test); no sideways scroll at 420 px; the two stale browser tests fixed; guards green.

### M2 — editing (branch codex/book-m2)
预览/原文 toggle (state per course), edit any file, fork rule (I2), suggestions (采用/忽略), CAS saves with the 「书已更新」 merge by file, versions + 回退 (I1, I7), parser/merger fuzz tests, interleaving tests (AI write vs editor save vs qa.add), crash-safety test.
Decided after M1 (2026-10-11):
- Version history lives OUTSIDE the `sources` collection: a separate per-course history store, size-capped, so the book's versions never weigh on reads of the library's sources (outline index, search, snapshot).
- Headings the learner types get ids through `assignHeadingIds` with the manifest's heading ids passed as `taken`, so a typed heading never takes an id of the outline's.
- Gen files hold no per-question list (M1): the individual question links of a point are rendered live from the current outline and cards (first 5 and 「还有 N 道」), and resolved at export; gen files change only when the notes change, and an unchanged `course.book.open` writes nothing.

### M3 — Q&A into the book
Button on the practice page and in 本节问答, `book.qa.add/remove` (idempotent per followup id, adds the link under the right heading when missing, else under 未归位), `book.qaToBook` manual/auto with the small switch, tests as in the earlier brief.

### M4 — 弄懂 while reading and 「加一段」
Select text in the book → 弄懂 / instruction → a visible task writes a new region into the leaf's mine file under that paragraph (never edits existing text); reuse the existing passage-grounded ask backend; beyond-material text marked 补充.

### M5 — 分析题答案卡
A structured answer card per case/analysis question (fields: 识别信号, 题干事实 with quotes, 概念+位置+逐字定义, 假设, 推理链, 结论, 为什么满足目标/代价/验证, 易错检查, 评分点对照); ONE full version only (no short version); quality checks (verbatim location of every quoted definition else 未核实, rubric coverage, independent review pass, status 已核对/部分未核对/被改过). Extends the existing case system (ui/CaseWorkspace.jsx, lib/case-study.js, rubric answers); no parallel system.

### M6 — 查找页 + CP export
Front matter lookup pages generated from headings/tags (按题型, 按概念, 按解题链; stable codes in page margins), export as a folder of `.md` files + manifest and as one concatenated `.md` (with/without answer key; question links become numbered question text), deterministic; Pandoc smoke test when pandoc is available else structural checks; page-count estimate vs a limit the learner can set.

### M7 — 期末一周
Exam date + days left → per-day node plan by exam weight × weakness (pure `lib/crunch-plan.js`), last days = 翻看 + mock paper from nodes (exam mode limits: 1–50 questions, quiz/multi only; report coverage).

## 5. Cross-cutting
- A minimal real-browser smoke test in CI (separate small PR after M1; non-blocking first).
- Every new op/job: contracts, usage registry, unified-runtime inventory docs/counts as the outline PR did.
- Zh and en locale keys, docs (docs/review-book.md + zh), rollback note (upgrade-only).
- Lean: no features beyond the current milestone.
