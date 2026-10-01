/* Sample course for the StudyHub tour, English edition (plan §3 D4).
   Ported from the static demo (web-demo/content.js, fixtures.js, seed.js) and
   expanded into a Markdown lecture so the document viewer, passage selection
   and question↔passage links have real material. Every quote below appears
   verbatim in `document.markdown` after rendering; tests check that. */

const markdown = `# Design patterns · Memento and Bridge

> Sample lecture notes for the StudyHub tour. The course is fictional and can be removed at any time.

## 1. Memento: undo without breaking encapsulation

Memento lets an object save and restore its state without exposing its internals.

- The Originator creates and restores its own snapshots.
- A Memento stores an opaque snapshot of internal state.
- The Caretaker manages snapshot history without inspecting snapshot contents.

A narrow interface hides snapshot internals from the Caretaker, while the Originator needs access to restore state.

**Example.** A text editor saves a snapshot before each edit. When the user presses Undo, the history hands the latest snapshot back to the editor, and the editor restores itself.

## 2. Bridge: two dimensions that vary independently

Bridge separates abstraction from implementation so both can vary independently.

In a report rendering system, report types and rendering backends are two independent dimensions. Subclassing every report-backend combination produces a cross product of classes.

With Bridge, a report holds a reference to a rendering implementation and delegates the drawing to it. Adding a new backend no longer requires a new subclass for every report type.

## 3. Choosing between them

Memento is about capturing and restoring state. Bridge is about letting two dimensions of change evolve separately. Name the problem first, then choose the pattern.
`;

const option = (id, text, correct, explanation) => ({ id, text, correct, explanation });

export default {
  language: "en",
  course: "Sample course · Design patterns",
  // The course record (WP13): a small exam profile so the course panel and case practice have something to show.
  // The exam date is set relative to the day the sample is loaded.
  exam: { format: "open-book-case", totalMarks: 40, writingMinutes: 120, readingMinutes: 10, daysAhead: 28,
    sections: [
      { title: "Part A · Snapshots and history", lecturer: "Sample lecturer", marks: 20, topics: ["Memento", "Caretaker"] },
      { title: "Part B · Independent variation", lecturer: "Sample lecturer", marks: 20, topics: ["Bridge", "Choosing a pattern"] },
    ] },
  focusTopics: ["Choosing a pattern"],
  document: {
    title: "Sample · Design patterns lecture notes",
    filename: "sample-design-patterns.md",
    markdown,
  },
  deck: {
    title: "Sample · Memento and Bridge",
    cards: [
      { key: "memento-owner", kind: "quiz", topic: "Memento",
        objective: "Distinguish the history manager from the snapshot container",
        prompt: "In the Memento pattern, which component manages the history without inspecting snapshot contents?",
        answer: "Caretaker",
        hint: "Distinguish a single snapshot from the object that manages many snapshots.",
        explanation: "The Caretaker keeps the history. The Originator still creates and restores its own snapshots.",
        misconception: "Mistaking the Memento snapshot for the history manager.",
        quote: "The Caretaker manages snapshot history without inspecting snapshot contents.",
        options: [
          option("caretaker", "Caretaker", true, "It maintains the history through an opaque snapshot interface."),
          option("memento", "Memento", false, "It represents one snapshot; it does not manage the history."),
          option("originator", "Originator", false, "It creates and restores state. The Caretaker manages the history."),
        ] },
      { key: "memento-interface", kind: "quiz", topic: "Memento",
        objective: "Explain the access boundary around snapshots",
        prompt: "Why do the Caretaker and Originator need different access to the same snapshot?",
        answer: "The Caretaker only manages snapshots; the Originator must access their state to restore the object.",
        hint: "Compare what you need to know to keep a snapshot with what you need to restore state.",
        explanation: "A narrow interface hides internal state from the Caretaker while the Originator keeps the access it needs to restore.",
        misconception: "Assuming every object that holds a snapshot must know its internal fields.",
        quote: "A narrow interface hides snapshot internals from the Caretaker, while the Originator needs access to restore state.",
        options: [
          option("boundary", "Keeping a snapshot and restoring state need different access", true, "Keeping history needs no access to the contents; restoring state does."),
          option("inheritance", "The Caretaker should inherit the Originator's state", false, "Inheritance does not create the encapsulation boundary the pattern needs."),
          option("mutation", "The Caretaker may edit snapshot contents at any time", false, "Editing the contents breaks the opaque snapshot boundary."),
        ] },
      { key: "bridge-render", kind: "flashcard", topic: "Bridge",
        objective: "Identify the independent dimensions in report rendering",
        prompt: "What problem does the Bridge pattern solve in a report-rendering system?",
        answer: "It separates report types from rendering backends so the two dimensions can vary independently, without a subclass for every combination.",
        hint: "With five report types and four backends, how many combinations would inheritance produce?",
        explanation: "The report abstraction holds a rendering implementation. Adding a backend does not require a new subclass for every report type.",
        misconception: "Tying two independent dimensions into one inheritance hierarchy.",
        quote: "In a report rendering system, report types and rendering backends are two independent dimensions." },
      { key: "snapshot-restore", kind: "flashcard", topic: "Memento",
        objective: "Name the role that creates and restores snapshots",
        prompt: "Who creates and restores the snapshots in Memento?",
        answer: "The Originator creates and restores its own snapshots.",
        hint: "Which object understands its own internal state best?",
        explanation: "The object that owns the state knows how to capture and restore it. The Caretaker only manages the history.",
        misconception: "Thinking the Caretaker restores state because it keeps the history.",
        quote: "The Originator creates and restores its own snapshots." },
      { key: "snapshot-opaque", kind: "flashcard", topic: "Memento",
        objective: "Explain why a snapshot can be stored without being read",
        prompt: "Why can the Caretaker store a snapshot without reading it?",
        answer: "The snapshot is opaque to the Caretaker; a narrow interface hides its internal contents.",
        hint: "Do you need to read a sealed envelope to keep it safe?",
        explanation: "Holding a snapshot and interpreting its contents are separate responsibilities.",
        misconception: "Assuming that storing a snapshot requires understanding it.",
        quote: "A Memento stores an opaque snapshot of internal state." },
      { key: "bridge-dimensions", kind: "flashcard", topic: "Bridge",
        objective: "Name the two dimensions in the report example",
        prompt: "Name the two independent dimensions in the report example.",
        answer: "Report types and rendering backends.",
        hint: "What does the user ask for, and how does the system draw it?",
        explanation: "Bridge separates the abstraction from the implementation so either dimension can change independently.",
        misconception: "Treating the backend as a detail of each report type.",
        quote: "Bridge separates abstraction from implementation so both can vary independently." },
      { key: "bridge-cross-product", kind: "flashcard", topic: "Bridge",
        objective: "Count the subclasses that inheritance would need",
        prompt: "With five report types and four rendering backends, how many combination subclasses would inheritance need?",
        answer: "Twenty: 5 × 4.",
        hint: "Multiply the sizes of the two dimensions.",
        explanation: "Subclassing every pair produces a cross product of classes. Bridge avoids encoding every combination as a subclass.",
        misconception: "Adding the dimensions (5 + 4) instead of multiplying them.",
        quote: "Subclassing every report-backend combination produces a cross product of classes." },
      { key: "bridge-delegate", kind: "quiz", topic: "Bridge",
        objective: "Describe how a Bridge abstraction uses its implementation",
        prompt: "With Bridge in place, how does a report get drawn by a newly added backend?",
        answer: "The report delegates the drawing to the rendering implementation it holds.",
        hint: "Look for composition rather than inheritance.",
        explanation: "The report holds a reference to a rendering implementation and delegates to it, so a new backend plugs in without new report subclasses.",
        misconception: "Expecting each report type to subclass the new backend.",
        quote: "With Bridge, a report holds a reference to a rendering implementation and delegates the drawing to it.",
        options: [
          option("delegate", "It delegates to the rendering implementation it holds", true, "Composition lets any report use any backend."),
          option("subclass", "A new subclass is written for each report type", false, "That is the cross product Bridge avoids."),
          option("copy", "The report copies the backend's drawing code", false, "Copying the code couples the two dimensions again."),
        ] },
      { key: "memento-roles", kind: "cloze", topic: "Memento",
        objective: "Recall which role restores state and which keeps history",
        prompt: "The {{a}} creates and restores snapshots; the {{b}} keeps the history without reading them.",
        answer: "Originator; Caretaker",
        hint: "One role owns the state; the other only keeps the history.",
        explanation: "The Originator creates and restores snapshots. The Caretaker stores them without looking inside.",
        misconception: "Swapping the role that restores state with the role that keeps the history.",
        quote: "The Originator creates and restores its own snapshots.",
        cloze: { text: "The {{a}} creates and restores snapshots; the {{b}} keeps the history without reading them.",
          answers: [{ id: "a", value: "Originator", accept: [] }, { id: "b", value: "Caretaker", accept: [] }] } },
    ],
  },
  /* Practised for three weeks; the last two answers on these were wrong. */
  weak: ["memento-owner", "bridge-render"],
  /* Never practised, so the home still offers new questions. */
  fresh: ["bridge-delegate", "memento-roles"],
  /* Forgotten once and relearned two days ago, so they are due for review today. */
  due: ["snapshot-opaque", "bridge-cross-product"],
  /* The tour's practice round: a choice question first, then each kind of card. */
  practice: ["memento-owner", "bridge-delegate", "memento-interface", "bridge-render", "memento-roles"],
  prerequisites: [["memento-interface", "snapshot-opaque"], ["memento-roles", "snapshot-restore"],
    ["bridge-cross-product", "bridge-dimensions"], ["bridge-render", "bridge-dimensions"]],
  draft: {
    title: "Sample draft · Choosing a pattern",
    cards: [
      { key: "draft-undo", kind: "quiz", topic: "Choosing a pattern",
        objective: "Recognise when Memento fits an undo requirement",
        prompt: "A drawing app must let users undo brush strokes without exposing the canvas internals. Which pattern fits best?",
        answer: "Memento",
        hint: "Undo means going back to an earlier state.",
        explanation: "Memento captures the canvas state in an opaque snapshot and restores it on undo.",
        misconception: "Choosing Bridge because the app has several kinds of brushes.",
        quote: "Memento lets an object save and restore its state without exposing its internals.",
        options: [
          option("memento", "Memento: the canvas saves snapshots", true, "Snapshots let the canvas restore itself without exposing its state."),
          option("bridge", "Bridge: brushes separate from the canvas", false, "Bridge separates two dimensions of change; it does not restore state."),
          option("subclass", "A new subclass for every brush stroke", false, "Subclasses cannot capture runtime state for undo."),
        ] },
      { key: "draft-charts", kind: "quiz", topic: "Choosing a pattern",
        objective: "Recognise when Bridge fits two growing dimensions",
        prompt: "A chart library supports three chart types on two renderers (SVG and Canvas), and both lists will grow. Which design avoids a class for every pair?",
        answer: "Bridge",
        hint: "Count the dimensions that change independently.",
        explanation: "Chart types and renderers are independent dimensions; Bridge lets each grow without multiplying classes.",
        misconception: "Accepting one subclass per combination because there are only six today.",
        quote: "Bridge separates abstraction from implementation so both can vary independently.",
        options: [
          option("bridge", "Bridge: charts delegate to a renderer", true, "Chart types hold a renderer and delegate the drawing to it."),
          option("memento", "Memento: charts save their snapshots", false, "Memento saves state; it does not separate dimensions of change."),
          option("cross", "One subclass per chart-renderer pair", false, "That grows as a cross product: six classes today, more tomorrow."),
        ] },
      { key: "draft-compare", kind: "flashcard", topic: "Choosing a pattern",
        objective: "Contrast the problems Memento and Bridge solve",
        prompt: "In one sentence, how do Memento and Bridge differ?",
        answer: "Memento saves and restores state; Bridge lets two dimensions of change vary independently.",
        hint: "One is about time, the other about variation.",
        explanation: "Name the problem first: restoring an earlier state points to Memento, independent variation points to Bridge.",
        misconception: "Treating both as general ways to decouple code without naming the problem.",
        quote: "Memento is about capturing and restoring state. Bridge is about letting two dimensions of change evolve separately." },
    ],
  },
  skeleton: {
    title: "Sample · Design patterns: roles and boundaries",
    overview: "A worked example connecting state restoration to independent variation. Select a concept to see its linked questions.",
    classNote: "Memento separates history management from state access. Bridge separates two independently changing dimensions.",
    nodes: [
      { id: "originator", term: "Originator", meaning: "Owns state; creates and restores snapshots.", attributes: ["Owns internal state", "Creates and restores"], cards: ["snapshot-restore", "memento-interface", "memento-roles"] },
      { id: "memento", term: "Memento", meaning: "An opaque snapshot of one previous state.", attributes: ["Opaque contents", "One saved state"], cards: ["snapshot-opaque"] },
      { id: "caretaker", term: "Caretaker", meaning: "Keeps snapshot history without reading its contents.", attributes: ["Manages history", "No state inspection"], cards: ["memento-owner"] },
      { id: "abstraction", term: "Report abstraction", meaning: "Describes a report independently of its rendering backend.", attributes: ["Report types", "Delegates rendering"], cards: ["bridge-render", "bridge-cross-product", "bridge-delegate"] },
      { id: "implementation", term: "Rendering implementation", meaning: "Provides a backend that varies independently of report types.", attributes: ["Rendering backends", "Independent variation"], cards: ["bridge-dimensions"] },
    ],
    relations: [
      { from: "originator", to: "memento", type: "related", note: "Creates and restores" },
      { from: "caretaker", to: "memento", type: "related", note: "Stores without inspection" },
      { from: "abstraction", to: "implementation", type: "related", note: "Delegates through composition" },
      { from: "memento", to: "abstraction", type: "contrasts", note: "State restoration versus independent variation" },
    ],
    sequences: [{ title: "Undo in a text editor", explanation: "An illustrative application of the sample notes. The editor restores its own state.",
      participants: [{ id: "history", label: "History", node: "caretaker" }, { id: "editor", label: "Editor", node: "originator" }],
      steps: [{ from: "history", to: "editor", message: "Request a snapshot before editing" },
        { from: "editor", to: "history", message: "Return an opaque snapshot", kind: "return" },
        { from: "history", to: "editor", message: "Undo: restore the saved snapshot" }] }],
  },
  notes: [
    { key: "memento", topic: "Memento", title: "Sample notes · Why the Caretaker cannot read a snapshot",
      markdown: "# Memento: managing history without exposing state\n\n> Sample learning notes. Edit them freely; they are removed with the sample course.\n\n## Three responsibilities\n\n- **Originator:** creates and restores its own state.\n- **Memento:** one opaque snapshot.\n- **Caretaker:** stores and retrieves snapshots.\n\n## The envelope analogy\n\nA caretaker can store sealed envelopes without reading the letters inside. The originator knows how to interpret the contents. This is an analogy, not a literal implementation.\n\n## Common mistake\n\nA Memento is a snapshot, not the history manager. The Caretaker manages the history.\n\n## Next recall question\n\nWhy does keeping a snapshot require less access than restoring it?" },
    { key: "bridge", topic: "Bridge", title: "Sample notes · Avoiding twenty report subclasses",
      markdown: "# Bridge: two dimensions of change\n\n> Sample learning notes. Edit them freely; they are removed with the sample course.\n\n## Worked example\n\nFive report types and four rendering backends create **20 combinations** if each pair needs its own subclass.\n\n## Design decision\n\nKeep report types and rendering backends separate. A report holds a rendering implementation and delegates the backend work to it.\n\n## Compare the patterns\n\nMemento addresses snapshots and restoration. Bridge addresses independent variation. Identify the problem before choosing the pattern.\n\n## Try it\n\nEdit these notes, then practise the linked questions." },
  ],
  lesson: {
    goal: "Explain the Memento roles and recognise when Bridge helps.",
    title: "Sample · From explanation to practice",
    note: "Prepared sample lesson. No model request was made.",
    sections: [
      ["A familiar problem: undo", "Imagine a text editor. Before changing “Hello” to “Hello world”, it saves a snapshot. Pressing Undo hands the earlier snapshot back to the editor, and the editor restores its own state. This is an illustrative example of the roles described in the sample notes."],
      ["Three roles, one clear boundary", "The Originator owns the state and creates and restores snapshots. The Memento holds one opaque snapshot. The Caretaker keeps the history without inspecting snapshot contents. Think of sealed envelopes: storing the envelopes does not require reading the letters."],
      ["Why different access matters", "The Caretaker only needs to keep and return a snapshot. The Originator needs to read it to restore state. A narrow interface keeps internal fields hidden from the Caretaker, so history management does not depend on the object’s internal representation."],
      ["A different problem: independent variation", "In a report system, report types and rendering backends can vary independently. Five types and four backends create twenty combinations if every pair is a subclass. Bridge separates the abstraction from its implementation so both can change independently."],
      ["Check the distinction", "Memento concerns state snapshots and restoration. Bridge concerns independent dimensions of variation. Before naming a pattern, identify the problem it solves. Next, explain these roles in your own words, then test yourself in the practice step."],
    ],
  },
  followup: { card: "memento-owner", question: "Why is the snapshot not the history manager?",
    answer: "The Memento represents one saved state. The Caretaker manages the collection of snapshots, and the Originator creates and restores them.\n\n*Prepared sample explanation.*" },
  // A small case set (WP12): a scenario, two open questions with rubric criteria and a pre-graded example paper.
  caseStudy: {
    title: "Sample case · Quillpad",
    scenario: { title: "Case: Quillpad notes app", paragraphs: [
      "Quillpad is a small company that makes a note-taking app for students. Its editor keeps every note as a tree of blocks: headings, paragraphs, checklists and embedded images.",
      "Students keep losing work. Last term the support inbox received more than three hundred complaints after an update, because pressing Undo twice sometimes restored a note from the wrong day.",
      "The current undo feature copies the whole note into a global history list that the toolbar, the sync service and the search index all read and modify directly.",
      "Quillpad now wants to export notes to PDF, HTML and an e-reader format, and the product owner expects more export targets next year, such as slides.",
      "The team of four developers knows the editor well but has never maintained a plug-in system, and it can spend only two sprints on this work before the exam season.",
    ] },
    cues: [
      { id: "cue1", paragraph: 3, quote: "the toolbar, the sync service and the search index all read and modify directly", implies: "The history is not encapsulated; a Memento keeps snapshots opaque to everyone but the editor" },
      { id: "cue2", paragraph: 4, quote: "expects more export targets next year", implies: "A new dimension of variation: Bridge keeps note types and export backends independent" },
    ],
    questions: [
      { key: "case-undo", marks: 6, topic: "Memento", objective: "Case: redesign Quillpad's undo with Memento",
        prompt: "Question 1 (6 marks): How would you redesign Quillpad's undo feature? Name the pattern and its roles in this app, and justify your choice with facts from the case.",
        quote: "pressing Undo twice sometimes restored a note from the wrong day",
        criteria: [
          { id: "c1", label: "Recommendation using Memento", marks: 3, descriptor: "Recommends Memento and maps Originator, Memento and Caretaker onto the editor, a snapshot and the undo history.",
            keyPoints: ["The note editor is the Originator", "The undo history is a Caretaker that never reads snapshots"] },
          { id: "c2", label: "Case linkage", marks: 2, descriptor: "Ties the design to facts of the case rather than to any app.",
            keyPoints: ["A shared history changed by toolbar, sync and search breaks encapsulation", "Wrong-day restores call for ordered snapshots per note"] },
          { id: "c3", label: "Assumptions and trade-offs", marks: 1, descriptor: "States an assumption where the case is silent and weighs its cost.",
            keyPoints: ["Assumes a limit on snapshots per note"] },
        ],
        answer: "**Use Memento.** The note editor (Originator) creates a snapshot before each edit and restores itself from it. The undo history (Caretaker) keeps an ordered list of snapshots per note and never reads inside them, so the toolbar, the sync service and the search index can no longer change it; that is what caused the wrong-day restores.\n\nAssumption: the case gives no limit, so I keep 50 snapshots per note. Trade-off: memory against how far Undo can go back.",
        explanation: "An excellent answer names Memento, maps all three roles onto Quillpad, links the design to the shared global history and the wrong-day restores, and states an assumption about how much history to keep.",
        hint: "Look at who reads and changes the undo history today.",
        misconception: "Recommending a bigger undo list without fixing who may change it." },
      { key: "case-export", marks: 4, topic: "Bridge", objective: "Case: structure Quillpad's exports with Bridge",
        prompt: "Question 2 (4 marks): Quillpad wants several export formats now and more later. Which pattern would you use to structure exporting, and why not one subclass per note type and format?",
        quote: "export notes to PDF, HTML and an e-reader format",
        criteria: [
          { id: "c1", label: "Recommendation using Bridge", marks: 2, descriptor: "Recommends Bridge: note types are the abstraction and export backends the implementation.",
            keyPoints: ["Note types delegate drawing to an exporter interface"] },
          { id: "c2", label: "Justification with alternatives", marks: 2, descriptor: "Explains why one subclass per combination fails in this case.",
            keyPoints: ["Subclasses multiply: note types times formats", "More targets next year means adding one backend only"] },
        ],
        answer: "**Use Bridge.** Each note type holds a reference to an exporter and delegates the output to it; PDF, HTML and e-reader exporters implement one interface. One subclass per note type and format would multiply the classes, and every new target next year would add a class per note type; with Bridge it adds one exporter.",
        explanation: "An excellent answer separates note types from export backends, explains the cross product of subclasses, and ties the choice to the export targets planned for next year.",
        hint: "Count the classes if every note type had its own subclass per format.",
        misconception: "Choosing Adapter because the formats differ." },
    ],
    attempt: {
      answers: [
        ["case-undo", "I would use the Memento pattern. The editor creates a snapshot before every change and restores it on Undo.\nThe history list keeps the snapshots in order for each note.\nI would also move the whole app to microservices."],
        ["case-export", "I would use Bridge so that note types and export formats can change separately.\nWith subclasses we would need one class for every pair."],
      ],
      summary: "Right patterns; the roles and the facts of the case need to carry more of the argument.",
      grading: [
        { key: "case-undo", summary: "The right pattern, but its roles and the facts of the case stay thin.", criteria: [
          { id: "c1", score: 2.5, evidence: ["I would use the Memento pattern."], covered: ["c1.k1"], missing: [],
            suggestion: "Name the roles: the editor is the Originator, and the history is a Caretaker that never reads a snapshot." },
          { id: "c2", score: 0.5, evidence: [], covered: [], missing: ["c2.k1"],
            suggestion: "Say why: today the toolbar, sync and search all change the shared history; Memento keeps snapshots opaque to them." },
          { id: "c3", score: 0, evidence: [], covered: [], missing: [], suggestion: "Add: the case gives no limit, so I assume 50 snapshots per note." },
        ], unanchored: [{ quote: "I would also move the whole app to microservices.",
          cue: "The team of four developers knows the editor well but has never maintained a plug-in system" }],
          assumptions: [{ gap: "how many snapshots each note may keep", stated: false,
            suggestion: "Write: the case does not say how much history to keep, so I assume 50 snapshots per note; therefore memory stays small." }] },
        { key: "case-export", summary: "A clear choice with a reason; tie it to next year's export targets.", criteria: [
          { id: "c1", score: 2, evidence: ["I would use Bridge so that note types and export formats can change separately."], covered: ["c1.k1"], missing: [], suggestion: "" },
          { id: "c2", score: 1, evidence: ["With subclasses we would need one class for every pair."], covered: ["c2.k1"], missing: ["c2.k2"],
            suggestion: "Tie it to the case: more export targets next year means adding one exporter, not a class per note type." },
        ] },
      ],
    },
  },
  inbox: [
    { key: "help", kind: "followup", card: "memento-owner", detail: "Sample explanation: snapshot versus history manager", minutesAgo: 20, read: false },
    { key: "note", kind: "note", card: "memento-owner", note: "memento", detail: "Sample learning notes are ready to edit", minutesAgo: 35, read: false },
    { key: "link", kind: "link", card: "bridge-render", detail: "Linked “independent dimensions” as a prerequisite", minutesAgo: 1440, read: true },
  ],
};
