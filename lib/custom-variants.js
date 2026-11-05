import { courseOf } from './focus.js';

/* 变式题 of a 定制方案 (深度定制, lib/custom-plan.js `questions.variants`): whether the wrong answers of THIS course get variants prepared AUTOMATICALLY (lib/contexts/coach: the
   practice debrief, a follow-up, a too-easy / too-hard vote). The learner's general consent (`learner.consent.prep`) is one switch for every course; the plan is the learner's
   yes or no for one. Pure, read only.

   variantSwitch(state, deck) -> true | false | null: what the plan of the deck's course says; null when it has no plan or the plan makes no questions (a plan that asks for no
     questions has not asked the learner about variants: the general consent decides, as it always did).
   prepPolicy(state, deck, consent) -> { on, viaPlan }: whether to prepare now. Off in the plan: never, whatever the consent says. On in the plan: yes, and `viaPlan` says the yes is
     the plan's (the general consent is not touched, and a batch written on that yes does not need it). No switch: `consent`.
   What the learner asks for by hand (the wrong book's 为你定制 button, coach.variants) is not automatic and does not come through here. */

export function variantSwitch(state, deck) {
  const name = courseOf(deck, state), questions = (state.courses || []).find(course => course?.name === name)?.custom?.questions;
  return questions?.make ? questions.variants === true : null;
}

export function prepPolicy(state, deck, consent) {
  const choice = variantSwitch(state, deck);
  return choice === null ? { on: consent === true, viaPlan: false } : { on: choice, viaPlan: choice && consent !== true };
}
