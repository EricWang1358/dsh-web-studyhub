/* A one-question case-study library for the rubric grading request (card.grade), with the deterministic fake model. Fakes only: no model, no network. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { renderRubric } from '../../lib/case-study.js';
import { createFakeModel } from '../../scripts/fake-model.mjs';

const scenario = ['Orchard Cold Chain stores fresh fruit for supermarkets in three refrigerated warehouses.',
  'Temperature sensors report every minute to a desktop program written in Visual Basic in 2009.',
  'In March a warehouse lost power overnight and nobody was alerted until the morning shift arrived.'].join('\n\n');
const concept = 'Event-driven architecture';
const criteria = [
  { id: 'c1', label: `Recommendation using ${concept}`, marks: 3, descriptor: `Applies ${concept} to Orchard.`, keyPoints: [`Names ${concept} correctly`] },
  { id: 'c2', label: 'Case linkage', marks: 2, descriptor: 'Ties choices to facts of the case.', keyPoints: ['The overnight power loss calls for alerting on missing readings'] },
];
export const caseRef = { deckId: 'orchard', cardId: 'q1' };
export const caseAnswer = 'I recommend an event-driven architecture because the sensors already publish readings every minute.\nEach reading becomes an event that an alerting service consumes, so a power loss raises an alarm at once.';

export async function caseLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'instant-case-')), model = createFakeModel({ usage: true });
  const service = new StudyService(root, { complete: model, completeLight: model });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update(state => {
    state.sources.push({ id: 'case', title: 'Case: Orchard Cold Chain', text: scenario, courses: ['Cloud Native'] });
    state.decks.push({ id: 'orchard', title: 'Orchard case', course: 'Cloud Native', format: 'case-study',
      case: { sourceId: 'case', title: 'Orchard Cold Chain', totalMarks: 5, origin: 'imported', language: 'English',
        cues: [{ id: 'cue1', paragraph: 3, quote: 'In March a warehouse lost power overnight and nobody was alerted until the morning shift arrived.', implies: 'Alerting' }] },
      cards: [{ id: 'q1', kind: 'open', topic: concept, objective: `Q1: apply ${concept} at Orchard`,
        prompt: `Question 1: Applying ${concept}, what would you recommend for Orchard's monitoring platform? Justify.`, answer: `Use ${concept} with alerting on missing readings.`,
        hint: 'Re-read the paragraph about March.', explanation: `An excellent answer applies ${concept} and ties it to the power loss.`, misconception: 'Listing tools without the case.',
        marks: 5, rubricCriteria: criteria, rubric: renderRubric(criteria, 'en'), caseQuestion: 1,
        citations: [{ sourceId: 'case', quote: 'In March a warehouse lost power overnight' }] }] });
  });
  return { service, root };
}
