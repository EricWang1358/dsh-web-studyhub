const text = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the exam-blueprint build (generation.blueprint.*). */
export const blueprintJobSchemas = {
  'blueprint.build': { description: 'Build an exam point list (考点清单, the result of 备考补习) from sample papers and lecture slides, as one background job. Bottom-up: each chosen sample paper is read for the exam points its questions test (two levels, 大考点 and 小考点), '
    + 'the points of several papers are united, then the slides are read in windows for where each point is taught and for what the papers did not reach. A point a sample paper reached is 必学 (must); a point only the slides teach is 补充 (extra); with no sample paper every point is 补充. '
    + 'Inputs name a role (lecture, syllabus, past-paper, textbook, answer-key) and the materials (documentId or sourceIds); lecture slides or a syllabus are required, any number of past-paper inputs is allowed, a textbook is never a source of points, an exam point list is not a valid input. '
    + 'Refusals carry a code (blueprint-disabled, blueprint-needs-primary-input, blueprint-input-missing, blueprint-input-invalid, blueprint-no-readable-text, blueprint-title-required) and cost nothing. '
    + 'estimate:true prices the build without starting it. The list is one material saved at the end; a stop or a failure saves nothing.',
    input: object({ title: text, course: text, scope: object({ label: text }), language: { type: 'string', enum: ['zh', 'en'] }, estimate: boolean,
      recommendedReading: object({ title: text, author: text, url: text, note: text }),
      inputs: { type: 'array', items: object({ role: { type: 'string', enum: ['lecture', 'syllabus', 'past-paper', 'textbook', 'answer-key'] }, documentId: text, sourceIds: { type: 'array', items: text }, title: text }) } }),
    output: object({ jobId: text, status: text, steps: integer, alreadyRunning: boolean, estimate: object({}) }) },
};
