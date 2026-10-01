import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const backend = resolve(process.argv[2] || 'lib');
const { StudyService } = await import(pathToFileURL(join(backend, 'service.js')));
const { initialReview } = await import(pathToFileURL(join(backend, 'domain.js')));
const root = await mkdtemp(join(tmpdir(), 'study-answer-benchmark-'));
const service = new StudyService(root, { coach: false });
const count = Number(process.env.STUDY_BENCH_ITERATIONS || 20);
try {
  await service.store.update(state => {
    state.decks = Array.from({ length: 50 }, (_, deck) => ({ id: `deck-${deck}`, title: `Deck ${deck}`,
      cards: Array.from({ length: 100 }, (_, card) => ({ id: `card-${deck}-${card}`, kind: 'flashcard',
        topic: 'Concept', objective: `Explain concept ${deck}-${card}`, prompt: `Explain concept ${deck}-${card} and its application.`,
        answer: 'A detailed explanation.'.repeat(8), explanation: 'Concept and application.'.repeat(8), citations: [], review: initialReview() })) }));
    state.attempts = Array.from({ length: 50000 }, (_, i) => ({ id: `attempt-${i}`, deckId: `deck-${i % 50}`, cardId: `card-${i % 50}-${i % 100}`,
      at: '2026-10-01T00:00:00.000Z', grade: 3, response: 'The learner response.'.repeat(4) }));
  });
  let run = await service.call('review.start', { deckId: 'deck-0', mode: 'flashcard' });
  const answer = async () => {
    if (run.feedback) run = await service.call('review.move', { runId: run.id, direction: 1 });
    run = await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
    const start = performance.now();
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 4 });
    return performance.now() - start;
  };
  for (let i = 0; i < 3; i++) await answer();
  const times = [];
  for (let i = 0; i < count; i++) times.push(await answer());
  times.sort((a, b) => a - b);
  const saved = await service.store.read();
  if (saved.attempts.length !== 50000 + count + 3) throw new Error('Benchmark answers did not produce distinct attempts');
  console.log(JSON.stringify({ fixture: { cards: 5000, attempts: 50000 }, node: process.version, platform: process.platform,
    operation: 'review.answer', preparationExcluded: ['review.start', 'review.move', 'review.reveal'], iterations: count,
    medianMs: times[Math.floor(count / 2)], p95Ms: times[Math.min(count - 1, Math.floor(count * .95))],
    attemptsAdded: count + 3 }, null, 2));
} finally { service.dispose?.(); await rm(root, { recursive: true, force: true }); }
