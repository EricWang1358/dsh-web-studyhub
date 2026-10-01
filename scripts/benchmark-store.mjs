import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../lib/store.js';

const root = await mkdtemp(join(tmpdir(), 'study-store-benchmark-'));
const store = new Store(root);
const count = Number(process.env.STUDY_BENCH_ITERATIONS || 20);
try {
  await store.update(state => {
    state.decks = Array.from({ length: 50 }, (_, deck) => ({ id: `deck-${deck}`, title: `Deck ${deck}`,
      cards: Array.from({ length: 100 }, (_, card) => ({ id: `card-${deck}-${card}`, type: 'basic',
        question: 'Explain the concept and its application.'.repeat(4), answer: 'A detailed explanation.'.repeat(8) })) }));
    state.attempts = Array.from({ length: 50000 }, (_, i) => ({ id: `attempt-${i}`, cardId: `card-${i % 50}-${i % 100}`,
      at: '2026-10-01T00:00:00.000Z', grade: 3, response: 'The learner response.'.repeat(4) }));
  });
  const measure = async (name, operation) => {
    for (let i = 0; i < 3; i++) await operation();
    const times = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now(); await operation(); times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { name, iterations: count, medianMs: times[Math.floor(count / 2)], p95Ms: times[Math.min(count - 1, Math.floor(count * .95))] };
  };
  const settings = store.scoped(['settings']);
  const study = store.scoped(['decks', 'attempts']);
  const results = [];
  results.push(await measure('settings-only', () => settings.update(state => { state.settings.first_interval_days += 1; })));
  results.push(await measure('study-write', () => study.update(state => {
    state.decks[0].cards[0].reviewCount = (state.decks[0].cards[0].reviewCount || 0) + 1;
    state.attempts.push({ id: `new-${state.attempts.length}`, cardId: 'card-0-0', grade: 3 });
  })));
  console.log(JSON.stringify({ fixture: { cards: 5000, attempts: 50000 }, node: process.version, platform: process.platform,
    results }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
