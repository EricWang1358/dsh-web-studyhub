/**
 * Retained projections are evidence for old citations; only a document's current revision belongs in a material picker.
 * Version membership is authoritative, including old imports whose source metadata names a different document owner.
 * Sources without a stored document remain ordinary legacy materials. These display markers are never persisted.
 */
export function stampSourceVersions(sources, documents = []) {
  const retained = new Set(), current = new Set();
  for (const document of documents || []) {
    for (const version of document.versions || []) {
      for (const id of version.sourceIds || []) {
        retained.add(id);
        if (version.revision === document.currentRevision) current.add(id);
      }
    }
  }
  return (sources || []).map(source => {
    if (!source || typeof source !== 'object') return source;
    if (!retained.has(source.id)) return source;
    if (!current.has(source.id)) return { ...source, historical: true };
    if (!source.historical) return source;
    const { historical: _historical, ...active } = source;
    return active;
  });
}
