import { BUILD_DESCRIPTION } from './jobs/messages.js';
import { OUTLINE_GRANULARITIES, OUTLINE_LIMITS } from '../../../course-outline-book.js';
import { DEFAULT_MIN_BODY_CHARS, OUTLINE_BUILD_OPTIONS } from './plan.js';

const nullable = (schema, description) => ({ oneOf: [schema, { type: 'null' }], description });

const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** The schema of each option of a build request. OUTLINE_BUILD_OPTIONS (plan.js) names the options the build reads, and the input below is made of exactly
    those, so a parameter the handler accepts is also one `study_capabilities` shows (#462; before, the plan read options no contract declared). */
const BUILD_INPUT = {
  course: text,
  supersedes: text,
  language: { type: 'string', enum: ['zh', 'en'] },
  papers: { type: 'array', items: text },
  // The build's own options, declared so nothing it reads stays invisible: the review book's plan sets papersBy and inventory for its outline.
  papersBy: { type: 'string', enum: ['auto', 'learner'], description: 'who chose the sample papers: the learner, or their recognition by name' },
  papersOnly: { type: 'boolean' },
  inventory: { type: 'boolean' },
  concurrency: { type: 'integer' },
  // Typed loosely on purpose: a value out of range gets the build's own refusal naming the field (course-outline-shape-invalid); null removes the kept one.
  granularity: nullable(text, `${OUTLINE_GRANULARITIES.join(' | ')} (fine only changes the inventory grouping, not the quick outline); null removes the kept one`),
  maxPoints: nullable({ type: 'number' }, `a whole number from 1 to ${OUTLINE_LIMITS.nodes}; null removes the one the outline keeps`),
  minBodyChars: { type: 'number', description: `the characters under which a knowledge point's own text is reported in the result (bodyWarnings), never changed; `
    + `0 turns the report off; ${DEFAULT_MIN_BODY_CHARS} unless asked, 0 to ${OUTLINE_LIMITS.introChars}` },
  confirm: { type: 'boolean' },
  estimate: { type: 'boolean', description: 'answer the points, nodes and characters of text a build would make, without a model call, a task or a write' },
};

/** Contract of the course outline build (generation.courseOutline.*). */
export const courseOutlineJobSchemas = {
  'courseOutline.build': { description: BUILD_DESCRIPTION,
    input: object(Object.fromEntries(OUTLINE_BUILD_OPTIONS.map(key => [key, BUILD_INPUT[key]]))),
    output: object({ jobId: text, status: text, steps: { type: 'integer' }, alreadyRunning: { type: 'boolean' }, estimate: object({}) }) },
};
