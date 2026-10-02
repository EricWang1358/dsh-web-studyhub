# Study panel design (1.0)

The whole panel follows one idea: **the card is the only physical object; everything else is type on a desk.** Every new surface should either strengthen that idea or solve a named product problem.

## Thesis

- Intent: "I know exactly what to do today" — calm, confident, generous (大气).
- Composition: one focal object per page, placed asymmetrically. Library: today's paper card stack. Review: the question as an index card. Stats: the streak numeral. Exam: the exam sheet. Skeleton: the learning axis.
- Secondary information is typographic lines under hairlines, never a grid of equal boxes.
- Type: system sans (`--font-ui`, `--font-display`); large light numerals for counts; bold display headings; small muted labels.
- Shape: cards use `--radius-card` (16px) and `--shadow-card`; controls use `--radius-sm`; pills only for toggles.
- Motion: the card is dealt in once; on each question the stem inks in and the head rule fills; pages cross-fade. Animate transform and opacity only. Everything honours `prefers-reduced-motion`.

## Colour roles

| Token | Role |
| --- | --- |
| `--bg-canvas` / `--bg-surface` / `--bg-raised` | Desk, flat panels, menus |
| `--paper`, `--paper-ink`, `--paper-dim`, `--paper-rule` | Card stock. Inside a card the ink tokens are re-scoped to paper values (`style.css`, "Card stock"). |
| `--accent` (朱砂 cinnabar) | The single primary action, the card head rule / progress, the heatmap. Nothing else. |
| `--ok` jade | Correct, mastered |
| `--warn` ochre | Learning, contrasts to watch |
| `--bad` berry | Wrong, weak — deliberately far from cinnabar |

Rules: one filled primary button per screen; a primary that cannot act turns neutral, not muddy red; new CSS references tokens, never raw colours.

## Theme

`auto` follows `prefers-color-scheme` (inside DSH, the host appearance) and updates live; `dark` / `light` override. The resolved theme is always stamped on `.study-app`; `.study-seat` mirrors it for host overlays.

## Restraint

- No boxed navigation, no rows of equal stat tiles, no ambient glow or glass.
- No helper sentence where a number, label or layout already says it.
- Per-row actions (play, practise, select) appear on hover on pointer devices; information such as "继续 3/5" stays visible.

## Taste notes from the owner

- Likes: a clear focal point, creative but refined, generous space.
- Dislikes: formulaic blue-violet, pages that list everything at equal weight, dense maps.
- Knowledge skeleton: prefers a single learning axis with vertical branches and further side branches over a dense web.

## Knowledge diagram canvas (结构图)

Audience: learners exploring concepts and their relationships inside the DSH plugin.
Primary task: read a chain or branch, locate a concept, and follow its relationships.
Direction: preserve the plugin's existing typography, neutral surfaces and accent color.
Composition: independent connected components share one canvas with generous gutters; chains and branches follow a selectable direction.
Density: readable node labels; attributes remain available; search and local focus help on large diagrams.
Interaction: pan, zoom, fit, readable scale, fullscreen and component navigation remain available in narrow panels.
Restraint: no decorative dot background, no forced overview landing screen, no new visual framework.
Likes: structural separation, linear and branching layouts, same-canvas components, fullscreen.
Dislikes: tight diagrams, fixed wrapping that ignores relationships, controls that assume a wide browser.
Open questions: none blocking; validate against mixed graphs and narrow viewports.

## Final interaction choices

The default canvas stays on the shared graph. A compact node mode is automatic above 12 concepts; attributes are a reader-controlled option, never removed from details. Pane width determines orientation independently of browser width. Focus on narrow panes uses a vertical neighbourhood with side-routed long links. Small maps locate parts of the whole; search and the named component selector provide the textual navigation.

# Audio usage console

DIRECTED: extend the existing warm ink study workspace.

LIKES: the user wants a striking dashboard, visible free quota and independent time/quality choices.
NON-NEGOTIABLES: real API data, clearly labelled estimates, compact memory use, narrow desktop panes.

INTENT: see daily quota and control processing depth within five seconds.
CORE IDEA: a compact instrument console, with a quota dial and precise counters.
COMPOSITION: daily free quota first; provider rails, seven-day trend, then independent processing controls.
TYPE: existing UI font; tabular numbers, one large metric and quiet factual labels.
DENSITY: grouped details with generous separation between usage and controls.
SHAPE: one outer panel; unboxed provider rails and small square depth controls.
COLOR: jade for Gemini free, blue for Groq, cinnabar for paid requests and selected controls.
MATERIAL: existing flat ink surfaces, with matching light theme tokens.
IMAGERY: none; the data is the visual subject.
MOTION: no idle animation; keyboard and pointer interactions remain immediate.
INTERACTION: inspect quota, enter a known Gemini RPD, choose independent proofreading/translation depth.
RESTRAINT: no made-up balances, quality scores, chart libraries or decorative chart motion.

# Source reader (资料预览)

Audience: a learner reading a lecture, chapter, slide deck or transcript they imported, who wants to find a place, read comfortably and turn a passage into questions.
Primary task: read and orient, then select a passage. Reference: the reading view of O'Reilly's learning platform.
Composition: a fixed toolbar, then three areas that scroll on their own: outline (目录) | reading column | learning panel (学习). The dialog gives the reader its whole surface; the 1040px content cap does not apply to `.source-preview`.
Views: 阅读 (typeset, with an outline; the default), 原文 (the stored text exactly, line for line, for checking a citation) and 原始 PDF (only when the retained file exists). Word and PowerPoint keep their download button. Never offer two views that show the same thing.
Orientation: the toolbar names the current section; the outline marks it; a hairline of progress runs under the toolbar; previous / next section close the page. A source with nothing to navigate (plain text with no parts) shows no outline.
Reading controls (Aa): size (never below 15px), line width, typeface, tone (follow the app, or a paper sheet on the desk). Kept per browser. Search is inside the text (Ctrl/⌘+F while the reader has focus) and paints with the Custom Highlight API, so the page is never changed.
Colour: tokens only. The accent appears as the reading-progress line and the one primary button, nothing else. The paper tone re-scopes ink tokens to the `--paper-*` family inside the sheet.
Narrow panes: below 900px of viewer width (`NARROW` in `DocumentViewer.jsx`, mirrored in `reader.css`) the outline and the learning panel slide over the text with a scrim; Esc closes them before it closes the dialog.
Restraint: no helper sentence where the layout already says it (the related-questions heading appears only once something is linked); no boxed navigation.
Missing original (补全原文件, `OriginalFile.jsx`): a document that only kept its text gets one notice above the text: what is missing, what still works, the two ways to fix it, and a button. The 原始 PDF tab stays clickable without a file and opens the same dialog instead of being a dead button. One dialog serves the reader notice, that tab and the 资料 row menu: choose a path (or a browser file, which can only be copied), see the file checked against the stored text, pick the mode with its cost (default: remember the path, no space used), attach. A mismatch needs an explicit confirmation. A referenced file that moved or changed is named in plain words with 重新指定 and, while the file exists, 改为复制到资料库.

Contracts to keep when changing it:
- The selection tools read the DOM: `[data-study-text]` around the text, `[data-study-page]` / `[data-study-source]` on a page, `data-study-marker` on the passage marks. Reading mode keeps them; search ignores marked text. A transcript part's 【】 stay in the text, hidden.
- Rendered text keeps every character of the stored text. The backend compares whitespace-collapsed text, so a hard line break may be drawn without a gap (`.reader-join`, between two CJK characters) but must never be removed from the DOM.
- Never call `setState` from an effect that runs after every commit, even with an updater that returns the same value: React 18, the DSH host's React, re-renders until it throws error #185 (see `ScrollWindow`, issue #19). Measure on scroll and resize, and only set state when the value changed.
