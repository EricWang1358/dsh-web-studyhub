const text = { type: 'string' }, boolean = { type: 'boolean' };
const object = properties => ({ type: 'object', additionalProperties: true, properties });
const identity = { id: text, documentId: text, sourceId: text, revision: text };
const selection = object({ documentId: text, sourceId: text, revision: text, quote: text, prefix: text, suffix: text, start: { type: 'integer' }, end: { type: 'integer' }, page: { type: 'integer' } });
const style = { type: 'string', enum: ['underline', 'bold', 'highlight', 'queue'] };
const result = object({});

/** Contracts of the learner's own marks on a material (materials.marks.*), added to the materials operations by the runtime like the annotations'. */
export const markSchemas = {
  'materials.marks.list': { input: object(identity), output: result,
    description: 'The marks kept for a document revision, in reading order: each with its style (underline, bold, highlight, or queue: a passage waiting for one later question run), the passage (source, offsets, quote) and whether it is still where it was; queued counts the waiting passages, stale counts what other revisions kept, limits says how many fit.' },
  'materials.marks.save': { input: object({ ...identity, selection, style }), output: result,
    description: 'Mark a passage in one style. selection is the passage as the reader captured it or materials.selection.resolve returned it (stale, ambiguous or missing passages are refused with that status and nothing kept). The same passage and style again is unchanged; a full revision or a full queue is refused with a plain message.' },
  'materials.marks.delete': { input: object({ ...identity, ids: { type: 'array', items: text }, key: text, selection, style, stale: boolean, all: boolean }), output: result,
    description: 'Remove marks of a document revision: by id, the marks of a passage (key or selection, optionally only one style), every mark of one style (style alone; style queue empties the waiting list), all of them, or (stale:true) what older revisions kept.' },
  'materials.marks.seen': { input: object({ ...identity, id: text }), output: result,
    description: 'Record that the learner re-read one mark (rereadAt on the mark). Call it only when the learner says they re-read it, never just for opening the passage. status missing when the current revision keeps no such mark.' },
  'materials.marks.reread': { input: object({ course: text, now: { type: 'number' }, todayStart: { type: 'number' } }), output: result,
    description: 'Highlighter and bold marks worth re-reading today: marks of the current revision still in place, not made or re-read for 3 days, in a section with due or weak questions, the riskiest first, at most 3 a day (fewer after some were re-read today). items carry the passage (selection), page, title, style and the section risk; total counts every candidate.' },
};
