import { BUILD_DESCRIPTION } from './jobs/messages.js';

const text = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the exam-blueprint build (generation.blueprint.*). */
export const blueprintJobSchemas = {
  'blueprint.build': { description: BUILD_DESCRIPTION,
    input: object({ title: text, supersedes: text, course: text, scope: object({ label: text }), language: { type: 'string', enum: ['zh', 'en'] }, estimate: boolean,
      recommendedReading: object({ title: text, author: text, url: text, note: text }),
      inputs: { type: 'array', items: object({ role: { type: 'string', enum: ['lecture', 'syllabus', 'past-paper', 'textbook', 'answer-key'] },
        documentId: text, sourceIds: { type: 'array', items: text }, title: text }) } }),
    output: object({ jobId: text, status: text, steps: integer, alreadyRunning: boolean, estimate: object({}) }) },
};
