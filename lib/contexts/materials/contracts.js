const text = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
const object = properties => ({ type: 'object', additionalProperties: true, properties });
const identity = { id: text, documentId: text, sourceId: text, revision: text };
const selection = object({ documentId: text, sourceId: text, revision: text, quote: text, prefix: text, suffix: text, start: integer, end: integer, page: integer });
const file = { path: text, dataBase64: text, filename: text, format: { type: 'string', enum: ['pdf', 'docx', 'pptx', 'md', 'markdown', 'html', 'txt', 'json'] },
  title: text, pages: { type: 'array', items: integer }, course: text, courses: { type: 'array', items: text }, documentId: text };
const result = object({});
const fileInput = properties => ({ oneOf: [{ ...object(properties), required: ['path'] }, { ...object(properties), required: ['dataBase64'] }] });

/** Additive v1 contracts shared by structured tools and UI operation discovery. */
export const materialsSchemas = {
  'materials.document.import': { input: fileInput(file),
    output: result, description: 'Retain an original PDF, Word (.docx), PowerPoint (.pptx), Markdown, HTML or TXT and create versioned, selectable text projections.' },
  'materials.document.get': { input: object({ ...identity, path: text, refresh: boolean }), output: result,
    description: 'Read an original preview descriptor, exact document revision and retained text. Explicit refresh reads a previously imported external file.' },
  'materials.document.bytes': { input: object(identity), output: result,
    description: 'Read verified retained original bytes for a document revision; unavailable originals return an explicit capability state.' },
  'materials.document.list': { input: object({ query: text, course: text, includeArchived: boolean, offset: integer, limit: integer }), output: result,
    description: 'List active material documents including readable legacy extracted-only sources; includeArchived:true also returns archived documents.' },
  'materials.document.attach': { input: fileInput({ ...file, ...identity }),
    output: result, description: 'Attach an original or revised file while preserving historical source IDs and citation text.' },
  'materials.original.status': { input: object(identity), output: result,
    description: "Where a document revision's original stands: a copy in the library, a reference to the learner's own file, or none; for a reference, whether the file is still there and unchanged." },
  'materials.original.probe': { input: object({ ...identity, path: text, dataBase64: text, filename: text, format: { type: 'string', enum: ['pdf', 'docx', 'pptx', 'md', 'markdown', 'html', 'txt'] } }), output: result,
    description: 'Check, without a model and without writing anything, whether a file is the document the stored text came from: page count, per-page text similarity (whitespace folded like citations), size and hash.' },
  'materials.original.attach': { input: object({ ...identity, mode: { type: 'string', enum: ['reference', 'copy'] }, path: text, dataBase64: text, filename: text, confirm: boolean,
    format: { type: 'string', enum: ['pdf', 'docx', 'pptx', 'md', 'markdown', 'html', 'txt'] } }), output: result,
    description: 'Attach the original file to an existing document without changing its text, revision, citations, selections or card links. mode "reference" remembers the path (size, date, hash); "copy" keeps a copy in the library. A file that does not match the stored text is attached only with confirm: true. Idempotent.' },
  'materials.original.detach': { input: object(identity), output: result,
    description: "Forget the attached original (a reference or a copy) of a document revision. The text and the learner's file are left alone." },
  'materials.document.rename': { input: object({ ...identity, title: text, expectedTitle: text, restore: boolean, undo: boolean }), output: result,
    description: 'Change only the title of a document (not its file name): text, ids, revisions, selections, citations and card links are never touched. Pages and parts whose title was derived from the document title follow it; titles that came from the content do not. title is trimmed, whitespace collapsed, 1-200 characters, no control characters, not only dots. expectedTitle guards against a concurrent rename; revision must be the current one; restore:true goes back to the original name, undo:true to the previous one (a short history of ten is kept). Idempotent: the same name writes nothing.' },
  'materials.selection.resolve': { input: object({ ...selection.properties, selection, revalidate: boolean }), output: result,
    description: 'Resolve visible text to a checked revision and exact source offsets. Duplicate, stale and missing positions remain explicit.' },
  'materials.selection.ask': { input: { ...object({ selection, question: text, language: text, term: text, terms: boolean,
    thread: { type: 'array', maxItems: 3, items: object({ question: text, answer: text }) } }), required: ['selection', 'question'] }, output: result,
    description: 'Answer a question using a validated selected passage and nearby evidence with the request model. An explanation request ("没听懂", "explain") is answered in a fixed shape: what the passage is about, then its points in source order (the source says / in plain words). Optional, for a question asked inside an earlier answer: term (a term of that answer, explained from the passage first and, if the source does not explain it, from general knowledge that is labelled as such) and thread (the earlier { question, answer } pairs this continues, oldest first, at most 3, each side clipped to 1500 characters; context only). terms:true asks the model to mark at most 6 key terms as [[term]] for a reader that makes them clickable. Without them the call behaves as before.' },
  'materials.outline.suggest': { input: object({ ...identity, estimate: boolean, language: text, mode: { type: 'string', enum: ['outline', 'chapters'] } }), output: result,
    description: 'Ask the request model, in ONE call, for a better table of contents of a document revision (any format; a recording of several files is one document) from its numbered text blocks. mode "chapters" asks for chapter boundaries only (cheaper). estimate:true prices the call without making it. The answer is checked in code (short grounded titles, levels 1-3, real increasing positions) and is only proposed; save it with materials.outline.save.' },
  'materials.outline.save': { input: { ...object({ ...identity, mode: { type: 'string', enum: ['outline', 'chapters'] }, segmentLevel: integer,
    entries: { type: 'array', items: object({ title: text, level: integer, startBlock: integer }) }, usage: object({}) }), required: ['entries'] }, output: result,
    description: 'Keep a checked outline on one document revision as a reading override; segmentLevel (1-3) also applies it as the document\'s chapters. It never changes the stored text, citations, selections or card links and is not applied to another revision.' },
  'materials.outline.segment': { input: object({ ...identity, preview: boolean, level: { oneOf: [integer, { type: 'null' }] } }), output: result,
    description: 'Use the kept outline of a document revision as its chapters, as a view over the same text (no page or character is rewritten; source ids, page numbers, citations and card links keep working). preview:true (or no level) lists the chapters each level would give with page ranges; level 1-3 applies one (idempotent, reports how many chapters changed); level null restores the automatic chapters and keeps the outline.' },
  'materials.outline.clear': { input: object(identity), output: result,
    description: 'Remove the kept outline of a document revision (and the chapters it defined); the reader and the 资料 page return to the automatic table of contents and chapters.' },
  'materials.links.list': { input: object({ documentId: text, sourceId: text, cardId: text, selection }), output: result,
    description: 'Read durable passage links and current question explanations from authoritative existing question JSON.' },
  'materials.pages.cards': { input: object({ documentId: text, sourceId: text, sourceIds: { type: 'array', items: text }, chapter: integer }), output: result,
    description: "The questions that point into a document (or into some of its pages), each with its review state (new, weak, learning, familiar, mastered; due; whether its course is parked) and where it points, plus the document's mastery summary. chapter (a chapter index of the 资料 row) narrows it to that chapter's questions. Derived from the cards' own SM-2 state: read-only, no model. Practise them with review.start {mode:path, scope:[{deckId,cardId}]}."},
  'materials.enrich': { input: object({ sourceIds: { type: 'array', items: text } }), output: result,
    description: 'Fill missing deterministic material metadata, preserve authored values and report unresolved original/time facts.' },
};
