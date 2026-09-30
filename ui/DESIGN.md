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
