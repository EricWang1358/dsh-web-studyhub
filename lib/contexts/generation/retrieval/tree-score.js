/* Deterministic PageIndex-style tree node scoring and propagation. */

import {
  buildTermWhitelist,
  compactKey,
  formMatchesText,
  meaningfulTokens,
  normLower,
  normSpace,
} from '../book/exam-scope-text.js';

export function flattenTree(roots, parentPath = [], out = []) {
  for (const node of roots || []) {
    const path = [...parentPath, node.title];
    out.push({ node, path, parentId: parentPath.length ? out.findLast(item => item.path.length === parentPath.length)?.node.nodeId ?? null : null });
    if (node.children?.length) flattenTree(node.children, path, out);
  }
  return out;
}

function extractNodeSnippet(node, sourcesById, maxChars = 4000) {
  const parts = [];
  let total = 0;
  const ids = node.sourceIds || [];
  const perSource = Math.max(240, Math.floor(maxChars / Math.max(1, ids.length)));
  for (const id of ids) {
    const text = sourcesById?.get(id)?.text;
    if (typeof text !== 'string' || !text) continue;
    const take = text.slice(0, Math.min(perSource, maxChars - total));
    parts.push(take);
    total += take.length;
    if (total >= maxChars) break;
  }
  return parts.join('\n');
}

/**
 * Deterministic PageIndex-style tree node relevance scorer using Node 22 `Intl.Segmenter('zh')`,
 * IDF-weighted token overlap, exact/compact phrase matching, and parent-child score propagation.
 */
export function scoreTreeNodes(tree, query, { whitelist = [], inspectBody = true } = {}) {
  const cleanQuery = normSpace(query);
  if (!cleanQuery || !tree?.roots?.length) return [];
  const terms = buildTermWhitelist(whitelist);
  const queryLower = normLower(cleanQuery);
  const queryCompact = compactKey(cleanQuery);
  const queryTokens = meaningfulTokens(cleanQuery, { whitelist: terms });
  const flat = flattenTree(tree.roots);
  if (!flat.length) return [];

  const docFreq = new Map();
  const nodeMeta = flat.map(entry => {
    const { node, path } = entry;
    const titleLower = normLower(node.title);
    const titleCompact = compactKey(node.title);
    const pathLower = normLower(path.join(' '));
    const introLower = normLower(node.intro || '');
    const titleTokens = new Set(meaningfulTokens(node.title, { whitelist: terms }));
    const metaTokens = new Set(meaningfulTokens(`${path.join(' ')} ${node.intro || ''}`, { whitelist: terms }));
    const bodyText = inspectBody ? extractNodeSnippet(node, tree.sourcesById) : '';
    const bodyLower = normLower(bodyText);
    const bodyTokens = inspectBody && bodyLower ? new Set(meaningfulTokens(bodyLower, { whitelist: terms })) : new Set();
    const combined = new Set([...titleTokens, ...metaTokens, ...bodyTokens]);
    for (const tok of combined) docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
    return { ...entry, titleLower, titleCompact, pathLower, introLower, titleTokens, metaTokens, bodyLower, bodyTokens };
  });

  const totalNodes = nodeMeta.length;
  const idfOf = token => Math.log(1 + (totalNodes + 1) / (1 + (docFreq.get(token) || 0)));
  const totalQueryIdf = queryTokens.reduce((sum, tok) => sum + idfOf(tok), 0) || 1;

  const directById = new Map();
  for (const item of nodeMeta) {
    let score = 0;
    const matched = [];
    if (formMatchesText(queryLower, item.titleLower, item.titleCompact) || (queryCompact.length >= 4 && item.titleCompact.includes(queryCompact))) {
      score += 6.0;
    } else if (formMatchesText(queryLower, item.introLower, compactKey(item.introLower))) {
      score += 4.0;
    } else if (inspectBody && formMatchesText(queryLower, item.bodyLower, '')) {
      score += 3.0;
    }

    let titleHitIdf = 0;
    let metaHitIdf = 0;
    let bodyHitIdf = 0;
    for (const tok of queryTokens) {
      const w = idfOf(tok);
      if (item.titleTokens.has(tok) || formMatchesText(tok, item.titleLower, item.titleCompact)) {
        titleHitIdf += w;
        matched.push(tok);
      } else if (item.metaTokens.has(tok) || formMatchesText(tok, item.pathLower, '') || formMatchesText(tok, item.introLower, '')) {
        metaHitIdf += w;
        matched.push(tok);
      } else if (inspectBody && (item.bodyTokens.has(tok) || formMatchesText(tok, item.bodyLower, ''))) {
        bodyHitIdf += w;
        matched.push(tok);
      }
    }
    score += 4.5 * (titleHitIdf / totalQueryIdf);
    score += 2.2 * (metaHitIdf / totalQueryIdf);
    score += 2.5 * (bodyHitIdf / totalQueryIdf);
    directById.set(item.node.nodeId, { item, directScore: score, matched: [...new Set(matched)] });
  }

  const propagated = new Map();
  const walkDown = (nodes, inherited = 0) => {
    let bestInSubtree = 0;
    for (const node of nodes) {
      const entry = directById.get(node.nodeId);
      const own = (entry?.directScore || 0) + inherited;
      const childBest = node.children.length ? walkDown(node.children, own * 0.25) : 0;
      const finalScore = Math.max(own, childBest * 0.75);
      propagated.set(node.nodeId, {
        node,
        path: entry?.item.path || [node.title],
        directScore: entry?.directScore || 0,
        score: Math.round(finalScore * 10000) / 10000,
        matched: entry?.matched || [],
      });
      if (finalScore > bestInSubtree) bestInSubtree = finalScore;
    }
    return bestInSubtree;
  };
  walkDown(tree.roots, 0);

  return [...propagated.values()]
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.directScore - a.directScore || a.node.startPage - b.node.startPage || a.node.nodeId.localeCompare(b.node.nodeId));
}
