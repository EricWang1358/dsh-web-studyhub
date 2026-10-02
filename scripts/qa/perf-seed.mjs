/* A synthetic study library shaped like a heavy user's, for performance checks and budget tests
   (tests/perf-budget.test.mjs, scripts/qa/perf-baseline.mjs --seed, scripts/qa/perf-browser.mjs --seed).
   Deterministic: the same options always write the same library. Shapes follow references/library-schema.md:
   sources with long lecture text, decks of mixed card kinds with citations and review state, practice runs that
   embed a copy of each card (the heaviest part of a real library), chunked attempts and a few courses.
   No real content: the text is generated filler. */
import { Store } from "../../lib/store.js";

/** mulberry32: small seeded generator, so a seeded library is byte-identical between runs. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["cluster", "pod", "service", "latency", "consistency", "replica", "scheduler", "index", "transaction", "gateway", "cache", "queue", "shard", "tenant", "pipeline", "observability", "容器", "调度", "一致性", "事务", "缓存", "副本", "网关", "链路"];
const sentence = (rand, words = 14) => Array.from({ length: words }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ") + ".";
const paragraphs = (rand, chars) => {
  const out = [];
  let size = 0;
  while (size < chars) { const paragraph = Array.from({ length: 4 }, () => sentence(rand)).join(" "); out.push(paragraph); size += paragraph.length + 2; }
  return out.join("\n\n");
};

/** Build the library on disk. Returns what was written, for assertions. */
export async function seedLibrary(root, options = {}) {
  const { sources = 600, decks = 30, cardsPerDeck = 40, runs = 40, attempts = 2500, courses = 15, seed = 7,
    typicalSourceChars = 2400, largeSources = 12, largeSourceChars = 60000 } = options;
  const rand = random(seed);
  const store = new Store(root);
  const courseNames = Array.from({ length: courses }, (_, index) => `Course ${String(index + 1).padStart(2, "0")} / Chapter ${(index % 5) + 1}`);
  const stamp = (offset) => new Date(Date.UTC(2026, 8, 1) + offset * 3_600_000).toISOString();
  const state = { sources: [], decks: [], runs: [], attempts: [] };
  for (let index = 0; index < sources; index++) {
    const big = index < largeSources;
    state.sources.push({ id: `src-${String(index).padStart(4, "0")}`, title: `Lecture ${index + 1} · ${WORDS[index % WORDS.length]} notes`,
      text: paragraphs(rand, big ? largeSourceChars : Math.round(typicalSourceChars * (0.4 + rand() * 1.2))), createdAt: stamp(index),
      courses: [courseNames[index % courses]] });
  }
  const kinds = ["flashcard", "quiz", "multi", "cloze", "open"];
  for (let deckIndex = 0; deckIndex < decks; deckIndex++) {
    const cards = Array.from({ length: cardsPerDeck }, (_, cardIndex) => {
      const kind = kinds[(deckIndex + cardIndex) % kinds.length];
      const source = state.sources[(deckIndex * 7 + cardIndex) % sources];
      const card = { id: `d${deckIndex}-c${cardIndex}`, kind, topic: `Topic ${(cardIndex % 6) + 1}`, objective: sentence(rand, 8),
        prompt: sentence(rand, 16), answer: sentence(rand, 6), hint: sentence(rand, 6), explanation: sentence(rand, 30), misconception: sentence(rand, 5),
        citations: [{ sourceId: source.id, quote: sentence(rand, 12) }],
        review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, capturedAt: stamp(deckIndex * 3), origin: "generated",
        revisions: [] };
      if (kind === "quiz" || kind === "multi") card.options = ["a", "b", "c", "d"].map((optionId, position) => ({ id: optionId, text: sentence(rand, 7),
        correct: kind === "quiz" ? position === (cardIndex % 4) : position < 2, explanation: sentence(rand, 9) }));
      if (kind === "cloze") Object.assign(card, { cloze: { text: `${sentence(rand, 6)} {{c1::${WORDS[cardIndex % WORDS.length]}}}`, blanks: [{ id: "c1", answer: WORDS[cardIndex % WORDS.length] }] } });
      if (kind === "open") card.rubric = sentence(rand, 12);
      return card;
    });
    state.decks.push({ id: `deck-${deckIndex}`, title: `Deck ${deckIndex + 1}`, folder: courseNames[deckIndex % courses], course: courseNames[deckIndex % courses],
      createdAt: stamp(deckIndex * 3), cards });
  }
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const deck = state.decks[runIndex % decks];
    const entries = deck.cards.filter((card) => card.kind !== "open").slice(0, 10 + (runIndex % 9)).map((card, position) => ({ deckId: deck.id, card: structuredClone(card),
      startedAt: Date.UTC(2026, 8, 2) + position,
      ...(runIndex % 3 === 0 && position < 4 ? { feedback: { grade: 4, correct: true, at: stamp(runIndex) }, revealed: true } : {}) }));
    state.runs.push({ id: `run-${String(runIndex).padStart(3, "0")}`, deckId: deck.id, mode: "flashcard", scope: [{ deckId: deck.id }], key: `flashcard:${deck.id}`, index: 0,
      startedAt: stamp(runIndex), entries, ...(runIndex % 4 === 3 ? { closedAt: stamp(runIndex + 1) } : {}) });
  }
  for (let index = 0; index < attempts; index++) {
    const deck = state.decks[index % decks], card = deck.cards[index % cardsPerDeck];
    state.attempts.push({ id: `att-${index}`, runId: `run-${String(index % runs).padStart(3, "0")}`, quiz_id: card.id, deckId: deck.id, topic: card.topic,
      timestamp: stamp(index / 4), grade: index % 5 === 0 ? 1 : 4, elapsed_ms: 2000 + (index % 9000),
      before: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, after: { repetitions: 1, interval_days: 1, ease_factor: 2.5, due_at: stamp(index / 4 + 24) } });
  }
  await store.update((library) => { Object.assign(library, state); });
  return { sources, decks, cards: decks * cardsPerDeck, runs, attempts, courses, root };
}

if (process.argv[1] && process.argv[1].endsWith("perf-seed.mjs")) {
  const root = process.argv[2];
  if (!root) { console.error("usage: node scripts/qa/perf-seed.mjs <empty library dir> [sources]"); process.exit(2); }
  console.log(JSON.stringify(await seedLibrary(root, process.argv[3] ? { sources: Number(process.argv[3]) } : {})));
}
