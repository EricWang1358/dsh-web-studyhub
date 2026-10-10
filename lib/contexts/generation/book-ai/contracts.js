import { AI_DESCRIPTION } from './jobs/messages.js';

const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the 复习全书's 弄懂 / 加一段 task (generation.courseBook.explain). */
export const courseBookAiJobSchemas = {
  'courseBook.explain': { description: AI_DESCRIPTION,
    input: object({ course: text, heading: text, words: text, instruction: text, mode: { type: 'string', enum: ['explain', 'write', 'here', 'follow'] }, after: text, replace: text,
      language: { type: 'string', enum: ['zh', 'en'] } }),
    output: object({ jobId: text, status: text, blockId: text }) },
};
