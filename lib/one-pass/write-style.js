/* How the one-pass write call asks for its cards: the one place the wording of WHAT a card tests and HOW it asks lives, by style key, so presets can be added
   here later without touching the prompt's layout (lib/one-pass/prompts.js).
     scenario  the default (owner, 2026-11-21; prototype 6, plan §11–§12): what is worth testing, a short scenario whose decisive condition changes the answer,
               and an explanation in four moves.
     quick     the plainer round-3 wording: a small concrete situation where the point allows it. */

const SCENARIO = 'WHAT TO TEST. Choose the ideas a serious student must be able to use: a rule together with its condition, its exception or its boundary; a distinction between two things that are easy to confuse; a cause and what follows from it; a procedure and the order that matters. An isolated detail (a name, a label, a single number) is worth a card only when a learner needs it to act; if what is left of a section is only such details, write fewer cards than the quota. HOW TO ASK. Each card tests understanding, not one sentence. Build a short concrete scenario (60 to 160 characters of stem) that states two or three decisive facts, where at least one fact is the condition or exception that changes the answer, so that a learner who knows the rule but misses the condition picks a wrong option. Where the section gives two neighbouring cases, put both in the scenario and ask how each is handled. Never ask for a definition back, never ask what a document says. EXPLANATION. Four moves in a few sentences: the conclusion; the decisive facts in THIS stem and the rule they trigger; why the most tempting wrong option fails and when it would be right; one reusable rule of thumb.';
const QUICK = 'Where the point allows it, put the learner in a small concrete situation and ask what happens or what to do, instead of asking for the definition back.';

import { DEFAULT_WRITE_STYLE } from './write-style-names.js';

export { DEFAULT_WRITE_STYLE };
/** The wording of each style, keyed by the names of lib/one-pass/write-style-names.js. */
export const WRITE_STYLES = Object.freeze({ scenario: SCENARIO, quick: QUICK });

/** The wording of `style` (an unknown style is the default). */
export const writeStyleText = style => WRITE_STYLES[style] ?? WRITE_STYLES[DEFAULT_WRITE_STYLE];

/* The output of a write call in each style, relative to scenario, for the token estimate (lib/token-estimate.js): the estimator sizes a card from sample cards and
   cannot tell the styles apart, so this is the one place that says how much less a quick card writes. scenario is 1 by definition. quick is NOT measured in the
   product: the prototype (plan §12, one 23-page PDF, hy4-flash-free, one run each) wrote about 15% more output, thinking included, in the scenario wording than in
   the plainer one, so quick is taken as 1 / 1.15. A style missing here is priced as scenario. */
export const WRITE_STYLE_OUTPUT = Object.freeze({ scenario: 1, quick: 1 / 1.15 });

/** The output factor of `style` (1 for an unknown one). */
export const writeStyleOutput = style => WRITE_STYLE_OUTPUT[style] ?? 1;
