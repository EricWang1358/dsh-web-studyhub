# UML canvas changes and verification

2026-09-27 planning note: the current canvas is a reading/navigation capability. The proposed active-retrieval workflow below is not implemented; historical browser measurements in this document do not validate it.

The knowledge-skeleton UML canvas uses native HTML/SVG geometry, not Mermaid.

## Reading and navigation

- All weakly connected components share one canvas and are packed with separate boundaries.
- Hierarchy, parts and realizations retain their class structure. Causal chains and branches follow direction; merges follow the longer incoming branch. Cycles retain their edges and use a deterministic layout break.
- Narrow plugin panes use vertical layout. Desktop defaults to horizontal layout. Both directions and wider spacing are available in the Layout menu.
- Larger diagrams initially show concept names. Show Attributes restores class attributes; selection always exposes full details.
- Search, component selection, neighbour focus, a clickable minimap, pan, zoom, fit and original size support local reading without discarding the whole graph.
- Class and sequence diagrams both support fullscreen. When the browser denies fullscreen, a manual popover escapes the host's paint containment into a page-sized canvas. Older browsers without popovers use a fixed-position fallback.
- Keyboard: focus the class canvas, use arrows to pan, +/- to zoom, and 0 to fit. Enter/Space selects a node. Sequence arrows advance exactly one step. Escape leaves local focus / the expanded fallback.

## Performance

Viewport culling activates above 120 nodes; overscan preserves nearby content and the active drag node. The minimap's nodes are memoized. Pointer updates are batched to animation frames and saved positions are debounced. Saved layouts are separated by direction, spacing and attribute display.

A local Chromium run with a synthetic 1,000-node graph rendered 16–18 full node elements during local reading. Browser-frame measurement while panning had a median near 8 ms and p95 near 10 ms. These are local fixture measurements, not guarantees for every machine or graph.

## Verification (2026-09-20)

- Full Node test suite: 213 passed.
- Targeted ESLint on SkeletonCanvas, skeleton-diagrams and skeleton-layout tests: passed.
- Production plugin bundle and standalone build: passed.
- Geometry checks cover 2,000-node depth, 24-wide branches, cycles, missing references, isolated nodes, component bounds, directional layouts, merges, compact mode, narrow focus routing and viewport filtering.
- Browser checks cover native fullscreen, denied-fullscreen fallback inside a contained host, Escape, search and local focus, component filtering, layout direction/spacing, zoom, drag/save/reload, sequence keyboard/fullscreen, and a 420-pixel plugin pane in a wide browser.
- Viewports 360, 390, 768, 1280 and 1680: no page horizontal overflow. Empty state, no search results, light theme and reduced-motion behavior checked.
- Repository-wide `npm run verify` stops at pre-existing lint errors in unrelated site scripts. The errors are recorded in `output/uml-verify.log`; those files were not changed in this task.

Screenshots and browser check receipts are under `output/playwright/` and `output/uml-*-check.log` (local, ignored artifacts).

## Limits

Dense cyclic networks can still have crossing edges; this is deterministic hierarchical layout, not a crossing-free graph solver. At fit-all scale, large diagrams are overviews; use zoom, component selection or search to read individual concepts. Loading/service errors remain handled by the existing parent Skeleton screen.

## Planned active retrieval

The system-learning plan adds concept references independent of card references, so a required concept with no question remains visible. It reuses local focus and sequence views for hidden-node/relationship completion, ordering, fault tracing and reconstruction from a concrete case. Reading a graph or clicking a node does not create mastery evidence.
Assessment views must track prior answer exposure across the panel and conversation, support keyboard/text input, and credit only the objective actually checked. Existing per-skeleton size limits must not truncate the curriculum coverage denominator; large courses use multiple local views over one curriculum.
See [R11 and U7 in the development plan](plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) and [the proposed learner workflow](study-workflows.md#proposed-system-learning). New browser verification belongs to U7/U9, separately from the historical receipts above.
