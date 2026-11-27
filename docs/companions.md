# Interactive Companions and external tools

[中文](companions.zh-CN.md)

StudyHub includes a built-in **Interactive Companions** stage-and-voice engine for self-contained, progressive HTML lessons across any academic discipline, and also gives proven open-source tools a clean, sandboxed way into your study library without copying or rebuilding their work.

## Interactive Companions: cross-discipline stage-and-voice lessons

StudyHub includes a built-in **Interactive Companions** stage and compiler for progressive, self-contained HTML lessons (`studyhub-lesson/1`), and also mounts existing interactive companion packs from disk (such as a local lab repository with `pages/*.html`, `lessons/*.json`, `projects/`, and `feedback/questions.json`).

### Cross-discipline interactive HTML builder (`generation.companion.build`)

Open **Interactive Companions** from **Course outline** or **Sources** (or search `companion` in `Ctrl/⌘ K` **Find a feature**) to run the four-stage pipeline (blueprint → act 1 → act 2 → math-eval & 18 pedagogical invariants verification) and generate a 16–20 slide, zero-dependency `.html` file for **any subject** (Mathematics, Philosophy, Mechanical Engineering, Physics, Economics, Law, Computer Science), with four clickable cross-discipline starter chips (Mathematics, Philosophy, Mechanical Engineering, Computer Science) to prefill prompts and archetypes:

- **Four discipline archetypes & tactile stage blocks** on one stage-and-voice engine (`0` external network requests):
  - **Parametric & Phase-Plane Math Sandbox (`sandbox`)**: Pure AST-evaluated mathematical expressions (`0` `eval`) supporting **1D multi-series curves** (`expr`) with horizontal `threshold` reference bands AND **2D parametric trajectories** (`xExpr` / `yExpr`), normalized **phase-plane quiver vector fields** (`field: { xMin, xMax, yMin, yMax, grid, dxExpr, dyExpr }`), and **live moving equilibrium markers** (`markers: [{ label, xExpr, yExpr }]`) for ODEs, classical/control mechanics, thermodynamics, and macroeconomics — complete with 1-click regime `presets` (`[{ label, values }]`), a built-in `Reset` button, interactive sliders (`Shift + ←/→` fine stepping), and hover crosshair $(x, y_i)$ readouts.
  - **Dialectical Counterexample Matrix (`dialectic`)**: Thought-experiment stress-test matrices (`matrix`) with optional `predictBeforeReveal` gating, `Reveal all` / `Reset` comparison toggles, scenario tabs, and arrow-key cell focus navigation, paired with two-voice Socratic timelines (`lanes`).
  - **Closed-Loop Schematic & Force Path (`mechanism`)**: Step-by-step vector schematics (`schematic`) with quadratic Bézier feedback-loop routing (so control loops and vertical force chains never cut across middle blocks), clickable node `detail` inspection, and learner-driven `Step trace` / `Reset` causal walks.
  - **Empirical Trace, Flaw-Spotting, Diagnostic Quizzes & Hands-On Workshop (`empirical`, `spot`, `quiz`, `try`)**: Line-by-line code/proof walks, interleaving timelines (`inside`), keyboard-operable 1-based token/premise/design flaw-spotting (`spot` with gutter-free text selection), boundary `quiz` blocks with per-distractor `why` trap diagnostics (preserving strict first-attempt `self-check` FSRS integrity), and interactive `try` / `workshop` blocks with checkable criteria, persisted scratchpads, hints, and model solutions.
- **Compile-time W3C MathML Core via `temml` (`lib/companion-template/mathml.js`)**: Offline, currency-safe `$...$` / `$$...$$` LaTeX-to-MathML compiler powered by `temml` (MIT, pure JS, `{ xml: true, throwOnError: false, trust: false }`), pre-rendering equations into well-formed XML `<math>` entries in `lesson._math` — covering `\begin{cases}`, `bmatrix` / `vmatrix` determinants, `\int_a^b`, `\oint`, `\sum`, `\lim`, `\overbrace` / `\underbrace`, norms `\|x\|`, inner products `\langle u, v \rangle`, Newtonian/Lagrangian time derivatives (`\dot{x}`, `\ddot{x}`), `\operatorname{...}`, and formal/modal logic (`\vdash`, `\models`, `\Box`, `\Diamond`, `\forall`, `\exists`, `\implies`, `\iff`) while keeping browser prose strictly textNode-only.
- **Modular runtime & Sandpack-style `ready` handshake (`lib/companion-template/runtime/`, `ui/diagram-frame.js`)**: The compiled lesson runtime is organized into focused modules (`dom.js`, `blocks-core.js`, `blocks-visual.js`, `math-sandbox.js`, `renderer.js`, `bridge.js`, `i18n-*.js`). The host-to-iframe `studyhub-companion/1` channel uses a token-verified `ready` / `ping` handshake with pre-ready FIFO buffering (coalescing `theme`, `goto`, and `labels` messages) so initial theme sync and slide deep-links are never dropped in a load race.
- **Dual output, zero-key main-chat compilation & honest provenance**: Every generated lesson is written in plain text to `<workspace>/companions/<course>/<slug>.html` and `<slug>.lesson.json` AND registered in the course (or compiled directly in the main chat with zero provider API key via the shipped `study-companion` skill and `companion.compile`). Grounded builds extract structured high-signal excerpts from selected materials; zero-material free-topic builds run cleanly and are marked `ai-drafted-unverified` (`grounded: false`).

### Mounting local companion packs, live JSON compilation & learner affordances (`companion.attach`, `companion.sync`)

1. **Mount HTML files, folders, or raw authoring JSON packs (`companion.attach`)**:
   - Point **Mount Local Folder / HTML** at a single `.html` file or a companion pack directory (`pages/*.html`, `lessons/*.json`).
   - If a pack contains unbuilt `lessons/<slug>.json` specs without pre-built HTML (including `of: "<pkg>.<Class>"` source references under `<pack>/projects/` or `<pack>/src/`, verified strictly inside the mounted folder), StudyHub resolves the source snippets and compiles full interactive HTML on the fly when opened.
   - Courses with large packs (7+ to 170+ lessons) automatically show instant search and `All` / `In progress` / `Completed` filters in the **Interactive Companions** bar.
2. **Smart dual-mode question sync, bidirectional deep-linking & 1-click disk re-sync (`companion.sync`)**:
   - Courses that already have decks use **Enrich existing**: high-confidence concept matches link existing cards (`card.companionRef`) to exact `#slide` anchors, and oral synthesis (`say`) drills are added without duplicating flashcards.
   - Blank courses use **Full pack**: zero-token deterministic compilation of takeaway flashcards, boundary quizzes, scenario case quizzes, oral rubric cards, and hands-on `task` rubric cards, with **First-Pass Credit** granted when you work through the interactive slides so you are not re-quizzed on the same day.
   - **Bidirectional deep-linking across the workbench**: Any card or projected note linked to a companion shows **Open slide N in companion** / **Open interactive companion** across **Flashcard Review**, **Mistakes & weak** (Wrong-Answer Book), **Manage deck** inspection, **Round Look-Back**, and the **Sources** reader (`src-companion-<id>`), jumping straight to the exact slide without reloading a mounted stage.
   - When a `linked` file is edited on disk (`changedOnDisk`), click **Sync source & cards** (`companion.sync`) in the viewer to refresh its SHA-256, projected **Sources** Markdown, and cards while preserving your FSRS-6 review schedules.
3. **Built-in viewer & standalone HTML affordances**:
   - **Theater `Expand stage` mode, 1-click `Export HTML`, slide quick-jump & live theme sync**: Maximize phase-plane plots and schematics across narrow (`360px–480px`) IDE sidebars with **Expand stage**, download any self-contained offline `.html` lesson in one click with **Export HTML**, jump directly to any slide, and sync light/dark workbench themes live via token-verified `postMessage`.
   - **`#toc-pop` Slide-Map Table-of-Contents, `?` shortcut sheet & `@media print` Study-Sheet export**: Click the `N / Total` slide counter or press `g` to open the beat-and-title **Slide Map** (`#toc-pop`), press `?` for keyboard controls (`Space / →`, `←`, `g`, `Shift + ←/→`, `Esc`), or print / save as PDF to trigger multi-slide **Study-Sheet Mode** (crisp light ink tokens, unhidden card/model answers, zero `100vh` clipping).
   - **In-stage study drawer & `feedback/questions.json` LWW sync**: Highlight any sentence (which opens the drawer and focuses the question box) or click **Look up / Ask** for 0-token glossary/card lookup, a micro-context tutor answer (`companion.ask`), 1-click **Save to Companion Catch-ups** (due tomorrow), or two-way atomic LWW sync with `<pack>/feedback/questions.json` (browsable in the collapsible **Doubt & Feedback Ledger** with 1-click slide jump).
4. **Backup discipline**: Directory packs mounted in `linked` mode add **0 bytes** to portable library backups while preserving full offline Projected Source notes; `managed` single-file companions travel inside portable backups.

## Archify: interactive diagrams of your outline

[Archify](https://github.com/tt-a1i/archify) is an open-source (MIT licence) agent skill by tt-a1i. You describe something, or point it at a plan or a repository, and it writes **one self-contained interactive HTML file**: architecture, workflow, sequence, data-flow and lifecycle diagrams, and learning maps. The file opens offline in a browser (links inside it need a network). See the [project page](https://tt-a1i.github.io/archify/) and the [live examples](https://tt-a1i.github.io/archify/gallery.html).

**Why we recommend it.** The outline view inside StudyHub (the **Knowledge outline** page, with **Learning spine** and **Structure diagram**) shows how your concepts connect, but it is a plain structure view. Archify draws richer diagrams that you can click through. So StudyHub points you to it, and accepts what it makes.

### Install

Archify's own README lists the DeepSeek Harness plugin. In a terminal:

```
dsh plugin --profile web add @tt-a1i/archify-dsh@1.0.0
```

`web` is the name of a DSH profile. Use the profile you run: in the browser it is `web`, in the desktop app it is usually `desktop`. The same card on the **Knowledge outline** page shows this command with a **Copy** button. To remove it: `dsh plugin --profile web remove @tt-a1i/archify-dsh`. Other agents use `npx skills add tt-a1i/archify -g`. Check Archify's README for the current version; `1.0.0` is the one this page was written against.

### How the hand-off works

1. Open **Knowledge outline** and open a saved outline.
2. Click **Draw this outline with Archify**. StudyHub puts a short prompt in your DSH chat (or copies it when the chat has no input box). You read it and send it.
3. The assistant reads the outline with `skeleton.get`, then uses the `archify` skill. It picks the diagram type that fits: concepts as nodes, prerequisites as arrows, contrasts and causes as labelled relations. The outline carries which questions each concept has, not mastery, so the diagram shows coverage at most.
4. The assistant writes the HTML into your workspace (for example `diagrams/<title>.html`) and registers it with `skeleton.diagram.attach {id, path, title?}`.
5. StudyHub copies the file into your library and lists it under **Interactive diagrams** on the outline: title, date, size, and **The outline changed; this diagram may be out of date** when the outline was edited after the diagram was made.
6. **Open** shows it inside StudyHub. **Delete** removes the library's copy (not the file in your workspace).

If the `archify` skill is not installed, the assistant says so and gives you the install command above. It does not draw something else in its place.

### Where the file is kept, and what StudyHub does with it

- The copy is `<library>/skeleton-diagrams/<outline id>/<diagram id>.html`; a small record (title, date, size, a SHA-256 of the file, the outline revision it was drawn from) is kept on the outline. Both are in the full library backup and come back on restore (a file that has gone missing is left out, and the entry says so when opened).
- At most **8 diagrams per outline**. The ninth replaces the oldest, and the assistant is told which one. Attaching the very same file again changes nothing.
- StudyHub **never runs, edits or sends** the file. It is not read by any model call. It stays in your library.
- Archify has an optional update reminder that may fetch a fixed manifest; that request is Archify's own, made when you use Archify, and StudyHub neither makes nor sees it.

### Threat note: showing an HTML file an AI wrote

The file may contain any script. StudyHub treats it as untrusted.

**What attaching accepts.** Only a regular file whose real path (links resolved) is inside the session workspace or the library; at most 5 MB; one UTF-8 document that starts like an HTML page (`<!doctype html>` or `<html>`). A path outside those folders, a link that leads out of them, a folder, a binary, a JSON file or anything larger is refused with the reason. The session workspace is set by StudyHub, never by the request.

**What opening does.**

- The document is shown in an `iframe` with `sandbox="allow-scripts"` and nothing else. Its scripts run (that is what makes it interactive), but it has an opaque origin: it cannot read StudyHub's page, storage or cookies, cannot navigate the page, submit forms, open windows, download files or show dialogs. `parent.document` throws inside it.
- It is passed as `srcdoc`, not a URL, with `referrerpolicy="no-referrer"`, the iframe `csp` attribute, and an injected `<meta http-equiv="Content-Security-Policy">` inside `<head>` so Chromium, Firefox and Safari all block `fetch`, XHR, WebSocket and form posts on inline `srcdoc` documents. A diagram that loads an image or a font from the network can still do so; that request carries nothing of yours.
- One small script is added at the top of the head so that clicking a link leaves the diagram where it is (links to other pages are not followed in-app; `#` links inside the page work). That is a courtesy, not the protection: the sandbox is.
- A banner says the diagram was made outside StudyHub and is shown in an isolated window.

What this does not do: it cannot stop a page from using your CPU, or from drawing something misleading. Delete a diagram you do not trust.

## Other external tools

Heavy PDF conversion and retrieval link to their own guides: [large textbooks](large-documents.md) and [MinerU conversion](mineru-conversion.md), which StudyHub installs on this computer with **One-click install**.
