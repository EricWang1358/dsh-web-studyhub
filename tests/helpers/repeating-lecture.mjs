/* A lecture that repeats itself: the first sentence of sections 7..12 is word for word the first sentence of sections 1..6 (a teacher who opens a new part with the line that opened an earlier one).
   The planner below does what a real one does when it is given one assigned section: it quotes a sentence of THAT section. The program verifies the quote inside the section, so the question is
   about section 9, while the first place the same words stand in the stored text is section 3: the case where a kept question has to be credited to the section it was written for.
   The answers, the writing and the review are the section-aware fake of coverage-fixture.mjs. */
import { sectionedModel } from './coverage-fixture.mjs';
import { parseJson } from '../../lib/generation.js';

const sentence = (i, j) => `Point ${i}.${j}: the platform team owns decision ${i}${j} and every product group must follow rule ${i}${j} when it builds on the shared layer.`;
const SENTENCE = /Point \d+\.\d+: [^.]+\./g;

/** `{ text, sources, sections }`: `count` headed sections; those after the sixth open with the sentence that opened section (n - 6). */
export function repeatingLecture(count = 12) {
  const body = Array.from({ length: count }, (_, k) => { const n = k + 1, first = n > 6 ? sentence(n - 6, 1) : sentence(n, 1); return `# Section ${n}\n\n${first} ${sentence(n, 2)} ${sentence(n, 3)}\n\n`; });
  const text = body.join('');
  return { text, sources: [{ id: 'lec', title: 'Lecture', text }], sectionTitle: n => `Section ${n}` };
}

/** `quoteNth`: which sentence of an assigned section the planner quotes (0 = the first, the one that repeats). */
export function repeatingModel({ quoteNth = 0, failReview } = {}) {
  const inner = sectionedModel({ failReview });
  let serial = 0;
  const complete = async (system, prompt, context = {}) => {
    if (system.startsWith('You author')) {
      // The stem of a question is its own (the fake writes it from the quote, and two questions that quote the same words must not be taken for one question).
      const reply = parseJson(await inner.complete(system, prompt, context));
      for (const card of reply.deck.cards) card.prompt = `Which rule applies to ${card.objective}?`;
      return JSON.stringify(reply);
    }
    if (!system.startsWith('Plan a source-grounded assessment')) return inner.complete(system, prompt, context);
    const request = parseJson(prompt.split('REQUEST DATA:\n')[1]), targets = [];
    for (const item of request.assignments || []) {
      const piece = request.sources.find(source => source.section === item.id), found = [...(piece?.text.matchAll(SENTENCE) || [])].map(match => match[0]);
      // A re-ask names the passages already used: the next sentence is quoted instead.
      const fresh = found.filter(quote => !(item.alreadyPlanned || []).some(used => quote.startsWith(used.replace(/…$/, ''))));
      for (const quote of fresh.slice(quoteNth, quoteNth + item.quota)) {
        targets.push({ objective: `Objective ${quote.slice(0, 30)} #${++serial}`, knowledge: quote, answerBoundary: 'Only the source statement', comparisonAxis: 'One scope distinction', misconception: 'Swapping scopes',
          contextNeeded: 'All relevant conditions in the stem', answerability: { mode: 'recall', requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false },
          citations: [{ sourceId: piece.id, quote }] });
      }
    }
    return JSON.stringify({ targets });
  };
  return { complete, log: inner.log };
}
