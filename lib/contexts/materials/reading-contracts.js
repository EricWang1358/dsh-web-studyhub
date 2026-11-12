const text = { type: 'string' }, integer = { type: 'integer' };
const object = properties => ({ type: 'object', additionalProperties: true, properties });
const identity = { id: text, documentId: text, sourceId: text, revision: text };
const chapter = object({ id: text, title: text, startPage: integer, endPage: integer });
const chapters = { type: 'array', items: chapter };
const result = object({});

/** Contracts of 已读 (materials.reading.*), added to the materials operations by the runtime like the marks'. */
export const readingSchemas = {
  'materials.reading.get': { input: object({ ...identity, chapters }), output: result,
    description: 'The chapters of a document revision the learner has read: read lists their ids. chapters (id, title, startPage, endPage, as the reader shows them) narrows it to the chapters that still match; a revision with nothing kept reads what an older revision kept.' },
  'materials.reading.save': { input: object({ ...identity, chapters, read: chapters, unread: chapters }), output: result,
    description: 'Mark chapters of a document revision read (read) or unread (unread), each as the reader shows it (id, title, startPage, endPage). Writes only this revision\'s record; its first save keeps what still matches chapters from the record it starts from. Saving the same thing again changes nothing.' },
};
