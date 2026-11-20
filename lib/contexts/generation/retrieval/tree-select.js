/* Optional PageIndex-style light-model tree node selection. */

import { normSpace } from '../book/exam-scope-text.js';
import { flattenTree } from './tree-score.js';

export const TREE_RETRIEVE_DEFAULTS = Object.freeze({
  limit: 12,
  maxOutlineNodes: 48,
  maxSelectedNodes: 6,
  excerptChars: 1600,
});

const TREE_NAVIGATOR_SYSTEM = [
  'You are a document outline tree navigator (PageIndex).',
  'Given a query and a compact chapter tree, pick the most relevant node ids and optional tight page ranges [startPage, endPage] within each chosen node.',
  'Return JSON only: {"nodeIds":["n1"],"pageRanges":[{"nodeId":"n1","startPage":1,"endPage":3}],"reason":"brief"}',
].join(' ');

const parseJsonLoose = raw => {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
};

function buildCompactOutlinePayload(roots, keepSet, maxNodes) {
  let count = 0;
  const project = list => {
    const out = [];
    for (const node of list || []) {
      if (count >= maxNodes) break;
      const children = project(node.children);
      if (keepSet && !keepSet.has(node.nodeId) && !children.length) continue;
      count++;
      out.push({
        id: node.nodeId,
        title: node.title,
        pages: [node.startPage, node.endPage],
        ...(node.intro ? { intro: node.intro.slice(0, 140) } : {}),
        ...(children.length ? { children } : {}),
      });
    }
    return out;
  };
  return project(roots);
}

/**
 * Optional PageIndex-style light-model tree node selection.
 * Sends ONLY the compact outline tree (never full document text), validates every returned `nodeId`
 * and `pageRange` against the real tree, and falls back cleanly on any model failure.
 */
export async function selectTreeNodesWithModel(tree, scoredNodes, query, completeLight, {
  maxOutlineNodes = TREE_RETRIEVE_DEFAULTS.maxOutlineNodes,
  maxSelectedNodes = TREE_RETRIEVE_DEFAULTS.maxSelectedNodes,
  signal = undefined,
} = {}) {
  if (typeof completeLight !== 'function' || !tree?.roots?.length) {
    return { usedModel: false, selected: scoredNodes.slice(0, maxSelectedNodes), reason: '' };
  }
  const allFlat = flattenTree(tree.roots);
  if (allFlat.length < 2) {
    return { usedModel: false, selected: scoredNodes.slice(0, maxSelectedNodes), reason: '' };
  }
  const nodeById = new Map(allFlat.map(item => [item.node.nodeId, item.node]));
  const scoredById = new Map(scoredNodes.map(item => [item.node.nodeId, item]));

  let keepSet = null;
  if (allFlat.length > maxOutlineNodes) {
    keepSet = new Set();
    for (const root of tree.roots) keepSet.add(root.nodeId);
    for (const item of scoredNodes.slice(0, Math.max(12, Math.floor(maxOutlineNodes * 0.6)))) {
      keepSet.add(item.node.nodeId);
    }
  }
  const outline = buildCompactOutlinePayload(tree.roots, keepSet, maxOutlineNodes);
  const prompt = JSON.stringify({ query: normSpace(query), maxNodes: maxSelectedNodes, tree: outline });

  let parsed = null;
  try {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const raw = await completeLight(TREE_NAVIGATOR_SYSTEM, prompt, { maxTokens: 400, task: 'retrieval.tree', ...(signal ? { signal } : {}) });
    parsed = parseJsonLoose(raw);
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    return { usedModel: false, selected: scoredNodes.slice(0, maxSelectedNodes), reason: '' };
  }

  const chosenIds = Array.isArray(parsed?.nodeIds)
    ? [...new Set(parsed.nodeIds.map(id => String(id ?? '').trim()).filter(id => nodeById.has(id)))].slice(0, maxSelectedNodes)
    : [];
  if (!chosenIds.length) {
    return { usedModel: false, selected: scoredNodes.slice(0, maxSelectedNodes), reason: '' };
  }

  const rangeByNode = new Map();
  for (const item of Array.isArray(parsed?.pageRanges) ? parsed.pageRanges : []) {
    const id = String(item?.nodeId ?? '').trim();
    const node = nodeById.get(id);
    if (!node) continue;
    const rawStart = Number(item.startPage);
    const rawEnd = Number(item.endPage);
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) continue;
    const startPage = Math.max(node.startPage, Math.min(node.endPage, rawStart));
    const endPage = Math.max(startPage, Math.min(node.endPage, rawEnd));
    rangeByNode.set(id, { startPage, endPage });
  }

  const selected = chosenIds.map((id, rank) => {
    const node = nodeById.get(id);
    const det = scoredById.get(id);
    const range = rangeByNode.get(id) || null;
    const modelScore = (maxSelectedNodes - rank) / maxSelectedNodes;
    const score = Math.round(((det?.score || 0) * 0.4 + modelScore * 6.0) * 10000) / 10000;
    return {
      node,
      path: det?.path || [node.title],
      directScore: det?.directScore || 0,
      score,
      matched: det?.matched || [],
      ...(range ? { pageRange: range } : {}),
    };
  });

  return {
    usedModel: true,
    selected,
    reason: typeof parsed?.reason === 'string' ? normSpace(parsed.reason).slice(0, 200) : '',
  };
}
