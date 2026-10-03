# UML canvas

The **Knowledge outline** page draws a knowledge outline as two UML diagrams: **Class diagram · concept structure** and **Sequence diagram · interaction flow**. Both use native HTML and SVG geometry, not Mermaid.

**Status (planning note, 2026-09-27):** the canvas is a reading and navigation tool. The active-retrieval workflow under [Planned: active retrieval](#planned-active-retrieval) is not implemented, and the historical browser measurements on this page do not validate it.

| File | What it holds |
| --- | --- |
| `ui/SkeletonCanvas.jsx` | Both diagrams, their toolbars, keyboard handling, minimap and full screen |
| `ui/skeleton-diagrams.js` | Layout geometry: components, directions, merges, cycles, focus layout, viewport filtering and the sequence layout |
| `ui/Skeleton.jsx` | The parent page, which handles loading and service errors |
| `tests/skeleton-layout.test.mjs` | Geometry tests |

## Reading and navigation

### Layout

- All weakly connected components share one canvas and are packed with separate boundaries. When there is more than one, **Concept groups** shows one component at a time.
- Hierarchy, parts (`part-of`) and realisations (`example-of`) keep their class structure.
- Causal chains and branches follow the flow direction. A merge follows its longer incoming branch.
- Cycles keep their edges. One layout-only link is cut deterministically; the relation itself stays in the graph.
- The **Layout** menu sets the direction and the spacing:
  - Direction: **Automatic direction** (the default), **Left to right** or **Top to bottom**. Automatic uses top to bottom in a narrow plugin pane and left to right otherwise.
  - Spacing: **Standard spacing** or **Relaxed spacing**.
- Dragged positions are remembered on this device. **Reset layout** returns to the automatic layout.

### Finding and focusing

- A diagram with more than 12 concepts opens with concept names only. **Show properties** adds the class attributes. Selecting a concept always shows its full details.
- Local reading never discards the whole graph. It is supported by:
  - **Find concept…** search;
  - **Concept groups**, which selects one component;
  - **Neighbours only**, which focuses on the selected concept and its direct neighbours (**Show entire graph** returns);
  - a clickable minimap, shown when the diagram has more than 12 boxes;
  - pan, zoom, **Fit** and **Original size**.

### Full screen

- Both diagrams have **Full screen**.
- When the browser denies full screen, a manual popover escapes the host's paint containment into a page-sized canvas.
- Older browsers without popovers use a fixed-position fallback.

### Keyboard

Keys act on the diagram that has keyboard focus. For the class diagram, focus its canvas first.

| Key | Class diagram | Sequence diagram |
| --- | --- | --- |
| Arrow keys | Pan | Right and Left advance or go back exactly one step |
| `+` (or `=`) and `-` | Zoom in and out | – |
| 0 | Fit | – |
| Enter or Space | Select or deselect the focused concept | – |
| Escape | Close the expanded fallback; otherwise clear the selection, which also leaves **Neighbours only** | Close the expanded fallback |

## Performance

- Viewport culling starts above 120 nodes. Overscan keeps nearby content and the node being dragged.
- The minimap's nodes are memoised.
- Pointer updates are batched to animation frames, and saving dragged positions is debounced.
- Saved layouts are kept separately for each combination of direction, spacing and attribute display.

A local Chromium run with a synthetic 1,000-node graph rendered 16–18 full node elements during local reading. While panning, browser frames had a median near 8 ms and a p95 near 10 ms. These are local fixture measurements, not guarantees for every machine or graph.

## Limits

- Dense cyclic networks can still have crossing edges. This is a deterministic hierarchical layout, not a crossing-free graph solver.
- At fit-all scale, large diagrams are overviews. Use zoom, **Concept groups** or search to read individual concepts.
- Loading and service errors are handled by the parent page (`ui/Skeleton.jsx`).

## Verification record (2026-09-20)

This is the record of the change that introduced the current canvas. The numbers are from that date.

- Full Node test suite: 213 passed.
- Targeted ESLint on `SkeletonCanvas`, `skeleton-diagrams` and the skeleton-layout tests: passed.
- Production plugin bundle and standalone build: passed.
- Geometry checks covered 2,000-node depth, 24-wide branches, cycles, missing references, isolated nodes, component bounds, directional layouts, merges, compact mode, narrow focus routing and viewport filtering.
- Browser checks covered:
  - native full screen, the denied-full-screen fallback inside a contained host, and Escape;
  - search, local focus and component filtering;
  - layout direction and spacing, zoom, and drag, save and reload;
  - sequence keyboard and full screen;
  - a 420-pixel plugin pane in a wide browser.
- At viewports 360, 390, 768, 1280 and 1680 there was no horizontal page overflow. The empty state, no search results, the light theme and reduced-motion behaviour were checked.
- Repository-wide `npm run verify` stopped at pre-existing lint errors in unrelated site scripts. The errors are recorded in `output/uml-verify.log`; that change did not touch those files.

Screenshots and browser check receipts are in `output/playwright/` and `output/uml-*-check.log`. They are local artifacts that git ignores.

## Planned: active retrieval

The system-learning plan would turn the canvas into a place to practise, not only to read. None of this is implemented.

- **Concept references.** Concepts get references of their own, independent of card references, so a required concept with no question stays visible.
- **Practice on the graph.** It reuses local focus and the sequence view for:
  - completing hidden nodes and relationships;
  - ordering steps;
  - fault tracing;
  - rebuilding part of the structure from a concrete case.
- **Evidence rules.**
  - Reading a graph or clicking a node does not create mastery evidence.
  - Assessment views must track earlier answer exposure across the panel and the conversation. They must support keyboard and text input, and credit only the objective actually checked.
- **Coverage.** Existing per-outline size limits must not truncate the curriculum coverage denominator. Large courses use several local views over one curriculum.

See [R11 and U7 in the development plan](plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) and [the proposed learner workflow](study-workflows.md#proposed-system-learning). New browser verification belongs to U7 and U9, separate from the historical record above.
