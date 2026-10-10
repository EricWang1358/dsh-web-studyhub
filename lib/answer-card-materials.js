/* What an answer card (lib/answer-card.js, 复习全书 M5) is written from, among the deck's course materials: when they do not fit the budget, the passages
   that share the most terms with the question (its stem, topic, concepts and rubric) come first, by a plain term-overlap ranking (rare terms weigh more),
   then the rest in reading order until the budget is full. Deterministic (the same materials and question always give the same selection); no index, no
   model, no network. A converted text is read as its visible words (lib/answer-card.js visibleText), so a definition in a table cell can be found.
   Pure, no Node modules. */
import { visibleText } from './answer-card.js';

export const PASSAGE_CHARS = 1200;
const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'had', 'his', 'how',
  'its', 'may', 'new', 'now', 'own', 'see', 'two', 'way', 'who', 'did', 'does', 'this', 'that', 'with', 'from', 'they', 'will', 'would', 'there', 'their', 'what',
  'when', 'which', 'your', 'into', 'than', 'then', 'them', 'these', 'those', 'such', 'each', 'other', 'about', 'should', 'could', 'show', 'explain', 'describe',
  'question', 'answer', 'marks', 'mark', 'case']);
const HAN = /[㐀-鿿豈-﫿]+/g;

/** The terms of a text: Latin words of three letters or more (lower case, common words left out) and the two-character pairs of a Chinese run. */
export function termsOf(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase(), terms = new Set();
  for (const word of value.match(/[a-z][a-z0-9-]{2,}/g) || []) if (!STOP.has(word)) terms.add(word.replace(/-+$/, ''));
  for (const run of value.match(HAN) || []) {
    if (run.length === 1) continue;
    for (let at = 0; at + 1 < run.length; at++) terms.add(run.slice(at, at + 2));
  }
  return terms;
}

/** The passages of a text in reading order: paragraphs, a long one cut into pieces of PASSAGE_CHARS. [{ start, text }] (offsets in `text`). */
export function passagesOf(text) {
  const value = String(text ?? ''), out = [];
  const re = /\n\s*\n/g;
  let start = 0;
  const add = (from, to) => {
    for (let at = from; at < to; at += PASSAGE_CHARS) {
      const piece = value.slice(at, Math.min(to, at + PASSAGE_CHARS));
      if (piece.trim()) out.push({ start: at, text: piece });
    }
  };
  for (let match; (match = re.exec(value));) { add(start, match.index); start = match.index + match[0].length; }
  add(start, value.length);
  return out;
}

/**
 * The materials to send, at most `budget` characters of passage text in all. `sources`: [{ id, title, text }] in their order (a material's `ref` is its
 * place in this list: M1, M2, …); `query`: the question's texts. -> [{ ref, title, text, excerpt? }] in source order, each material's chosen passages in
 * reading order with […] where something was left out; a material with nothing chosen is left out.
 */
export function selectMaterials(sources = [], { query = [], budget = 24000 } = {}) {
  const items = sources.map((source, at) => ({ ref: `M${at + 1}`, title: source.title || '', text: visibleText(source.text).text }));
  if (items.reduce((sum, item) => sum + item.text.length, 0) <= budget) return items.filter(item => item.text.trim()).map(({ ref, title, text }) => ({ ref, title, text }));
  const wanted = termsOf(query.join('\n'));
  const passages = items.flatMap((item, source) => passagesOf(item.text).map((passage, order) => ({ ...passage, source, order, terms: termsOf(passage.text) })));
  const df = new Map();
  for (const passage of passages) for (const term of passage.terms) if (wanted.has(term)) df.set(term, (df.get(term) || 0) + 1);
  for (const passage of passages)
    passage.score = [...passage.terms].reduce((sum, term) => sum + (df.has(term) ? Math.log(1 + passages.length / df.get(term)) : 0), 0);
  const byScore = passages.filter(passage => passage.score > 0).sort((a, b) => b.score - a.score || a.source - b.source || a.order - b.order);
  const inOrder = passages.filter(passage => !(passage.score > 0));
  const chosen = new Set();
  let used = 0;
  for (const passage of [...byScore, ...inOrder]) {
    if (used + passage.text.length > budget) continue;
    chosen.add(passage); used += passage.text.length;
  }
  return items.flatMap((item, source) => {
    const own = passages.filter(passage => passage.source === source), kept = own.filter(passage => chosen.has(passage));
    if (!kept.length) return [];
    const parts = kept.map((passage, at) => `${at && passage.order !== kept[at - 1].order + 1 ? '[…]\n\n' : ''}${passage.text.trim()}`);
    const whole = kept.length === own.length;
    const text = `${kept[0].order ? '[…]\n\n' : ''}${parts.join('\n\n')}${kept.at(-1).order < own.length - 1 ? '\n\n[…]' : ''}`;
    return [{ ref: item.ref, title: item.title, text, ...(whole ? {} : { excerpt: true }) }];
  });
}
