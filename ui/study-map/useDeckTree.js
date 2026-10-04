import { useCallback, useEffect, useState } from 'react';
import { applySelection, defaultExpanded, readExpanded, scopeOf, toggleInSet, writeExpanded } from './map-model.js';

/**
 * The deck tree's own state: which courses and decks are folded open (kept per
 * library in this browser) and which decks or topics are ticked for a study
 * scope. `scope` is the selection as the scope list `start` and the graph take.
 */
export function useDeckTree(root, decks) {
  const [expanded, setExpanded] = useState(() => readExpanded(root) || defaultExpanded(decks));
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => { writeExpanded(root, expanded); }, [root, expanded]);
  const toggleOpen = useCallback((id) => setExpanded((previous) => toggleInSet(previous, id)), []);
  const toggleSelect = useCallback((keys, on) => setSelected((previous) => applySelection(previous, keys, on)), []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  return { expanded, toggleOpen, selected, toggleSelect, clearSelection, scope: scopeOf(selected) };
}

export default useDeckTree;
