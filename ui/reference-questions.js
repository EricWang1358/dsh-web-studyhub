import { normalizeQuestionReferenceFormat, normalizeQuestionReferenceLimits } from '../lib/question-references.js';

/** Optional style examples are selected independently of factual source material. */
export function referenceSelection(sources = [], ids = [], evidenceIds = [], referenceLimits, referenceFormat) {
  const selected = [...new Set(ids)];
  const available = new Map(sources.map(source => [source.id, source]));
  const evidence = new Set(evidenceIds);
  const chars = selected.reduce((sum, id) => {
    const source = available.get(id);
    return sum + (typeof source?.text === 'string' ? source.text.length : Number(source?.chars) || 0);
  }, 0);
  let limits;
  try { limits = normalizeQuestionReferenceLimits(referenceLimits); } catch { /* the UI keeps invalid edits visible */ }
  let format;
  try { format = normalizeQuestionReferenceFormat(referenceFormat); } catch { /* ask for a valid format choice */ }
  const reason = !limits ? 'limits' : !format ? 'format' : selected.some(id => !available.has(id)) ? 'missing'
    : selected.some(id => evidence.has(id)) ? 'overlap'
      : selected.length > limits.sources || chars > limits.chars ? 'size' : '';
  return { ids: selected, chars, reason };
}

/** Imported examples stay out of the factual selection, including duplicate imports. */
export function importedReferences(current = [], imported = [], evidence = []) {
  const ids = [...new Set([...current, ...imported])];
  const references = new Set(ids);
  return { referenceSourceIds: ids, sourceIds: evidence.filter(id => !references.has(id)) };
}
