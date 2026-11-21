/* Tree-reasoning retrieval ported in pure JS from MIT `VectifyAI/PageIndex`.
   Zero external binary dependencies, zero 90MB embedding downloads: directly reuses StudyHub's existing
   document `outline` chapter trees, converter chapters, course outlines, and Markdown/transcript headings.
   Returns the standard `lib/retrieval.js` `retrieve()` contract: `[{ sourceId, page, document, text, score }]`. */

import { currentInventory } from '../../../course-book-inventory.js';
import { resolveCourseNotationLedger } from '../inventory/notation-merge.js';
import { buildTermWhitelist, formMatchesText, meaningfulTokens, normLower, normSpace } from '../book/exam-scope-text.js';
import { buildDocumentTree } from './tree-build.js';
import { flattenTree, scoreTreeNodes } from './tree-score.js';
import { TREE_RETRIEVE_DEFAULTS, selectTreeNodesWithModel } from './tree-select.js';

export { TREE_RETRIEVE_DEFAULTS, buildDocumentTree, scoreTreeNodes, selectTreeNodesWithModel };

function focusedExcerpt(text, queryLower, queryTokens, maxChars) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length <= maxChars) return raw;
  const lower = raw.toLowerCase();
  let anchor = lower.indexOf(queryLower);
  if (anchor < 0) {
    for (const tok of queryTokens) {
      const idx = lower.indexOf(tok);
      if (idx >= 0 && (anchor < 0 || idx < anchor)) anchor = idx;
    }
  }
  if (anchor < 0) return raw.slice(0, maxChars).trimEnd();
  const start = Math.max(0, anchor - Math.floor(maxChars * 0.3));
  const end = Math.min(raw.length, start + maxChars);
  return raw.slice(start, end).trim();
}

function pageMatchScore(text, queryLower, queryTokens, whitelist) {
  const lower = normLower(text);
  if (!lower) return 0;
  let score = 0;
  if (formMatchesText(queryLower, lower, '')) score += 3.0;
  if (queryTokens.length) {
    const bag = new Set(meaningfulTokens(lower.slice(0, 8000), { whitelist }));
    let hits = 0;
    for (const tok of queryTokens) if (bag.has(tok) || formMatchesText(tok, lower, '')) hits++;
    score += 3.0 * (hits / queryTokens.length);
  }
  return score;
}

/**
 * Full PageIndex tree-reasoning retrieval with diagnostic trace.
 * Returns `{ hits: [{ sourceId, page, document, text, score }], selectedNodes, usedModel, reason, treeSize }`.
 */
export async function treeRetrieveWithTrace({
  query,
  sources = null,
  documents = null,
  state = null,
  course = null,
  sourceIds = null,
  limit = TREE_RETRIEVE_DEFAULTS.limit,
  completeLight = null,
  signal = undefined,
  whitelist = null,
  excerptChars = TREE_RETRIEVE_DEFAULTS.excerptChars,
  maxOutlineNodes = TREE_RETRIEVE_DEFAULTS.maxOutlineNodes,
  maxSelectedNodes = TREE_RETRIEVE_DEFAULTS.maxSelectedNodes,
} = {}) {
  const cleanQuery = normSpace(query);
  const cap = Math.max(1, Math.min(100, Math.round(Number(limit) || TREE_RETRIEVE_DEFAULTS.limit)));
  if (!cleanQuery) return { hits: [], selectedNodes: [], usedModel: false, reason: '', treeSize: 0 };

  const tree = buildDocumentTree({ state, sources, documents, course, sourceIds });
  const flatCount = flattenTree(tree.roots).length;
  if (!flatCount) return { hits: [], selectedNodes: [], usedModel: false, reason: '', treeSize: 0 };

  const derivedTerms = [];
  if (Array.isArray(whitelist)) derivedTerms.push(...whitelist);
  if (state && course) {
    derivedTerms.push(...resolveCourseNotationLedger(state, course, { max: 80 }));
    const inv = currentInventory(state.sources, course)?.courseInventory;
    if (Array.isArray(inv?.items)) derivedTerms.push(...inv.items);
  }
  const builtWhitelist = buildTermWhitelist(derivedTerms);

  const scored = scoreTreeNodes(tree, cleanQuery, { whitelist: builtWhitelist, inspectBody: true });
  const selection = await selectTreeNodesWithModel(tree, scored, cleanQuery, completeLight, {
    maxOutlineNodes,
    maxSelectedNodes: Math.max(maxSelectedNodes, Math.min(10, cap)),
    signal,
  });

  const selected = selection.selected;
  const queryLower = normLower(cleanQuery);
  const queryTokens = meaningfulTokens(cleanQuery, { whitelist: builtWhitelist });
  const bySource = new Map();

  for (const entry of selected) {
    const { node, score: nodeScore, pageRange } = entry;
    for (const id of node.sourceIds || []) {
      const src = tree.sourcesById.get(id);
      if (!src || typeof src.text !== 'string' || !src.text.trim()) continue;
      const info = tree.pageIndexBySourceId.get(id);
      const page = info?.page ?? (Number.isInteger(src.document?.page) ? src.document.page : 1);
      if (pageRange && (page < pageRange.startPage || page > pageRange.endPage)) continue;

      const pScore = pageMatchScore(src.text, queryLower, queryTokens, builtWhitelist);
      const depthBonus = Math.min(0.4, (node.level - 1) * 0.15);
      const rawScore = nodeScore + pScore + depthBonus;
      const prev = bySource.get(id);
      if (!prev || rawScore > prev.rawScore) {
        bySource.set(id, {
          sourceId: id,
          page,
          document: info?.document || node.document || src.title || id,
          text: focusedExcerpt(src.text, queryLower, queryTokens, excerptChars),
          rawScore,
        });
      }
    }
  }

  const ranked = [...bySource.values()]
    .sort((a, b) => b.rawScore - a.rawScore || a.page - b.page || a.sourceId.localeCompare(b.sourceId))
    .slice(0, cap);

  const topScore = ranked[0]?.rawScore || 1;
  const hits = ranked.map(({ rawScore, ...hit }) => ({
    ...hit,
    score: Math.round(Math.min(1, Math.max(0.01, rawScore / Math.max(topScore, 1))) * 10000) / 10000,
  }));

  return {
    hits,
    selectedNodes: selected.map(s => ({
      nodeId: s.node.nodeId,
      title: s.node.title,
      document: s.node.document,
      startPage: s.pageRange?.startPage ?? s.node.startPage,
      endPage: s.pageRange?.endPage ?? s.node.endPage,
      score: s.score,
    })),
    usedModel: selection.usedModel,
    reason: selection.reason,
    treeSize: flatCount,
  };
}

/** Standard `retrieve()` contract function returning `[{ sourceId, page, document, text, score }]`. */
export async function treeRetrieve(request = {}) {
  const { hits } = await treeRetrieveWithTrace(request);
  return hits;
}

/** Factory for a drop-in `studyRetrieval` service provider backed purely by StudyHub's document outline trees. */
export function createTreeRetriever(stateOrGetter, { completeLight = null, whitelist = null, excerptChars } = {}) {
  return {
    async retrieve({ query, sourceIds, course, limit = TREE_RETRIEVE_DEFAULTS.limit, signal } = {}) {
      const state = typeof stateOrGetter === 'function' ? await stateOrGetter() : stateOrGetter;
      return treeRetrieve({
        query,
        state,
        sourceIds,
        course,
        limit,
        completeLight,
        signal,
        whitelist,
        ...(excerptChars !== undefined ? { excerptChars } : {}),
      });
    },
  };
}
