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
  'selection.saveAnswer': { description: 'Save a grounded answer as one flashcard linked to its passage: the quoted passage and the question on the front, the answer as shown on the back. Never calls the model.',
    input: { type: 'object', additionalProperties: true, properties: { ...identity, selection, question: string, answer: string, deckId: string }, required: ['selection', 'question', 'answer', 'operationId'] },
    output: { type: 'object', additionalProperties: true, properties: { status: string, deckId: string, cardId: string, receipt: { type: 'object', additionalProperties: true }, error: string } } },
  'selection.get': { description: 'Read persisted candidates, independent review decisions and append receipt.',
    input: { type: 'object', additionalProperties: false, properties: { operationId: string }, required: ['operationId'] }, output: result },
  'selection.commit': { description: 'Retry publication of previously reviewed candidates against an explicit current deck version.',
    input: { type: 'object', additionalProperties: false, properties: identity, required: ['operationId'] }, output: result },
  'selection.review': { description: 'Independently review persisted authored candidates again after a model failure.',
    input: { type: 'object', additionalProperties: false, properties: identity, required: ['operationId'] }, output: result },
};
