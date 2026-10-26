# Report kit

Makes the before/after material for a UX change: sequence diagrams, a plain-words explanation, and one offline HTML deck.
No dependencies; pure ESM. Output goes under `output/reports/<step>/` (gitignored).
Try it: `node scripts/report/build.mjs scripts/report/examples/sample-deck.json --out output/reports/try/deck.html`.

## Add a step's slides
1. Copy `examples/sample-deck.json` into `output/reports/<step>/deck.json` next to your screenshots.
2. Write the flow once per side as `compare.before.steps` and `compare.after.steps`. **Every step needs an `id`** (added and removed
   steps too); marks are computed from ids: only in after = added, only in before = removed, same id but other text/from/to/reply/self
   or moved in the order = changed. A step's own `kind` wins. No ids anywhere, or `"diff": false`, means you give the kinds by hand.
   Some steps with ids and some without is an error that names the step (`slides[3] (compare): after step 2 has no id`).
3. Fill `plain` in everyday words: `原来` (what it was), `现在` (what it is), `对你有什么好处` (what the learner gains) are required
   and checked non-empty; `技术上改了什么` is optional and folded away. Say 「页面」「点一下」, not 「渲染」「回调」.
4. Add `table` (wording before/after), `images` (screenshots), `stats` (click counts) slides, then build.
5. Look at it: `node scripts/report/shots.mjs <deck.html> --out <dir>`: 1280x720 and 390x800, light and dark, plus keys and wheel
   against the slide counter; fails on sideways scroll, clipped or squeezed text.

## Deck json
`{ title, lang?: "zh-CN", toc?: true, slides: [...] }`. Text may use `**bold**` and `` `code` ``. Slide `type`:
- `title { title, subtitle?, meta? }`, `section { title, subtitle? }`, `text { title, paragraphs[] }`
- `bullets { title, items: [text | { text, sub[] }] }`, `table { title, columns[], rows[][], caption? }`
- `images { title, items: [{ src, alt, caption?, label? }] }`: `alt` is required; `src` is a png/jpeg/gif/webp file **inside the deck
  json's folder** (checked by its first bytes; `..` and absolute paths are refused) or a plain `data:image/...;base64,` address.
- `stats { title, items: [{ label, before, after, unit?, better?: "lower"|"higher", note? }] }`
- `compare { title, actors?, before, after, plain, diff? }`; before/after are diagram specs without the title.
The built page is checked for anything that would load from outside; text and attributes are escaped.

## Diagram spec (`renderSequence(spec, options)` in `sequence.mjs`)
```
{ title, actors: [{ id, label }],
  steps: [{ id?, from, to, text, kind?: "same"|"added"|"changed"|"removed", note?, reply?, self? }],
  notes?: [{ over: [actorId], text, kind?, after?: stepIndex }],   // a box over lifelines, after a step (default: last)
  groups?: [{ label, from: stepIndex, to: stepIndex }] }           // a labelled frame around steps
```
Added = green + 「＋」, changed = orange + 「～」, removed = red, dashed, struck through + 「－」; the legend lists only kinds that occur.
Options: `lang` ("zh"|"en"), `colWidth`, `noteWidth`, `embedStyle`, `standalone`. `layout(spec)` returns the geometry.
Files: `sequence*.mjs`, `compare.mjs` (+`diffSequences`), `deck*.mjs`, `images.mjs`, `selfcheck.mjs`, `build.mjs`, `shots.mjs`, `text.mjs`.
Deck keys: ←/→/PageUp/PageDown/Home/End, `f` fullscreen; the bar has a light/dark toggle. Printing gives one slide per page.
