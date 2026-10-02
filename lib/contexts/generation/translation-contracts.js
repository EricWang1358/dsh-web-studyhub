const text = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });
const job = object({});

/** Contracts of the 翻译本页 / 翻译本章 background job (generation.translation.*). */
export const translationJobSchemas = {
  'translation.start': { description: 'Translate the paragraphs of some sources (scope.sourceIds: a page, a chapter) or explicit passages as one background job and return its handle at once; progress (done/total paragraphs), stop and the result are the job\'s. Paragraphs that already have a translation are skipped. estimate:true prices the run without starting it. The same page is never started twice.',
    input: object({ documentId: text, sourceId: text, revision: text, target: { type: 'string', enum: ['zh', 'en'] }, scope: object({ sourceIds: { type: 'array', items: text } }),
      passages: { type: 'array', items: object({}) }, concurrency: integer, label: text, estimate: boolean, retranslate: boolean, comment: text }),
    output: object({ jobId: { oneOf: [text, { type: 'null' }] }, status: text, queuedBehind: integer, alreadyRunning: boolean, job: { oneOf: [job, { type: 'null' }] } }) },
  'translation.status': { description: 'One translation job: live while it runs.',
    input: object({ jobId: text }, { additionalProperties: false, required: ['jobId'] }), output: object({ job }) },
  'translation.jobs': { description: 'The translation jobs of one material (or of the library), oldest first.',
    input: object({ documentId: text, sourceId: text }, { additionalProperties: false }), output: object({ jobs: { type: 'array', items: job } }) },
};
