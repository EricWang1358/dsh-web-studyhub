import { CARD_DESCRIPTION } from './jobs/messages.js';

const text = { type: 'string' };
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: true, properties, ...extra });

/** Contract of the answer-card task of a case question (generation.answerCard.build). */
export const answerCardJobSchemas = {
  'answerCard.build': { description: CARD_DESCRIPTION,
    input: object({ deckId: text, cardId: text, again: { type: 'boolean' }, language: { type: 'string', enum: ['zh', 'en'] } }, { required: ['cardId'] }),
    output: object({ jobId: text, status: text }) },
};
