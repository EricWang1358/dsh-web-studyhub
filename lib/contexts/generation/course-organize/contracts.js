const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

export const ORGANIZE_MODES = Object.freeze(['all', 'prereqs', 'terms']);

export const courseOrganizeJobSchemas = {
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
