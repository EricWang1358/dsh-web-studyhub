import { BUILD_DESCRIPTION } from './jobs/messages.js';

const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the course outline build (generation.courseOutline.*). */
export const courseOutlineJobSchemas = {
  'courseOutline.build': { description: BUILD_DESCRIPTION,
    input: object({ course: text, supersedes: text, language: { type: 'string', enum: ['zh', 'en'] }, papers: { type: 'array', items: text } }),
    output: object({ jobId: text, status: text, steps: { type: 'integer' }, alreadyRunning: { type: 'boolean' } }) },
};
