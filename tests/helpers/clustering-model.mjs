/* A fake model whose PLANNER CLUSTERS on purpose: whatever it is asked, it takes the first sentences of the first text it is given and spends the whole count there (the way a real planner
   drifts to the start of a long material). Everything after planning (answers, authoring, review) is the section-aware fake of coverage-fixture.mjs. The planner cannot be told to behave:
   a test that passes with it passes because the SERVER enforced the assignment (lib/assigned-plan.js), not because the model spread its targets.
   `modes`: what the planner does for the pieces it is given
     'cluster'  the first `count` sentences of the first piece(s)
     'greedy'   as 'cluster', and one more than asked (it never stops at the quota)
   `refuse(request)`: return true to make the planner answer {"error":"insufficient evidence"} for that request (a section that supports no point)
   `log.asks`: every planning call: { count, assignments, pieces, sections } so a test can read what each call was given. */
import { sectionedModel } from './coverage-fixture.mjs';
import { parseJson } from '../../lib/generation.js';

const SENTENCE = /Recording (\d+), part (\d+), point (\d+)\.1: [^.]{20,90}/g;
export const sectionOfQuote = quote => { const match = /Recording (\d+), part (\d+), point/.exec(quote); return match ? `r${match[1]}.p${match[2]}` : null; };

export function clusteringModel({ mode = 'cluster', refuse = () => false, failReview, onPlan } = {}) {
  const inner = sectionedModel({ failReview });
  const log = { ...inner.log, asks: [] };
  let serial = 0;
  const complete = async (system, prompt, context = {}) => {
    if (!system.startsWith('Plan a source-grounded assessment')) return inner.complete(system, prompt, context);
    const request = parseJson(prompt.split('REQUEST DATA:\n')[1]);
    log.asks.push({ count: request.count, assignments: request.assignments || null, pieces: request.sources.map(source => ({ id: source.id, chars: source.text.length, section: source.section })), part: context.part ?? null });
    onPlan?.(request);
    if (refuse(request)) return JSON.stringify({ error: 'insufficient evidence' });
    // A planner that reads what it is told: a passage listed as already planned for an assignment is not chosen again (it still clusters: first sentences first).
    const used = (request.assignments || []).flatMap(item => item.alreadyPlanned || []);
    const all = request.sources.flatMap(source => [...source.text.matchAll(SENTENCE)].map(match => ({ sourceId: source.id, quote: match[0] }))).filter(item => !used.some(text => item.quote.startsWith(text.replace(/…$/, ''))));
    const picked = all.slice(0, request.count + (mode === 'greedy' ? 1 : 0));
    const taken = new Set((request.existing || []).map(item => String(item).toLowerCase()));
    return JSON.stringify({ targets: picked.map(item => {
      const objective = `Objective ${item.quote.slice(0, 40)} #${++serial}`;
      taken.add(objective.toLowerCase());
      log.quoteOf.set(objective, item.quote);
      return { objective, knowledge: item.quote, answerBoundary: 'Only the source statement', comparisonAxis: 'One scope distinction', misconception: 'Swapping scopes', contextNeeded: 'All relevant conditions in the stem',
        answerability: { mode: 'recall', requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false }, citations: [{ sourceId: item.sourceId, quote: item.quote }] };
    }) });
  };
  return { complete, log };
}
