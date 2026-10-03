# Introduction page content audit · local 2.5.10

The historical attachment's “29 stale claims” list was not available. This audit starts from the actual existing `site/index.html`, rather than inventing that list. The table records rewritten claims and relevant omissions; some old statements were incomplete rather than false. Product behavior was checked against the current local code and documentation. No user library, provider account or live model was queried.

| Existing page | Current page | Evidence |
| --- | --- | --- |
| Daily Flashcard title | StudyHub product name | `package.json`, `README.md` |
| v0.8.0 badges | Built package version; local preview status | `scripts/site-build.mjs`, `package.json` |
| Everything lives in the chat | DSH study interface and supported entry points | `lib/index.js`, `docs/install.md` |
| Five question types | Ordinary question types plus rubric-based case papers | `ui/CaseCreate.jsx`, `lib/case-study.js` |
| A minute for a hundred questions | No throughput promise | Generation can take multiple stages and return a short draft |
| Every question must point to original text | Citation checks and visible review status; no correctness guarantee | `lib/assessment-quality.js`, `docs/assessment-quality.md` |
| Agent records everything pasted after classroom activation | Materials and existing JSON questions have explicit import routes | `ui/ImportHub.jsx`, `docs/json-import.md` |
| Screenshots and arbitrary application records can always be recorded | File types and text-extraction boundaries are explicit | `lib/documents.js`, `lib/office/`, `docs/pdf-workflow.md` |
| Classroom ingestion never uses drafts | Draft generation, quick publication and reviewed publication are distinguished | `docs/assessment-quality.md` |
| Missing answers are reliably inferred and marked | Readers are asked to inspect evidence, review status and answers | `docs/assessment-quality.md` |
| Demo reports exact sentence 3–4 for a rewritten passage | Demo uses “evidence passage”; actual citations use stored locations | `site/index.html`, `ui/document-preview/practice/citations.js` |
| Generation and review are only two calls | Planning, batched writing and independent review; failures and shortfall reported | `lib/generation.js`, `docs/token-usage.md` |
| Self-rewrite reads as a guarantee of a full set | Accepted results are kept; missing questions are reported and can be continued | `docs/assessment-quality.md`, `docs/token-usage.md` |
| All coaching can be used without typing | Explanations, examples, checks and written case answers have distinct flows | `ui/CaseCreate.jsx`, `docs/coach.md` |
| Exactly three follow-up suggestions | Follow-up support described without a fixed count | `docs/followup.md` |
| Old dissatisfaction menu promises automatic correction | Rewrites, background repair and inspection are described by the current workflow | `docs/assessment-quality.md` |
| Changing wording or explanation always keeps progress | Progress depends on the content change | `lib/study-state.js`, `docs/assessment-quality.md` |
| A graph grows automatically whenever an agent finds a prerequisite | Editable prerequisites, notes, tasks and outlines | `lib/study-state.js`, `docs/main-session-queries.md` |
| A particular library has 370 nodes in five columns | A labelled illustrative graph | `site/index.html` |
| Canvas zoom range is a product-wide guarantee | Mechanism demonstration without a universal range | Application views have separate controls |
| Every round has at most 10 new / 20 total questions | Configurable limits and mode-specific selection | `lib/contexts/study/operations.js`, `ui/Settings.jsx` |
| All learning follows exactly due → weak → new | Review, course path and exams select differently | `lib/study-state.js` |
| Mastery is only interval-based | Valid latest grade also matters; self-grade 5 is a special case | `lib/mastery.js` |
| Fixed 1, 3, 6, 13, 21, 38-day demo claimed to be the real rule | Default scheduler is bundled from product code and checked in-browser | `lib/sm2.js`, `site/demo.mjs`, `scripts/site-qa.mjs` |
| A miss only means retrying at the round end | Demo displays the scheduler's tomorrow review; it is not a real round | `lib/sm2.js` |
| 7 MB / 384 questions / 55 ms headline | Old measurement removed as a current performance claim | No 2.5.10 benchmark establishing that guarantee |
| 1–10 ms polling and all coaching cached | No fixed latency or guaranteed provider cache savings | `lib/store.js`, `docs/token-usage.md` |
| Developer npm install/build commands presented as installation | DSH Plugins → Add plugin → Enable, with release package and guide links | `docs/install.md` |
| Only Markdown, TXT and PDF described | Word, PowerPoint, HTML, JSON, recordings and subtitles; limits stated | `lib/documents.js`, `docs/audio-import.md` |
| Node requirement did not distinguish desktop from web | Desktop bundled runtime; web Node ≥22.19; platform checks | `docs/install.md`, `package.json` |
| Local-library privacy and provider costs were unspecified | Server/computer storage, feature-specific uploads, consent, API billing and subscription limits | `README.md#data-and-privacy`, `docs/install.md`, `docs/token-usage.md` |

Kept claims include MIT licensing, SM-2, editable prerequisite links, cycle rejection and two-level prerequisite credit, after checking `LICENSE`, `lib/sm2.js` and `lib/study-state.js`. The current site adds large-PDF conversion consent, course exam profiles, current-versus-historical source handling, sample-demo boundaries, backup limitations and optional local search.

Links to release/latest describe available releases, not an already published 2.5.10 package. The site has no analytics, remote fonts, CDN scripts, library access or model requests. Screenshots remain existing sample captures. Deployment and live external link availability are outside the local/offline QA result.
