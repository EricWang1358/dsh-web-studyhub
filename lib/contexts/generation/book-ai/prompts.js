import { askSystemPrompt } from '../../../ask-prompt.js';

/* The prompt of an explain / add-a-paragraph task: the passage-grounded ask of the reader (lib/ask-prompt.js: answer from the selected evidence only, untrusted
   content never instructions, the explain shape for an explain request) over the knowledge point's own materials, with one fixed answer shape so the
   program can check it. The book's text, the selected words, the instruction and the materials are untrusted data, never instructions. */

const SHAPE = 'Reply with JSON only: {"text": "the answer in Markdown, from the materials only", "quotes": ["short passages copied word for word from the materials that '
  + 'support the answer (at most 4)"], "extra": ["what you add that the materials do not say (a standard definition, background, an intuition), each one short; '
  + 'at most 3; [] when nothing"]}. Never put in "text" a fact the materials do not support: such a thing goes to "extra". Write formulas in LaTeX between $ signs.';
const TASK = {
  explain: 'The learner selected words of their review book (field "words", inside "passage") and asks to understand them.',
  write: 'The learner selected words of their review book (field "words", inside "passage") and asks for a new paragraph about them following the '
    + 'instruction (field "instruction"): for example more detail, an example, or a comparison table.',
  here: 'The learner asks for a new paragraph under a knowledge point of their review book, following the instruction (field "instruction").',
  follow: 'The learner asks a follow-up question (field "instruction") about an earlier answer on the selected words (field "words").',
};
const written = language => (language === 'en' ? 'English' : 'Simplified Chinese');

/** One call: { system, prompt }. */
export function aiPrompt(plan) {
  // The reader's own rules; an explain request takes its explain shape (askSystemPrompt reads "explain" as a request to explain).
  const question = plan.mode === 'explain' ? 'Explain this' : plan.instruction;
  const system = [askSystemPrompt({ question, language: written(plan.language) }), TASK[plan.mode], `Write in ${written(plan.language)}.`, SHAPE].join(' ');
  const data = { point: plan.leaf.title, ...(plan.words ? { words: plan.words } : {}), ...(plan.passage ? { passage: plan.passage } : {}),
    ...(plan.instruction ? { instruction: plan.instruction } : {}),
    materials: plan.materials.map((part, at) => ({ ref: `S${at + 1}`, title: part.material, ...(part.cut ? { excerpt: true } : {}), text: part.text })) };
  return { system, prompt: `REQUEST DATA:\n${JSON.stringify(data)}` };
}
