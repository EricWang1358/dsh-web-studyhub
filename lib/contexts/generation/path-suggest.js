/* generate.path.suggest: a light model names the steps of a 分步出题路径, says what each practises and suggests an order and a count (the plan itself is lib/generation-path.js).

   The model sees the steps' titles and sizes only, never the text. What it is asked and what the learner is told are made here; pure functions, no I/O: the operation in
   operations.js makes the model calls and applies the reply (lib/generation-path.js applyPathRefinement). */
import { MAX_STEPS } from '../../generation-path.js';
import { SUGGEST_GOALS, modelFailed } from './suggest.js';

const clipText = (value, length) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);

/** The steps as the model may see them: the first MAX_STEPS, those with an id, nothing but the id, the title and the sizes. */
export function pathSteps(steps) {
  return steps.slice(0, MAX_STEPS).filter((step) => step && typeof step.id === "string")
    .map((step) => ({ id: clipText(step.id, 40), title: clipText(step.title, 120), pages: Math.max(0, Math.round(Number(step.pages) || 0)), chars: Math.max(0, Math.round(Number(step.chars) || 0)) }));
}

export function buildPathPrompt({ course, goal, steps }, { language } = {}) {
  const target = language === "en" ? "English" : "中文 (Chinese)";
  const system = `You plan how a learner works through a big book chapter by chapter with an AI that writes questions from their own materials. You receive only the steps of the plan (id, title, pages, characters), in book order. Return JSON only: {"steps": [{"id": "an id from the input", "title": "a short clear name, at most 60 characters", "focus": "what the questions of this step should practise, one short sentence, at most 120 characters", "count": integer 6-30 (how many questions this step deserves), "reason": "why it comes here, at most 80 characters"}]} listing EVERY step once, in the order you recommend (keep the book order unless a step clearly depends on a later one). Never add or remove steps, never change which pages a step covers. Write names, focus and reason in ${target}.`;
  const prompt = JSON.stringify({ course: typeof course === "string" ? clipText(course, 120) : undefined, goal: SUGGEST_GOALS.includes(goal) ? goal : undefined, steps });
  return { system, prompt };
}

/** One more try, saying what was wrong: a reply that does not list the steps by their exact ids is the usual slip. */
export function pathRetryPrompt(prompt, steps) {
  return `${prompt}

Your previous reply could not be used: it did not list the steps by their exact ids. Reply with ONLY {"steps":[{"id": ...}]} listing EVERY one of these ids once, in your recommended order: ${steps.map((step) => step.id).join(", ")}.`;
}

/** The answer that leaves the plan as it was: it says why, and never throws for a model problem. */
export const pathUnavailable = (reason) => ({ source: "local", steps: [], unavailable: { reason } });
export const pathFailed = (error) => ({ source: "local", steps: [], unavailable: modelFailed(error) });

/** The answer once the model has replied: its refinement, or what the reply looked like when nothing in it could be used. */
export function pathAnswer(refined, reply) {
  return refined.source === "model" ? { source: "model", steps: refined.steps }
    : { source: "local", steps: [], unavailable: { reason: "nothing-usable", sample: JSON.stringify(reply ?? null).slice(0, 200) } };
}
