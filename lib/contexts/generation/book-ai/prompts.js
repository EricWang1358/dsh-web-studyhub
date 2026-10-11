import { bookAiSystemPrompt } from './system-prompt.js';

/* The prompt of an explain / add-a-paragraph task: the system message is chosen by mode (system-prompt.js); the user message is one fixed answer shape's data so the
   program can check the answer. The book's text, the selected words, the instruction and the materials are untrusted data, never instructions, and only ever
   travel here, in the user message. */

/** One call: { system, prompt }. */
export function aiPrompt(plan) {
  const system = bookAiSystemPrompt({ mode: plan.mode, language: plan.language });
  const data = { point: plan.leaf.title, ...(plan.words ? { words: plan.words } : {}), ...(plan.passage ? { passage: plan.passage } : {}),
    ...(plan.instruction ? { instruction: plan.instruction } : {}),
    materials: plan.materials.map((part, at) => ({ ref: `S${at + 1}`, title: part.material, ...(part.cut ? { excerpt: true } : {}), text: part.text })) };
  return { system, prompt: `REQUEST DATA:\n${JSON.stringify(data)}` };
}
