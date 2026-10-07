import { createHash } from 'node:crypto';

/* The input of a generation run, frozen with the draft that checkpoints it. A checkpoint is only as good as the input it was made for: a source that
   changed, a different number of questions or a new definition makes the units already done answers to another question. The reference keeps what
   decides the units (never how fast or how patiently they run), so that "does this checkpoint still fit?" is a comparison of two small records. */

export const INPUT_VERSION = 1;
// What decides a run's units. Concurrency, fill rounds, time limits and reasoning levels change how a run goes, not what its parts are.
const DECIDING = ['kind', 'kindCounts', 'count', 'language', 'difficulty', 'focus', 'role', 'constraints', 'notation', 'mergeTargetId', 'coverageLevel',
  'referenceSourceIds', 'referenceLimits', 'referenceFormat', 'course'];

const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const pair = (value, key) => `${JSON.stringify(key)}:${canonical(value[key])}`;
const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => pair(value, key)).join(',')}}`
  : JSON.stringify(value) ?? 'null');

/** The sources as a run keeps them: id and a hash of the text (a missing source has no text). Sorted, so the order they were listed in never matters. */
export const hashSources = sources => [...sources].sort((a, b) => a.id.localeCompare(b.id))
  .map(source => ({ id: source.id, hash: source.text == null ? '' : digest(String(source.text)) }));

/** `definition`: "<kind>@<version>"; `request`: the resolved request; `sources`: [{ id, text }]; `extraSourceIds` / `added`: a top-up. */
export function inputRefOf({ definition, request, sources, extraSourceIds, added }) {
  const listed = hashSources(sources);
  const decided = Object.fromEntries(DECIDING.filter(key => request[key] !== undefined).map(key => [key, request[key]]));
  decided.batchSize = request.performance?.batchSize;
  // The list of kinds decides the units only when there are several: a run of one kind is the same run (and the same checkpoint) as before the list existed.
  if (request.kinds?.length > 1 && JSON.stringify(request.kinds) !== JSON.stringify(['quiz', 'flashcard'])) decided.kinds = request.kinds;
  const ref = { version: INPUT_VERSION, definition, sources: listed, ...(extraSourceIds ? { extraSourceIds: [...extraSourceIds].sort() } : {}),
    ...(added !== undefined ? { added } : {}) };
  return { ...ref, hash: digest(canonical({ ...ref, request: decided })) };
}

/** Whether a checkpoint made for `saved` still fits `current`, and if not, the first reason: the definition, a source (which), or the request itself.
 * A `current` without a hash only asks about the definition and the sources: a continuation asks for what is missing, not for what was asked first. */
export function checkpointStatus(saved, current) {
  if (!saved?.hash) return { valid: false, reason: 'none' };
  if (saved.version !== current.version || saved.definition !== current.definition) return { valid: false, reason: 'definition' };
  const before = new Map(saved.sources.map(source => [source.id, source.hash])), now = new Map(current.sources.map(source => [source.id, source.hash]));
  const changed = [...new Set([...before.keys(), ...now.keys()])].filter(id => before.get(id) !== now.get(id));
  if (changed.length) return { valid: false, reason: 'sources', changed };
  return !current.hash || saved.hash === current.hash ? { valid: true } : { valid: false, reason: 'request' };
}
