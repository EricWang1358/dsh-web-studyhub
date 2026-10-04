# Study panel design (1.0)

## Daily learning action hub

Mode: directed by the existing ink-on-desk system. Returning learners should see what to do next and their remaining daily allowance within five seconds. The primary object is the next action, not a dashboard of tasks or a negotiation form.

Thesis: a quiet daily briefing with one large action title and one cinnabar launch control. A thin progress rule and modest time labels orient the learner; the full plan sits behind a native disclosure. An unaccepted AI proposal temporarily takes this focal position so consent stays explicit. AI feedback and regular pace are separate, on-demand editors.

Taste constraints: no equal-weight task cards, no always-visible settings form, no invented precision for remaining task time. In-progress actions come first. Completed history stays accessible for time recording. Learning pages show a compact connection to today's action without a second launch button. Keep the established fonts, colour tokens and keyboard-visible controls; introduce no animation or external assets.

Subtraction: remove the persistent feedback form, the repeated row reasons and launch controls from context strips, the nested proposal box, and the decorative top rule. Preserve explanations where they support a decision: the next action, proposal review and optional editors. The action title owns display scale; the briefing heading stays small. Keep the launch adjacent to its duration rather than across an empty row.

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

Accent presets (设置 › 界面 › 强调色): cinnabar stays the default and the identity; jade, ochre, graphite and plum are opt-in swaps of `--accent`, `--accent-soft`, `--accent-text` and `--bg-selected` (`ui/accent.css`, one `data-accent` attribute), nothing else changes. There is no free colour picker, so every preset is contrast-checked in `tests/accent-presets.test.mjs`, and none is blue-violet. The mastery hues (`--ok` jade, `--warn` ochre) keep their meaning; a preset that shares a hue with one is a choice of the learner, not a signal.

## Theme

`auto` follows `prefers-color-scheme` (inside DSH, the host appearance) and updates live; `dark` / `light` override. The resolved theme is always stamped on `.study-app`; `.study-seat` mirrors it for host overlays.

Personalisation (设置 › 界面, `ui/appearance-prefs.js`) is data attributes on `.study-app` plus token overrides in `ui/appearance-themes.css`; the default of each setting has no rule, so it renders exactly as before.

- `oled` (dark base) and `paper` 护眼纸色 (light base) set `data-palette`; `data-theme` stays `dark` / `light`, so everything that only knows two modes keeps working. Both keep the cinnabar accent and the paper card; new palettes must pass the AA assertions in `tests/wp1-tokens.test.mjs`, incl. card stock. The sidebar toggle cycles `auto → dark → light` only (`THEME_CYCLE`); the extra themes are chosen in Settings.
- Contrast (`data-contrast`, `auto` follows `prefers-contrast: more`) overrides only `--line*`, `--text-faint`, `--decor-faint` and the focus outline. `@media (forced-colors: active)` re-states buttons, focus and selected states with system colours.
- Density (`data-density`) scales only `--space-*` and `--lh-*`; corner style (`data-radius`) only `--radius`, `--radius-sm`, `--radius-card`. New CSS should write `var(--radius…)` / `var(--space-…)` / `var(--fs-…)` where a value equals a token (`tests/css-token-guard.test.mjs` also fails on new raw hex colours).

## Restraint

- No boxed navigation, no rows of equal stat tiles, no ambient glow or glass.
- No helper sentence where a number, label or layout already says it.
- Per-row actions (play, practise, select) appear on hover on pointer devices; information such as "继续 3/5" stays visible.

## Taste notes from the owner

- Likes: a clear focal point, creative but refined, generous space.
- Dislikes: formulaic blue-violet, pages that list everything at equal weight, dense maps.
- Knowledge skeleton: prefers a single learning axis with vertical branches and further side branches over a dense web.

## Daily study recaps

The recap is the day's closing feedback: course, saved insight, then one primary action. Use the existing desk surfaces and controls; course rows stay typographic under a shared rule. Show the saved article's opening prose so the learner receives feedback before opening the reader. Thresholds and actual batch progress explain the current state; general rules stay collapsed. Reading and editing share one document, and returning to reading saves changed text. Manual edits, the ten-distinct-answer threshold, same-day course grouping and explicit automatic opt-in are fixed product decisions. Material conversion and public publishing remain separate secondary actions. The owner wants clearer feedback and less procedural clutter; avoid stacked toolbars, repeated explanations and competing primary buttons.

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

# Learning spine (脉络)

Audience: a learner who wants the skeleton's main line while reading a lesson, or the skeleton itself on the 知识骨架 step and page.
Primary task: know which station of the line they are on, read it in full, move to the next, never lose the lesson below.
Composition: a one-line stepper strip (numbered circles on one baseline, titles clamp to two lines with the full title in the tooltip), ONE detail pane for the current station (description, practice link, every point, nothing truncated; two columns of points where wide), and "展开全部" for a vertical accordion of every station. A column or row is never stretched to a taller sibling.
Fold: where the lesson mounts it (`WorkflowPortal` `SpinePeek`) it is one folded line (title, "5 站 · 8 个要点", a current-station chip with previous / next); on the skeleton step it starts open. The fold is remembered per browser and per step type in `localStorage` (`study-spine-<step kind>`, always inside try/catch).
Narrow panes (container below 820px): the strip keeps only the numbered circles so five stations fit a phone; the title is in the tooltip, the aria label and the detail pane heading.
Semantics: strip = `tablist` / `tab` (roving tabindex, ← → Home End, focus follows selection) and the pane is its `tabpanel`; the fold toggle carries `aria-expanded` / `aria-controls`; the overview accordion marks the current station `aria-current="step"`.
Contract: `tests/spine-layout.test.mjs` measures panel heights, clipping and the baseline in a real browser (`scripts/qa/spine-layout.mjs`); `tests/spine-markup.test.mjs` covers the markup in both languages.

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

Link underlines (2.3.2): a passage that has a question, a Q&A card (an answer saved as a flashcard) or a note is underlined in the reading view, painted with the Custom Highlight API like search, so the text is untouched. The look says the kind without a legend: solid = question, dotted = Q&A card, dashed muted = note; where they overlap, question wins. Only links that resolve in the current revision are underlined; the rest wait in a "needs re-selecting" list with the reason. A click or tap on underlined text (not a drag) opens that passage's links in the learning panel (its questions, short answers, deck, "open this question", the card's follow-up Q&A, notes made from those cards); the superscript [n] marker after each passage is the keyboard path (Tab, Enter), because highlight ranges cannot take focus. Display settings (Aa) has a "Link underlines" Show / Hide row: hiding clears the highlights and the pointer handling, and keeps the markers and the list. Ranges are located once per links or text change (`links/link-ranges.js`, one walk per page), never on render or scroll.

Bilingual reading (译, `ui/document-preview/translation/`): the original PDF is read in another program beside StudyHub; StudyHub's text reader is where the bilingual reading happens, so it has to be light, quiet and exact.
Unit: a paragraph (a selected passage is the same thing, smaller). Each paragraph that is not already in the target language gets a quiet inline 译 at its end (visible on hover or focus, always on touch; Alt+T acts on the selection, else the paragraph under the pointer). Selecting words shows a 译 chip at the end of the selection. The button says none / translating (spinner, a click cancels) / has (filled) / stale (dashed: the glossary changed since) / error. A translation is never drawn inside the paragraph: it is a block after it, so a sentence is never broken.
Block: a labelled note (`role="note"`, the language of the translation on it), smaller type, a left rule and a tint in `--info`, which nothing else in the reader uses (link underlines are accent and drawn on the text). The bar has a fold handle and the 译 tag (EN for English), the version and the learner's comment ("v2 · 意见：…"), the ⋯ menu: copy, retranslate with a comment, glossary, delete (undo for eight seconds). A fold keeps the bar and one line of preview.
Modes (one row in Aa, kept per browser): 逐段对照 (under its paragraph; the default), 左右分栏 (original left, translation right: every paragraph and its block are in one grid row, so heights match without scroll sync; it falls back to 逐段对照 when the reader is under 900px or the reading column under 640px, and says so), 仅中文/仅英文 (the original folds to its first line, a click unfolds it), 隐藏译文 (only the marks; a click on a mark shows that one). Markdown/HTML lists and other nested blocks stay stacked in 左右分栏 (a grid needs direct children).
Costs are visible before they are paid: the 译 popover prices 本页 / 本节 / 本章 with the shared token estimate and says how many paragraphs are left; the job (background, bounded batches, at most three in flight, stop keeps what is done, never twice) shows done/total, the clock and what it used against what was expected in the reader's notices, and files an inbox letter.
Contracts: marks, blocks and the chip carry `data-study-marker` (selection capture, find, link underlines and the outline skip them); no stored character, `data-study-*` attribute, citation or card link is touched; a translation is kept per document revision and never applied to another (listed as older, reused where the words did not change); the 原文 view gets the chip and a floating card because its text is one `<pre>`.
