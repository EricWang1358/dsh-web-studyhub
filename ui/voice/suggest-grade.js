/* A flashcard answered by voice (#1031) stays self-rated: the page shows what was said beside the revealed answer and preselects a grade from the
   words the two share. Local and plain (Chinese character pairs, Latin words of three letters or more); the learner confirms with the 0–5 buttons. */

const terms = (text) => {
  const value = String(text ?? '').toLowerCase(), found = new Set();
  for (const [run] of value.matchAll(/[㐀-鿿]+/g)) for (let i = 0; i + 1 < run.length; i++) found.add(run.slice(i, i + 2));
  for (const word of value.match(/[a-z0-9]{3,}/g) || []) found.add(word);
  return found;
};

/** The grade (0–5) the overlap suggests, or null when there is nothing to compare. */
export function suggestedGrade(said, answer) {
  const want = terms(answer), got = terms(said);
  if (!want.size || !String(said ?? '').trim()) return null;
  let hit = 0;
  for (const term of want) if (got.has(term)) hit++;
  const share = hit / want.size;
  return share >= 0.75 ? 4 : share >= 0.5 ? 3 : share >= 0.3 ? 2 : share >= 0.1 ? 1 : 0;
}
