export const ARCHETYPES = Object.freeze(['auto', 'sandbox', 'dialectic', 'mechanism', 'empirical']);
export const MOUNT_MODES = Object.freeze(['auto', 'enrich-existing', 'full-pack', 'companion-only']);
export const LESSON_MODES = Object.freeze(['full', 'rescue']);

const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

export const companionJobSchemas = {
  'companion.build': {
    description: 'Build a self-contained, zero-dependency interactive HTML companion lesson across any discipline (mathematics, philosophy, mechanical engineering, computer science, sciences, humanities) using the progressive stage-and-voice template, save it to workspace companions/<course>/ and attach it to the course.',
    input: object({
      course: text,
      topic: text,
      prompt: text,
      mode: { type: 'string', enum: [...LESSON_MODES] },
      cardIds: { type: 'array', items: text },
      deckId: text,
      hid: text,
      errorReason: text,
      thinkingNote: text,
      sourceIds: { type: 'array', items: text },
      archetype: { type: 'string', enum: [...ARCHETYPES] },
      mountMode: { type: 'string', enum: [...MOUNT_MODES] },
      language: { type: 'string', enum: ['zh', 'en'] },
      estimate: { type: 'boolean', description: 'Preview expected slides, calls and token estimate without starting a job or calling a model.' },
    }),
    output: object({
      jobId: text,
      status: text,
      steps: { type: 'integer' },
      alreadyRunning: { type: 'boolean' },
      estimate: object({}),
    }),
  },
};
