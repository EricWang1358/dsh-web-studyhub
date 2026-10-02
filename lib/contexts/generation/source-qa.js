import { createHash } from 'node:crypto';

/* A grounded answer ("依据原文回答") saved as one flashcard (owner request, 2.3.2).
   Front: the quoted passage and the learner's question. Back: the answer exactly as it was shown.
   Pure: the same request always builds the same card, so a retry replays the bank receipt instead of
   adding a second card. The card is an ordinary flashcard; `sourceQa` only tags its origin. */

const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const MAX_QUOTE = 1200, MAX_QUESTION = 1000, MAX_ANSWER = 8000;

const words = {
  zh: { deck: '原文问答', topic: '原文问答',
    hint: '回到这段原文，先用自己的话回答，再翻面核对。',
    explanation: '这张卡来自你对原文的一次提问：正面是所选原文和问题，背面是当时依据原文得到的回答。回答由 AI 生成，请以引用的原文为准。',
    misconception: 'AI 的回答可能遗漏原文之外的条件或误读原文；请对照引用的原文核实。' },
  en: { deck: 'Source Q&A', topic: 'Source Q&A',
    hint: 'Go back to the passage and answer in your own words, then flip to check.',
    explanation: 'This card comes from a question you asked about the source: the front is the selected passage and your question, the back is the answer given then. The answer is AI-written; the quoted source is what counts.',
    misconception: 'An AI answer can miss conditions outside the passage or misread it; check it against the quoted source.' },
};
export const sourceQaWords = english => words[english ? 'en' : 'zh'];

/** The quoted front: every passage line is a Markdown block quote line, then the question. */
export function qaPrompt(quote, question) {
  const text = String(quote).trim(), shown = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE).trimEnd()}…` : text;
  return `${shown.split(/\r?\n/).map(line => `> ${line}`.trimEnd()).join('\n')}\n\n${String(question).trim()}`;
}

/** Validated request fields, or an Error naming what is wrong. The answer is kept exactly as given. */
export function checkedQaRequest(args) {
  if (typeof args.operationId !== 'string' || !args.operationId.trim() || args.operationId.length > 200) throw new Error('A stable operationId is required');
  if (!args.selection || typeof args.selection.quote !== 'string' || !args.selection.quote.trim()) throw new Error('A material selection is required');
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question || question.length > MAX_QUESTION) throw new Error(`Question must be 1–${MAX_QUESTION} characters`);
  if (typeof args.answer !== 'string' || !args.answer.trim() || args.answer.length > MAX_ANSWER) throw new Error(`Answer must be 1–${MAX_ANSWER} characters`);
  if (args.deckId !== undefined && (typeof args.deckId !== 'string' || !args.deckId)) throw new Error('Choose an existing destination deck');
  if (args.expectedVersion !== undefined && !Number.isInteger(args.expectedVersion)) throw new Error('expectedVersion must be an integer');
  return { question, answer: args.answer };
}

/** The citation quote the deck check needs: the passage, or its surroundings when it is too short to verify. */
function citationQuote(selection, source) {
  if (squash(selection.quote).length >= 12) return selection.quote;
  const text = source?.text || '';
  return text.slice(Math.max(0, selection.start - 80), Math.min(text.length, selection.end + 80)).trim() || selection.quote;
}

export function buildQaCard({ selection, source, title, question, answer, operationId, english }) {
  const say = sourceQaWords(english), quote = selection.quote;
  return {
    id: `qa-${createHash('sha256').update(operationId).digest('hex').slice(0, 24)}`,
    kind: 'flashcard',
    topic: squash(source?.title || title || say.topic).slice(0, 100) || say.topic,
    objective: `${question} · ${squash(quote).slice(0, 80)}`.slice(0, 300),
    prompt: qaPrompt(quote, question),
    answer,
    hint: say.hint,
    explanation: say.explanation,
    misconception: say.misconception,
    citations: [{ sourceId: selection.sourceId, quote: citationQuote(selection, source) }],
    sourceQa: true,
  };
}

/** The course to file under: the passage's own document, exactly as written (never a parent). */
export function qaCourse(source) {
  const first = Array.isArray(source?.courses) ? source.courses.find(name => typeof name === 'string' && name.trim()) : undefined;
  return (first ?? source?.course ?? '').trim();
}
