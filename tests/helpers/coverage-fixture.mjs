/* The ground truth of the coverage tests: the audit's merged transcript (5 recordings of 16 headed parts, two volumes, the fourth recording carried across them)
   and a way to say, section by section, which parts a set of questions is "about". The checklist is a plain list of section ids ("r2.p3"); a test builds its
   questions from the checklist and asserts that coverageOf finds exactly it, so the expectation never comes from the code under test. */
import { mergedTranscript } from './merged-transcript.mjs';
import { sectionsOf } from '../../lib/sections.js';
import { parseJson } from '../../lib/generation.js';
import { qualityReview } from './assessment.mjs';

export function transcriptFixture(options) {
  const world = mergedTranscript(options);
  const sections = sectionsOf(world.sources), leaves = sections.filter(section => section.leaf);
  const textOf = sourceId => world.sources.find(source => source.id === sourceId).text;
  /** The leaf of recording `r`, part `p` (the part of the volume it starts in); `id` is the section id the checklist uses. */
  const leaf = (recording, part, { continued = false } = {}) => leaves.find(section => section.recording === recording && section.part === part && !!section.continued === continued);
  /** A verbatim sentence from inside a section (point `n`). */
  const quoteIn = (section, n = 1) => {
    const body = textOf(section.sourceId).slice(section.start, section.end), match = new RegExp(`Recording \\d+, part \\d+, point ${n}\\.1: [^.]{20,90}`).exec(body);
    // The part of a recording that carries on in the next volume starts mid-sentence: a stretch of its own text will do.
    return match ? match[0] : body.slice(30, 90).trim();
  };
  /** A question about a section: it cites a quote there, or (how: 'selection') carries the selection offsets of it. */
  const card = (section, { how = 'quote', n = 1, id = `card-${section.id}-${n}` } = {}) => {
    const quote = quoteIn(section, n), text = textOf(section.sourceId), at = text.indexOf(quote, section.start);
    return how === 'selection'
      ? { id, kind: 'flashcard', prompt: `Q ${id}`, citations: [{ sourceId: section.sourceId, quote, selection: { sourceId: section.sourceId, start: at, end: at + quote.length, quote } }] }
      : { id, kind: 'flashcard', prompt: `Q ${id}`, citations: [{ sourceId: section.sourceId, quote }] };
  };
  return { world, sources: world.sources, sections, leaves, leaf, quoteIn, card, textOf, ids: leaves.map(section => section.id) };
}

/** A fake model whose plan cites a different section for every target: the i-th "point 1.1" sentence of the group of pages it is given. `failReview(part, nth)` damages a review reply. */
export function sectionedModel({ failReview = () => false, onPlan } = {}) {
  const log = { plans: [], reviews: [], authors: [], quoteOf: new Map() };
  let serial = 0;
  const ordinals = new Map();
  const complete = async (system, prompt, context = {}) => {
    const part = context.part ?? null, data = () => parseJson(prompt.split('REQUEST DATA:\n')[1]);
    if (system.startsWith('Plan a source-grounded assessment')) {
      const request = data(), bySection = new Map();
      for (const source of request.sources) for (const match of source.text.matchAll(/Recording (\d+), part (\d+), point (\d+)\.1: [^.]{20,90}/g)) {
        const key = `${match[1]}.${match[2]}`;
        if (!bySection.has(key)) bySection.set(key, []);
        bySection.get(key).push({ sourceId: source.id, quote: match[0] });
      }
      // One target per section, spread over the sections when there are fewer targets than sections; a second sentence of each section only once every section has one.
      const groups = [...bySection.values()], found = [];
      for (let round = 0; found.length < request.count && round < 4; round++) for (const group of groups) if (group[round]) found.push(group[round]);
      const spread = request.count <= groups.length ? Array.from({ length: request.count }, (_, index) => groups[Math.floor((index + 0.5) * groups.length / request.count)][0]) : found.slice(0, request.count);
      log.plans.push({ count: request.count, quotes: spread.map(item => item.quote) });
      for (const [index, item] of spread.entries()) log.quoteOf.set(`Objective ${item.quote.slice(0, 40)} #${log.plans.length}.${index}`, item.quote);
      onPlan?.(request);
      return JSON.stringify({ targets: spread.map((item, index) => ({ targetId: `target-${index + 1}`, objective: `Objective ${item.quote.slice(0, 40)} #${log.plans.length}.${index}`, knowledge: item.quote,
        answerBoundary: 'Only the source statement', comparisonAxis: 'One scope distinction', misconception: 'Swapping scopes', contextNeeded: 'All relevant conditions in the stem',
        answerability: { mode: 'recall', requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false },
        citations: [{ sourceId: item.sourceId, quote: item.quote }] })) });
    }
    const cardOf = (target, index) => ({ id: `q${++serial}`, targetId: target.targetId, kind: 'quiz', topic: 'Scope', objective: target.objective,
      prompt: `Which statement follows from "${target.citations[0].quote.slice(0, 50)}"?`, answer: 'The first option.', hint: 'Compare the options with the passage.', explanation: 'The passage supports the first option.',
      misconception: 'Mixing scopes.', citations: target.citations,
      options: [{ id: 'a', text: 'The first option.', correct: true, explanation: 'Supported.' }, { id: 'b', text: 'The second option.', correct: false, explanation: 'Not supported.' }, { id: 'c', text: 'The third option.', correct: false, explanation: 'Not supported.' }] });
    if (system.startsWith('Prepare supported answers')) {
      const planned = data().assessmentPlan;
      return JSON.stringify({ items: planned.targets.map((target, index) => { const card = cardOf(target, index); return { targetId: target.targetId, answer: card.answer, reasoning: card.explanation,
        scenario: { kind: 'none', facts: [], decisiveConditions: [] }, comparisonAxis: 'scope', options: card.options }; }) });
    }
    if (system.startsWith('You author')) {
      const planned = data().assessmentPlan, cards = planned.targets.map(cardOf);
      log.authors.push({ part, objectives: planned.targets.map(target => target.objective) });
      return JSON.stringify({ deck: { title: 'Coverage', cards }, changes: [], checks: qualityReview({ cards }).checks });
    }
    if (system.startsWith('Act as a strict assessment editor')) {
      // A part is known by the context a batch passes (a direct run of lib/batch.js) or, through a service that does not forward it, by the order its candidate first came to review.
      const candidate = parseJson(prompt).candidate, key = candidate.cards.map(card => card.id).join('|');
      if (!ordinals.has(key)) ordinals.set(key, ordinals.size + 1);
      const nth = log.reviews.filter(item => item.key === key).length + 1;
      log.reviews.push({ part, nth, key });
      return failReview(part, nth, ordinals.get(key)) ? '{"issues":' : JSON.stringify(qualityReview(candidate));
    }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  return { complete, log };
}
