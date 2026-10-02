/* EXPERIMENTAL. The places where StudyHub asks a model for a decision-shaped answer (a verdict, a choice among labelled options, a score,
   a yes/no) that the learner may choose to have Jev answer instead. One list, in one place; the audit behind it is docs/jev-experimental.md.

   Each site is a switch of its own, off by default (lib/jev-settings.js `replace`), and a site is wired only where the call can be handed to
   Jev and handed back to the existing model path unchanged (lib/jev-decide.js). Prose (explanations, translations, outline text, card text,
   answers) can never be replaced: Jev returns typed decisions only.

     cardReview      the independent review of a candidate deck (lib/generation.js `reviewDeck`): per card pass/fail on six quality dimensions
     courseOrganize  "请 AI 建议" in 资料 › 整理课程归属 (`source.organize.suggest`): which existing course a source belongs to

   The ids are distinct from the extra-signal experiments (`JEV_FEATURES` in lib/jev-settings.js) so each has its own switch and its own
   token row in the usage page. */

export const JEV_REPLACE_SITES = Object.freeze(['cardReview', 'courseOrganize']);
export const isReplaceSite = id => typeof id === 'string' && JEV_REPLACE_SITES.includes(id);
