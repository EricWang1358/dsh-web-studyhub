// @ts-check

/**
 * Normalize selection/annotation passage keys so `sourceId|start|end|quote` and `sourceId|start|end`
 * deduplicate consistently while preserving synthetic keys that lack structured offsets.
 */
const normalizePassageKey = (key, selection) => {
  if (selection && selection.sourceId != null && Number.isFinite(selection.start) && Number.isFinite(selection.end)) {
    return `${selection.sourceId}|${selection.start}|${selection.end}`;
  }
  return String(key || '');
};

const nodeStep = (node) => {
  if (node?.term) return String(node.term).trim();
  if (node?.label) return String(node.label).trim();
  const question = String(node?.question || '').replace(/\s+/g, ' ').trim();
  return question.length > 24 ? `${question.slice(0, 23)}…` : question;
};

const nodeAncestors = (node, byId, fallbackById = null) => {
  const chain = [];
  const seen = new Set(node?.id ? [node.id] : []);
  let parentId = node?.parentId || null;
  while (parentId && !seen.has(parentId) && chain.length < 8) {
    seen.add(parentId);
    const parent = byId.get(parentId) || fallbackById?.get(parentId) || null;
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.parentId || null;
  }
  return chain;
};

/**
 * Pure 0-token collector for `DocumentLearning`'s opt-in Doubt Ledger (`settings.practice.readerDoubtLedger`).
 * Merges session-held threads (`thread-memory.js`) and kept passage annotations (`annotation.items`) into a
 * deduplicated recall/conversion list shown when no text selection is currently active.
 *
 * @param {{ annotationItems?: Array<Record<string, any>>, heldEntries?: Array<{ key: string, thread: Record<string, any>, saved?: Set<string>, selection?: Record<string, any> | null }> }} [opts]
 * @returns {Array<{ id: string, key: string, question: string, trail: string, answer: string, quote: string, selection: Record<string, any> | null, kept: boolean }>}
 */
export function collectReaderDoubts({ annotationItems = [], heldEntries = [] } = {}) {
  const kept = Array.isArray(annotationItems)
    ? annotationItems.filter((item) => item && item.status !== 'stale' && String(item.answer || '').trim())
    : [];
  const keptIds = new Set(kept.map((item) => item.id).filter(Boolean));
  const keptById = new Map(kept.filter((item) => item.id).map((item) => [item.id, item]));
  const keptEntries = kept.map((item) => {
    const ancestors = nodeAncestors(item, keptById);
    const trail = ancestors.map(nodeStep).filter(Boolean).join(' › ');
    const question = String(item.label || item.question || '').trim();
    const normKey = normalizePassageKey(item.key, item.selection);
    const sig = [normKey, ...ancestors.map((a) => String(a.label || a.question || '').trim()), question].join('\0');
    return { item, trail, question, sig };
  });
  const keptSigs = new Set(keptEntries.map((entry) => entry.sig));
  const out = [];
  const seenSig = new Set();

  if (Array.isArray(heldEntries)) {
    for (const entry of heldEntries) {
      if (!entry?.thread?.nodes?.length || String(entry.key || '').startsWith('page|')) continue;
      const selection = entry.selection && entry.selection.quote ? entry.selection : null;
      const normKey = normalizePassageKey(entry.key, selection);
      const localById = new Map(entry.thread.nodes.filter((n) => n?.id).map((n) => [n.id, n]));
      for (const node of entry.thread.nodes) {
        if (!node || node.status !== 'answered' || !String(node.answer || '').trim()) continue;
        if (keptIds.has(node.id) || entry.saved?.has?.(node.id)) continue;
        const ancestors = nodeAncestors(node, localById, keptById);
        const trail = ancestors.map(nodeStep).filter(Boolean).join(' › ');
        const question = String(node.label || node.question || '').trim();
        const sig = [normKey, ...ancestors.map((a) => String(a.label || a.question || '').trim()), question].join('\0');
        if (keptSigs.has(sig) || seenSig.has(sig)) continue;
        seenSig.add(sig);
        out.push({
          id: node.id || sig,
          key: entry.key,
          question,
          trail,
          answer: String(node.answer),
          quote: String(selection?.quote || '').trim(),
          selection,
          kept: false,
        });
      }
    }
  }

  for (const { item, trail, question, sig } of keptEntries) {
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);
    out.push({
      id: item.id || sig,
      key: String(item.key || ''),
      question,
      trail,
      answer: String(item.answer),
      quote: String(item.selection?.quote || '').trim(),
      selection: item.selection || null,
      kept: true,
    });
  }

  return out;
}
