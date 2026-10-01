import { readRetrievalSettings } from './retrieval-settings.js';
import { retrieveFromPort } from './retrieval.js';

/* The guided flow's material pick by retrieval (WP28). The goal sentence is
   looked up by the chosen provider; the topics whose cards cite the pages it
   finds are offered first. Name matching and the model stay as they were when
   no provider is chosen, it finds nothing, or it fails. */

const RETRIEVE_TIMEOUT_MS = 20_000;

/** { topics, retrieved }: topics reordered/narrowed to those backed by retrieved pages, or the input unchanged. */
export async function topicsByRetrieval(port, state, topics, { goal, course } = {}) {
  const unchanged = { topics, retrieved: false };
  if (!port || !topics.length || !String(goal ?? '').trim()) return unchanged;
  try {
    const settings = await readRetrievalSettings();
    if (settings.provider === 'builtin') return unchanged;
    const decks = new Map(state.decks.map(deck => [deck.id, deck]));
    // The sources behind each topic's cards: only these can say anything about the course's topics.
    const cited = topics.map(topic => new Set(topic.decks.flatMap(entry => (decks.get(entry.deckId)?.cards || [])
      .filter(card => (card.topic || '未分类') === entry.topic && (entry.cardId === undefined || entry.cardId === card.id))
      .flatMap(card => (card.citations || []).map(citation => citation.sourceId)))));
    const ids = new Set(cited.flatMap(set => [...set]));
    const sources = state.sources.filter(source => ids.has(source.id));
    if (!sources.length) return unchanged;
    const result = await retrieveFromPort(port, settings, { query: String(goal).trim(), sources, ...(course ? { course } : {}), limit: 30,
      signal: AbortSignal.timeout(RETRIEVE_TIMEOUT_MS) });
    if (!result?.passages.length) return unchanged;
    const score = new Map(result.passages.map(passage => [passage.sourceId, passage.score]));
    const ranked = topics.map((topic, index) => ({ topic, value: [...cited[index]].reduce((sum, id) => sum + (score.get(id) || 0), 0) }))
      .filter(entry => entry.value > 0).sort((a, b) => b.value - a.value);
    return ranked.length ? { topics: ranked.map(entry => entry.topic), retrieved: true } : unchanged;
  } catch { return unchanged; }
}
