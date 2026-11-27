import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';

export const calculationQuote = 'Distance equals speed multiplied by elapsed time.';
const stages = ['conditions', 'formula', 'substitution', 'computation', 'verification'];
export const calculationPlan = () => ({ diagnosis: 'Units need attention', transfer: 'Use consistent units before multiplying.',
  rungs: stages.map((stage, i) => ({ stage, lesson: `Stage ${i} relationship`, check: `Current check ${i}?`, answer: `Hidden reference ${i}`,
    assumptions: 'Constant speed', units: 'metres and seconds', rounding: 'Keep exact values until the final result',
    citations: [{ sourceId: 'source', quote: calculationQuote }] })) });

export async function setupCalculation(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-calculation-'));
  const service = new StudyService(root, { complete: async () => JSON.stringify(calculationPlan()) });
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await service.store.update(s => {
    s.sources.push({ id: 'source', title: 'Motion', text: calculationQuote });
    s.decks.push({ id: 'deck', title: 'Motion', cards: [{ id: 'card', kind: 'flashcard', prompt: 'At 3 m/s for 4 s, how far?', answer: '12 m', citations: [{ sourceId: 'source', quote: calculationQuote }] }] });
  });
  const run = await service.call('review.start', { deckId: 'deck', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 2 });
  return { service, root, run };
}
