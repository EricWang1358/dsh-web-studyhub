import { BUILD_DESCRIPTION } from './jobs/messages.js';
import { OUTLINE_GRANULARITIES, OUTLINE_LIMITS } from '../../../course-outline-book.js';

const nullable = (schema, description) => ({ oneOf: [schema, { type: 'null' }], description });

const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the course outline build (generation.courseOutline.*). */
export const courseOutlineJobSchemas = {
  'courseOutline.build': { description: BUILD_DESCRIPTION,
    input: object({ course: text, supersedes: text, language: { type: 'string', enum: ['zh', 'en'] }, papers: { type: 'array', items: text }, papersOnly: { type: 'boolean' },
      // Typed loosely on purpose: a value out of range gets the build's own refusal naming the field (course-outline-shape-invalid); null removes the kept one.
      granularity: nullable(text, `${OUTLINE_GRANULARITIES.join(' | ')} (fine only changes the inventory grouping, not the quick outline); null removes the kept one`),
      maxPoints: nullable({ type: 'number' }, `a whole number from 1 to ${OUTLINE_LIMITS.nodes}; null removes the one the outline keeps`),
      confirm: { type: 'boolean' } }),
    output: object({ jobId: text, status: text, steps: { type: 'integer' }, alreadyRunning: { type: 'boolean' } }) },
};
