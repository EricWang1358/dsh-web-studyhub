import { authored, qualityPlan, qualityBlueprint, qualityReview } from '../../helpers/assessment.mjs';

/* The model of the S3-7 rollback drill: one fake that answers every stage of the generation family (plan, blueprint, author, review, repair) the same way for any tree (the current one
   and the older one the drill rolls back to), so what the two versions make of the same library can be compared. `hold` (stage, nth) stops the nth call of a stage for ever: the process is
   ended hard while it waits. */
export function driveModel({ hold } = {}) {
  // Every written question is new (the id and the words carry a salt of this process and the number of the call), as a real model's would be: the work of a retry is told from the work before it.
  const seen = {}, state = { held: false }, salt = Date.now().toString(36);
  const complete = async (system, prompt) => {
    const stage = system.startsWith('Plan a source-grounded') ? 'plan' : system.startsWith('Prepare supported answers') ? 'blueprint' : system.startsWith('Act as a strict') ? 'review'
      : system.startsWith('Repair one draft card') ? 'repair' : 'author';
    seen[stage] = (seen[stage] || 0) + 1;
    if (hold && hold.stage === stage && seen[stage] === hold.nth) { state.held = true; await new Promise(() => {}); }
    if (stage === 'plan') return JSON.stringify(qualityPlan(JSON.parse(prompt.split('REQUEST DATA:\n')[1])));
    if (stage === 'review') return JSON.stringify(qualityReview(JSON.parse(prompt).candidate, []));
    if (stage === 'repair') { const input = JSON.parse(prompt); return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } }); }
    const data = JSON.parse(prompt.split('REQUEST DATA:\n')[1]), source = data.sources[0];
    const cards = Array.from({ length: stage === 'blueprint' ? data.assessmentPlan.targets.length : data.count }, (_, index) => ({ id: `q${salt}-${seen[stage]}-${index + 1}`, kind: 'flashcard', topic: `Topic ${index}`,
      objective: `Explain angle ${salt}-${seen[stage]}-${index} of ${source.text.slice(0, 20)}`, prompt: `Why does angle ${salt}-${seen[stage]}-${index} matter for ${source.text.slice(0, 18).toLowerCase()} decisions?`, answer: `Angle ${index} constrains later choices.`,
      hint: 'Compare a description with a rule for permitted changes.', explanation: `The evidence ties angle ${index} to design and later change, so it constrains the choices made afterwards.`,
      misconception: 'It only names existing parts.', citations: [{ sourceId: source.id, quote: source.text.slice(0, 40) }] }));
    const deck = { title: 'Drill', cards };
    return JSON.stringify(stage === 'blueprint' ? qualityBlueprint(data, data.assessmentPlan, deck) : authored(deck, [], data.assessmentPlan));
  };
  return { complete, state, seen };
}
