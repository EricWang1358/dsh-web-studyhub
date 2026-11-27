// Each edit restores one observed defect in an isolated checkout.
export const witnessFile = 'tests/replacement-controls.test.mjs';
export const controls = [
  {
    id: 'exam-report',
    source: 'ui/Exam.jsx',
    test: 'tests/exam-report-bridge.test.mjs',
    candidate: /^examReport \+ snapshot-shaped decks/,
    witness: 'a second completed exam has no practice-path notice from the first report',
    message: 'the second report must clear the first practice notice',
    edits: [
      ['setPathNote("");\n      exam.enter(r);', 'exam.enter(r);'],
      ['setPathNote(""); exam.leave({ clear: false });', 'exam.leave({ clear: false });'],
    ],
  },
  {
    id: 'number-unmount',
    source: 'ui/letterpress/LetterpressNumber.jsx',
    test: 'tests/wave2-letterpress-reader.test.mjs',
    candidate: /^LetterpressNumber keeps @number-flow\/react out of its static closure/,
    witness: 'resolving the number animation after unmount attempts no state write',
    message: 'the completed import must not call the unmounted counter setter',
    edits: [['if (isLive()) setRuntime(() => mod.default);', 'setRuntime(() => mod.default);']],
  },
  {
    id: 'board-drag',
    source: 'ui/Board.jsx',
    test: 'tests/w2-oss-library-replacements.test.mjs',
    candidate: /^7\. pragmatic-drag-and-drop Board/,
    witness: 'a card drag reads its midpoint once and does not scan sibling cards on pointer moves',
    message: 'pointer moves must reuse the measured midpoint without scanning sibling cards',
    edits: [[
      '        onDrag: ({ location }) => {\n',
      '        onDrag: ({ location }) => {\n          for (const card of element.parentElement.querySelectorAll(":scope > .board-card")) card.getBoundingClientRect();\n',
    ]],
  },
  {
    id: 'skeleton-id',
    source: 'ui/SkeletonCanvas.jsx',
    test: 'tests/w2-ui-perf-regression.test.mjs',
    candidate: /^(?:ClassCanvas|usePanZoom) preserves user pan\/zoom/,
    witness: 'changing only the skeleton ID resets the viewport, retaining it for the same ID',
    message: 'switching only the skeleton ID must reset the viewport',
    edits: [['fitKey: `${skeleton.id}:${componentId}:${focused || ""}`', 'fitKey: `${componentId}:${focused || ""}`']],
  },
];
