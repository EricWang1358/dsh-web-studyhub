/* Tree-reasoning retrieval ported in pure JS from MIT `VectifyAI/PageIndex`.
   Zero external binary dependencies, zero 90MB embedding downloads: directly reuses StudyHub's existing
   document `outline` chapter trees, converter chapters, course outlines, and Markdown/transcript headings.
   Stage 1 scores tree nodes deterministically using Node 22 native `Intl.Segmenter('zh')` + course glossary/notation
   whitelist. Stage 2 optionally routes a compact outline tree through a light model (`completeLight`) to refine exact
   tree nodes and page ranges, falling back seamlessly to deterministic ranking. Always returns the standard
   `lib/retrieval.js` `retrieve()` contract: `[{ sourceId, page, document, text, score }]`. */

import { groupSourcesByDocument } from '../../../source-groups.js';
import { segmentationViews, stampSegmentations } from '../../../document-outline.js';
import { sectionsOf } from '../../../sections.js';
import { currentCourseOutline } from '../../../course-outline-book.js';
import { currentInventory } from '../../../course-book-inventory.js';
import { resolveCourseNotationLedger } from '../inventory/notation-merge.js';
import {
  buildTermWhitelist,
  compactKey,
  formMatchesText,
  meaningfulTokens,
  normLower,
  normSpace,
} from '../book/exam-scope-text.js';

export const TREE_RETRIEVE_DEFAULTS = Object.freeze({
  limit: 12,
  maxOutlineNodes: 48,
  maxSelectedNodes: 6,
  excerptChars: 1600,
});

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

function findDocumentOutline(doc, rawSourcesById, documents) {
  if (doc.documentId && Array.isArray(documents)) {
    const record = documents.find(item => item && item.id === doc.documentId);
    const version = record?.versions?.find(v => v && v.revision === record.currentRevision);
    if (Array.isArray(version?.outline?.entries) && version.outline.entries.length) {
      return version.outline;
    }
  }
  for (const id of doc.sourceIds || []) {
    const raw = rawSourcesById.get(id);
    if (Array.isArray(raw?.outline?.entries) && raw.outline.entries.length) {
      return raw.outline;
    }
  }
  return null;
}

function nestNodesByLevel(flatNodes) {
  const roots = [];
  const stack = [];
  for (const node of flatNodes) {
    while (stack.length && stack.at(-1).level >= node.level) stack.pop();
    if (stack.length) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function finalizeNodeSpans(nodes, pageIndexBySourceId) {
  for (const node of nodes) {
    if (node.children.length) finalizeNodeSpans(node.children, pageIndexBySourceId);
    const ids = new Set(node.sourceIds || []);
    let startPage = node.startPage;
    let endPage = node.endPage;
    for (const child of node.children) {
      for (const id of child.sourceIds || []) ids.add(id);
      if (Number.isInteger(child.startPage)) startPage = Number.isInteger(startPage) ? Math.min(startPage, child.startPage) : child.startPage;
      if (Number.isInteger(child.endPage)) endPage = Number.isInteger(endPage) ? Math.max(endPage, child.endPage) : child.endPage;
    }
    node.sourceIds = [...ids].sort((a, b) => (pageIndexBySourceId.get(a)?.order ?? 0) - (pageIndexBySourceId.get(b)?.order ?? 0));
    if (!Number.isInteger(startPage) && node.sourceIds.length) {
      startPage = pageIndexBySourceId.get(node.sourceIds[0])?.page ?? 1;
    }
    if (!Number.isInteger(endPage) && node.sourceIds.length) {
      endPage = pageIndexBySourceId.get(node.sourceIds.at(-1))?.page ?? startPage ?? 1;
    }
    node.startPage = startPage ?? 1;
    node.endPage = Math.max(node.startPage, endPage ?? node.startPage);
  }
}

function treeFromKeptOutline(doc, outline, pageIndexBySourceId, nextId) {
  const orderedIds = doc.sourceIds || [];
  const posById = new Map(orderedIds.map((id, i) => [id, i]));
  const entries = outline.entries
    .filter(entry => entry && typeof entry.title === 'string' && entry.title.trim() && entry.anchor?.sourceId && posById.has(entry.anchor.sourceId))
    .map((entry, idx) => ({
      title: normSpace(entry.title),
      level: Math.max(1, Math.min(4, Number(entry.level) || 1)),
      startIdx: posById.get(entry.anchor.sourceId),
      offset: Number(entry.anchor.offset) || 0,
      intro: typeof entry.intro === 'string' ? normSpace(entry.intro) : '',
      order: idx,
    }))
    .sort((a, b) => a.startIdx - b.startIdx || a.offset - b.offset || a.order - b.order);
  if (!entries.length) return [];

  const flat = entries.map((entry, idx) => {
    // A section runs until the next entry of equal or higher level (smaller or equal level number).
    let endIdx = orderedIds.length - 1;
    for (let j = idx + 1; j < entries.length; j++) {
      if (entries[j].level <= entry.level) {
        const nextStart = entries[j].startIdx;
        endIdx = entries[j].offset > 0 ? nextStart : Math.max(entry.startIdx, nextStart - 1);
        break;
      }
    }
    const spanIds = orderedIds.slice(entry.startIdx, Math.max(entry.startIdx + 1, endIdx + 1));
    const startPage = pageIndexBySourceId.get(spanIds[0])?.page ?? (entry.startIdx + 1);
    const endPage = pageIndexBySourceId.get(spanIds.at(-1))?.page ?? (endIdx + 1);
    return {
      nodeId: nextId(),
      title: entry.title,
      level: entry.level,
      docKey: doc.key,
      document: doc.title,
      startPage,
      endPage,
      sourceIds: spanIds,
      intro: entry.intro,
      children: [],
    };
  });
  const roots = nestNodesByLevel(flat);
  finalizeNodeSpans(roots, pageIndexBySourceId);
  return roots;
}

function treeFromChapters(doc, pageIndexBySourceId, nextId) {
  const chapters = (doc.chapters || []).filter(ch => !ch.front && (ch.sourceIds?.length || doc.sourceIds?.length));
  if (!chapters.length) return [];
  const flat = chapters.map(ch => {
    const spanIds = ch.sourceIds?.length ? [...ch.sourceIds] : [...(doc.sourceIds || [])];
    const startPage = Number.isInteger(ch.startPage) ? ch.startPage : (pageIndexBySourceId.get(spanIds[0])?.page ?? 1);
    const endPage = Number.isInteger(ch.endPage) ? ch.endPage : (pageIndexBySourceId.get(spanIds.at(-1))?.page ?? startPage);
    return {
      nodeId: nextId(),
      title: normSpace(ch.title) || doc.title,
      level: Math.max(1, Math.min(4, Number(ch.level) || 1)),
      docKey: doc.key,
      document: doc.title,
      startPage,
      endPage: Math.max(startPage, endPage),
      sourceIds: spanIds,
      intro: '',
      children: [],
    };
  });
  const roots = nestNodesByLevel(flat);
  finalizeNodeSpans(roots, pageIndexBySourceId);
  return roots;
}

function treeFromHeadings(doc, docSources, pageIndexBySourceId, nextId) {
  const sections = sectionsOf(docSources, { windows: false })
    .filter(sec => sec && (sec.kind === 'heading' || sec.kind === 'recording' || sec.kind === 'part') && sec.title);
  if (!sections.length) {
    const spanIds = [...(doc.sourceIds || [])];
    const startPage = pageIndexBySourceId.get(spanIds[0])?.page ?? 1;
    const endPage = pageIndexBySourceId.get(spanIds.at(-1))?.page ?? startPage;
    return [{
      nodeId: nextId(),
      title: normSpace(doc.title) || spanIds[0] || 'Document',
      level: 1,
      docKey: doc.key,
      document: doc.title,
      startPage,
      endPage,
      sourceIds: spanIds,
      intro: '',
      children: [],
    }];
  }
  const flat = sections.map(sec => {
    const info = pageIndexBySourceId.get(sec.sourceId);
    const page = info?.page ?? 1;
    return {
      nodeId: nextId(),
      title: normSpace(sec.title),
      level: Math.max(1, Math.min(4, Number(sec.level) || 1)),
      docKey: doc.key,
      document: doc.title,
      startPage: page,
      endPage: page,
      sourceIds: [sec.sourceId],
      intro: '',
      children: [],
    };
  });
  const roots = nestNodesByLevel(flat);
  finalizeNodeSpans(roots, pageIndexBySourceId);
  return roots;
}

function collectCourseOutlineIntros(state, course) {
  const introByTitle = new Map();
  if (!state || !course) return introByTitle;
  const outline = currentCourseOutline(state.sources, course)?.courseOutline;
  if (!outline?.nodes?.length) return introByTitle;
  const walk = list => {
    for (const node of list || []) {
      if (node?.title && node?.intro) introByTitle.set(compactKey(node.title), normSpace(node.intro));
      if (node?.children?.length) walk(node.children);
    }
  };
  walk(outline.nodes);
  return introByTitle;
}

/**
 * Build a unified PageIndex-style hierarchical document outline tree from StudyHub's existing
 * `outline` entries, converter chapters, course outline intros, and Markdown/transcript headings.
 * Pure, zero I/O, zero external dependencies.
 */
export function buildDocumentTree({ state = null, sources = null, documents = null, course = null, sourceIds = null } = {}) {
  const allSources = Array.isArray(sources) ? sources : (Array.isArray(state?.sources) ? state.sources : []);
  const allDocs = Array.isArray(documents) ? documents : (Array.isArray(state?.documents) ? state.documents : []);
  const filterSet = Array.isArray(sourceIds) && sourceIds.length ? new Set(sourceIds) : null;
  const courseLow = typeof course === 'string' && course.trim() && course !== '*' ? normLower(course) : '';

  const rawById = new Map(allSources.filter(s => s?.id).map(s => [s.id, s]));
  const filteredSources = allSources.filter(src => {
    if (!src || src.archived || src.historical) return false;
    if (filterSet && !filterSet.has(src.id)) return false;
    if (courseLow) {
      const courses = Array.isArray(src.courses) ? src.courses : (typeof src.course === 'string' && src.course ? [src.course] : []);
      if (courses.length && !courses.some(c => normLower(c) === courseLow)) return false;
    }
    return true;
  });

  const views = state ? segmentationViews(state) : [];
  const stamped = views.length ? stampSegmentations(filteredSources, views) : filteredSources;
  const grouped = groupSourcesByDocument(stamped, { documents: allDocs }).filter(doc => !doc.archived && doc.sourceIds.length);
  const introByTitle = collectCourseOutlineIntros(state, course);

  let seq = 0;
  const nextId = () => `n${++seq}`;
  const roots = [];
  const pageIndexBySourceId = new Map();

  for (const doc of grouped) {
    const docSources = doc.sourceIds.map(id => rawById.get(id)).filter(Boolean);
    doc.pages.forEach((p, idx) => {
      pageIndexBySourceId.set(p.sourceId, { page: p.page, order: idx, document: doc.title, docKey: doc.key });
    });
    const keptOutline = findDocumentOutline(doc, rawById, allDocs);
    let docRoots = keptOutline ? treeFromKeptOutline(doc, keptOutline, pageIndexBySourceId, nextId) : [];
    if (!docRoots.length && doc.chapters?.length) docRoots = treeFromChapters(doc, pageIndexBySourceId, nextId);
    if (!docRoots.length) docRoots = treeFromHeadings(doc, docSources, pageIndexBySourceId, nextId);

    const enrich = list => {
      for (const node of list) {
        if (!node.intro) {
          const intro = introByTitle.get(compactKey(node.title));
          if (intro) node.intro = intro;
        }
        if (node.children.length) enrich(node.children);
      }
    };
    enrich(docRoots);
    roots.push(...docRoots);
  }

  return { roots, sourcesById: rawById, pageIndexBySourceId };
}

function flattenTree(roots, parentPath = [], out = []) {
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

  // Compute IDF across tree nodes so rare domain terms outweigh generic words.
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

  // Top-down context propagation (parent boosts child) + bottom-up evidence propagation (child lifts parent).
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
  const system = 'You are a document outline tree navigator (PageIndex). Given a query and a compact chapter tree, pick the most relevant node ids and optional tight page ranges [startPage, endPage] within each chosen node. Return JSON only: {"nodeIds":["n1"],"pageRanges":[{"nodeId":"n1","startPage":1,"endPage":3}],"reason":"brief"}';
  const prompt = JSON.stringify({ query: normSpace(query), maxNodes: maxSelectedNodes, tree: outline });

  let parsed = null;
  try {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const raw = await completeLight(system, prompt, { maxTokens: 400, task: 'retrieval.tree', ...(signal ? { signal } : {}) });
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
    // Model-ranked nodes receive a rank-ordered boost blended with deterministic lexical score.
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

  // Prefer more specific (deeper) nodes when both a parent and its child are selected.
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
      // Leaf specificity bonus so a targeted subsection outranks a broad parent chapter on the same page.
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

/**
 * Standard `retrieve()` contract function returning `[{ sourceId, page, document, text, score }]`.
 * Compatible directly with `lib/retrieval.js` `normalizeHits()` and `resolveHits()`.
 */
export async function treeRetrieve(request = {}) {
  const { hits } = await treeRetrieveWithTrace(request);
  return hits;
}

/**
 * Factory for a drop-in `studyRetrieval` service provider (`{ retrieve(request) -> hits }`)
 * backed purely by StudyHub's document outline trees (zero external index or embedding download).
 */
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
