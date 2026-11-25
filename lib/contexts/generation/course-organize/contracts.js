const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

export const ORGANIZE_MODES = Object.freeze(['all', 'prereqs', 'terms']);

export const courseOrganizeJobSchemas = {
  'course.organize.undo': {
    description: 'Remove the prerequisite links that the batch organize job made for a course (links it marked with origin "course-organize"). Hand-made links and cached card terms are kept. Offline; never calls the model.',
    input: object({
      course: text,
      language: { type: 'string', enum: ['zh', 'en'] },
    }),
    output: object({
      course: text,
      removed: { type: 'integer' },
    }),
  },
  'course.organize.start': {
    description: 'Start a cancellable course-level background job that deterministically links acyclic prerequisites (offline, max 12/card) and batch pre-extracts card.terms when a model is available. Pass dryRun:true to preview counts without writing.',
    input: object({
      course: text,
      mode: { type: 'string', enum: [...ORGANIZE_MODES] },
      language: { type: 'string', enum: ['zh', 'en'] },
      dryRun: { type: 'boolean', description: 'Preview candidate prerequisite links and uncached term cards without writing or starting a job.' },
    }),
    output: object({
      jobId: text,
      status: text,
      course: text,
      alreadyRunning: { type: 'boolean' },
      hasModel: { type: 'boolean' },
      preview: object({}),
    }),
  },
};
