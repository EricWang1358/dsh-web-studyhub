import { BUILD_DESCRIPTION } from './jobs/messages.js';
import { OUTLINE_GRANULARITIES, OUTLINE_LIMITS } from '../../../course-outline-book.js';

const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the course outline build (generation.courseOutline.*). */
export const courseOutlineJobSchemas = {
  'courseOutline.build': { description: BUILD_DESCRIPTION,
    input: object({ course: text, supersedes: text, language: { type: 'string', enum: ['zh', 'en'] }, papers: { type: 'array', items: text }, papersOnly: { type: 'boolean' },
      granularity: { type: 'string', enum: [...OUTLINE_GRANULARITIES] }, maxPoints: { type: 'integer', minimum: 1, maximum: OUTLINE_LIMITS.nodes },
      confirm: { type: 'boolean' } }),
    output: object({ jobId: text, status: text, steps: { type: 'integer' }, alreadyRunning: { type: 'boolean' } }) },
};
