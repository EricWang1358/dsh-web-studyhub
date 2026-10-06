/* Which already-written learning targets a plan call is told about.

   The plan call carries `existing`, the list of targets the new questions must
   not repeat (the answer and author calls are not sent it again: they work from
   the planned targets, which the plan already de-duplicated). Sending the whole library each time made the
   list the biggest part of a run: one real library holds 2,900 targets (about
   55K tokens), and 8 calls of a 20-question run repeated them, more than half
   of everything the run used, most of it targets of other courses that cannot
   repeat anything in these materials.

   The list is therefore narrowed locally, with no model call: the targets the
   caller pins (the deck being added to, the draft being continued) are always
   kept, and of the rest only the ones that share wording with the materials
   being written from, the most alike first, up to a limit. A target that shares
   nothing with the materials cannot be asked about by them. */

/** Targets kept beyond the pinned ones. */
export const EXISTING_LIMIT = 120;
/** Pinned targets are kept whole up to this many (a target deck is a few hundred questions at most). */
export const PINNED_LIMIT = 400;
/** Distinct words a target must share with the materials to count as alike. */
const MIN_SHARED = 2;

const WORD = /[a-z][a-z0-9-]{2,}/g;
const CJK_RUN = /[㐀-鿿豈-﫿]+/g;

/** Words of a text: Latin words of three letters or more, and every pair of neighbouring Han characters. */
function termsOf(text) {
  const value = String(text ?? '').toLowerCase(), terms = new Set();
  for (const word of value.match(WORD) || []) terms.add(word);
  for (const run of value.match(CJK_RUN) || []) {
    if (run.length === 1) { terms.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return terms;
}

/**
 * The objectives worth telling a call about.
 * @param objectives every known objective, oldest first
 * @param sources the materials the call writes from (`{ text }`)
 * @param options `{ pinned, limit }`: objectives that are always kept; how many others may follow
 * @returns the pinned objectives, then the most alike others (newer first among equally alike ones), each once
 */
export function scopeExisting(objectives, sources, { pinned = [], limit = EXISTING_LIMIT } = {}) {
  const keep = [], seen = new Set();
  const take = (objective) => {
    if (typeof objective !== 'string' || !objective.trim() || seen.has(objective)) return false;
    seen.add(objective);
    keep.push(objective);
    return true;
  };
  for (const objective of pinned.slice(-PINNED_LIMIT)) take(objective);
  const list = Array.isArray(objectives) ? objectives : [];
  if (!list.length || limit <= 0) return keep;
  const material = new Set();
  for (const source of Array.isArray(sources) ? sources : []) for (const term of termsOf(source?.text)) material.add(term);
  if (!material.size) return keep;
  const scored = [];
  list.forEach((objective, index) => {
    if (typeof objective !== 'string' || seen.has(objective)) return;
    let shared = 0;
    for (const term of termsOf(objective)) if (material.has(term)) shared++;
    if (shared >= MIN_SHARED) scored.push({ objective, shared, index });
  });
  // Most alike first; among equals the newer one (later in the library), which is the likelier to be a neighbour.
  scored.sort((a, b) => b.shared - a.shared || b.index - a.index);
  for (const { objective } of scored.slice(0, limit)) take(objective);
  return keep;
}
