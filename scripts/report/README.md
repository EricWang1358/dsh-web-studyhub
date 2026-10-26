# Report kit

Makes the before/after material for a UX change: sequence diagrams, a plain-words explanation, and one offline HTML deck.
No dependencies; pure ESM. Try it: `node scripts/report/build.mjs scripts/report/examples/sample-deck.json --out out/deck.html`.

## Add a step's slides
1. Copy `examples/sample-deck.json` next to your screenshots (image paths are relative to the json).
2. Write the flow once per side as `compare.before.steps` and `compare.after.steps`, **with the same `id` on a step that survives**.
   Marks are computed: id only in after = added, only in before = removed, same id but other text/from/to = changed.
   (A step with its own `kind` keeps it; `"diff": false` turns the computing off.)
3. Fill `plain` in everyday words: `原来` (what it was), `现在` (what it is), `对你有什么好处` (what the learner gains) are required
   and checked non-empty; `技术上改了什么` is optional and folded away. Say 「页面」「点一下」, not 「渲染」「回调」.
4. Add `table` (wording before/after), `images` (screenshots, every image needs `alt`), `stats` (click counts) slides, then build.
5. Look at it: `node scripts/report/shots.mjs out/deck.html --out out/shots` (1280x720 and 390x800, light and dark; fails on sideways scroll or clipped text).

## Deck json
`{ title, lang?: "zh-CN", toc?: true, slides: [...] }`. Text may use `**bold**` and `` `code` ``. Slide `type`:
- `title { title, subtitle?, meta? }`, `section { title, subtitle? }`, `text { title, paragraphs[] }`
- `bullets { title, items: [text | { text, sub[] }] }`, `table { title, columns[], rows[][], caption? }`
- `images { title, items: [{ src, alt, caption?, label? }] }`, `stats { title, items: [{ label, before, after, unit?, better?: "lower"|"higher", note? }] }`
- `compare { title, actors?, before, after, plain, diff? }` where before/after are diagram specs without the title.

## Diagram spec (`renderSequence(spec, options)` in `sequence.mjs`)
```
{ title, actors: [{ id, label }],
  steps: [{ id?, from, to, text, kind?: "same"|"added"|"changed"|"removed", note?, reply?, self? }],
  notes?: [{ over: [actorId], text, kind?, after?: stepIndex }],   // a box over lifelines, after a step (default: last)
  groups?: [{ label, from: stepIndex, to: stepIndex }] }           // a labelled frame around steps
```
Added = green + 「＋」, changed = orange + 「～」, removed = red, dashed, struck through + 「－」; the legend lists only kinds that occur.
Options: `lang` ("zh"|"en"), `colWidth`, `noteWidth`, `embedStyle`, `standalone` (adds xmlns). `layout(spec)` returns the geometry.

## Files
`sequence.mjs` (+`sequence-layout.mjs`) diagrams, `compare.mjs` compare + `diffSequences`, `deck.mjs` slides, `deck-style.mjs` and
`deck-script.mjs` page CSS/JS, `build.mjs` CLI, `shots.mjs` real-browser check, `text.mjs` escaping and CJK-aware wrapping.
Keys in the deck: ←/→/PageUp/PageDown/Home/End, `f` fullscreen; the bar has a light/dark toggle. Printing gives one slide per page.
