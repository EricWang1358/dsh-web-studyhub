const text = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the exam-blueprint build (generation.blueprint.*). */
export const blueprintJobSchemas = {
  'blueprint.build': { description: 'Build an exam blueprint (a list of exam points with their places in the materials) from lecture slides, optionally a syllabus and ONE sample paper, as one background job. '
    + 'Inputs name a role (lecture, syllabus, past-paper, textbook, answer-key) and the materials (documentId or sourceIds); lecture slides or a syllabus are required, a textbook is never a source of points. '
    + 'Refusals carry a code (blueprint-disabled, blueprint-needs-primary-input, blueprint-input-missing, blueprint-no-readable-text, blueprint-title-required) and cost nothing. '
    + 'estimate:true prices the build without starting it. The blueprint is one material saved at the end; a stop or a failure saves nothing.',
    input: object({ title: text, course: text, scope: object({ label: text }), language: { type: 'string', enum: ['zh', 'en'] }, estimate: boolean,
      recommendedReading: object({ title: text, author: text, url: text, note: text }),
      inputs: { type: 'array', items: object({ role: { type: 'string', enum: ['lecture', 'syllabus', 'past-paper', 'textbook', 'answer-key'] }, documentId: text, sourceIds: { type: 'array', items: text }, title: text }) } }),
    output: object({ jobId: text, status: text, steps: integer, alreadyRunning: boolean, estimate: object({}) }) },
};
