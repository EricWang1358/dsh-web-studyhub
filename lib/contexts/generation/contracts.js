const string = { type: 'string' }, integer = { type: 'integer' };
const selection = { type: 'object', additionalProperties: true, properties: {
  documentId: string, sourceId: string, revision: string, quote: string, prefix: string, suffix: string,
  start: integer, end: integer, page: integer,
}, required: ['sourceId', 'revision', 'quote'] };
const identity = { operationId: string, expectedVersion: integer };
const result = { type: 'object', additionalProperties: true, properties: {
  operationId: string, status: string, deckId: string, accepted: { type: 'array', items: { type: 'object', additionalProperties: true } },
  candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
  reviewPassed: { type: 'boolean' }, receipt: { type: 'object', additionalProperties: true }, error: { oneOf: [string, { type: 'null' }] },
} };
export const selectionSchemas = {
  'selection.supplement': { description: 'Generate and independently review selected evidence, then append accepted questions to an existing deck once.',
    input: { type: 'object', additionalProperties: true, properties: { ...identity, selection, deckId: string,
      count: integer, kind: { type: 'string', enum: ['quiz', 'multi', 'open', 'flashcard', 'cloze'] }, focus: string },
    required: ['selection', 'deckId', 'operationId', 'expectedVersion'] }, output: result },
  'selection.start': { description: 'Start the same supplement as a background job and return its job handle at once; progress, stop and the result are the job\'s. The same operationId never starts twice; a stopped or failed one continues from what it saved.',
    input: { type: 'object', additionalProperties: true, properties: { ...identity, selection, deckId: string,
      count: integer, kind: { type: 'string', enum: ['quiz', 'multi', 'open', 'flashcard', 'cloze'] }, focus: string },
    required: ['selection', 'deckId', 'operationId', 'expectedVersion'] },
    output: { type: 'object', additionalProperties: true, properties: { jobId: string, operationId: string, status: string, deckId: string, queuedBehind: integer, job: { type: 'object', additionalProperties: true } } } },
  'selection.status': { description: 'The job of one supplement operation: live while it runs, rebuilt from what the library kept after a restart.',
    input: { type: 'object', additionalProperties: false, properties: { operationId: string }, required: ['operationId'] },
    output: { type: 'object', additionalProperties: true, properties: { job: { type: 'object', additionalProperties: true } } } },
  'selection.jobs': { description: 'The supplement jobs started from one material (or all of them), oldest first.',
    input: { type: 'object', additionalProperties: false, properties: { documentId: string } },
    output: { type: 'object', additionalProperties: true, properties: { jobs: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
  'selection.get': { description: 'Read persisted candidates, independent review decisions and append receipt.',
    input: { type: 'object', additionalProperties: false, properties: { operationId: string }, required: ['operationId'] }, output: result },
  'selection.commit': { description: 'Retry publication of previously reviewed candidates against an explicit current deck version.',
    input: { type: 'object', additionalProperties: false, properties: identity, required: ['operationId'] }, output: result },
  'selection.review': { description: 'Independently review persisted authored candidates again after a model failure.',
    input: { type: 'object', additionalProperties: false, properties: identity, required: ['operationId'] }, output: result },
};
