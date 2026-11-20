/* How the one-pass write call asks for its cards: the one place the wording of WHAT a card tests and HOW it asks lives, by style key, so presets can be added
   here later without touching the prompt's layout (lib/one-pass/prompts.js).
     scenario  the default (owner, 2026-11-21; prototype 6, plan §11–§12): what is worth testing, a short scenario whose decisive condition changes the answer,
               and an explanation in four moves.
     quick     the plainer round-3 wording: a small concrete situation where the point allows it. */

const SCENARIO = 'WHAT TO TEST. Choose the ideas a serious student must be able to use: a rule together with its condition, its exception or its boundary; a distinction between two things that are easy to confuse; a cause and what follows from it; a procedure and the order that matters. An isolated detail (a name, a label, a single number) is worth a card only when a learner needs it to act; if what is left of a section is only such details, write fewer cards than the quota. HOW TO ASK. Each card tests understanding, not one sentence. Build a short concrete scenario (60 to 160 characters of stem) that states two or three decisive facts, where at least one fact is the condition or exception that changes the answer, so that a learner who knows the rule but misses the condition picks a wrong option. Where the section gives two neighbouring cases, put both in the scenario and ask how each is handled. Never ask for a definition back, never ask what a document says. EXPLANATION. Four moves in a few sentences: the conclusion; the decisive facts in THIS stem and the rule they trigger; why the most tempting wrong option fails and when it would be right; one reusable rule of thumb.';
const QUICK = 'Where the point allows it, put the learner in a small concrete situation and ask what happens or what to do, instead of asking for the definition back.';

export const WRITE_STYLES = Object.freeze({ scenario: SCENARIO, quick: QUICK });
export const DEFAULT_WRITE_STYLE = 'scenario';

/** The wording of `style` (an unknown style is the default). */
export const writeStyleText = style => WRITE_STYLES[style] ?? WRITE_STYLES[DEFAULT_WRITE_STYLE];
