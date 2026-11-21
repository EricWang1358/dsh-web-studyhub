/* Tree construction helpers for PageIndex-style outline retrieval. */

import { groupSourcesByDocument } from '../../../source-groups.js';
import { segmentationViews, stampSegmentations } from '../../../document-outline.js';
import { sectionsOf } from '../../../sections.js';
import { currentCourseOutline } from '../../../course-outline-book.js';
import { compactKey, normLower, normSpace } from '../book/exam-scope-text.js';

function findDocumentOutline(doc, rawSourcesById, documents) {
  if (doc.documentId && Array.isArray(documents)) {
    const record = documents.find(item => item && item.id === doc.documentId);
    const version = record?.versions?.find(v => v && v.revision === record.currentRevision);
    if (Array.isArray(version?.outline?.entries) && version.outline.entries.length) return version.outline;
  }
  for (const id of doc.sourceIds || []) {
    const raw = rawSourcesById.get(id);
    if (Array.isArray(raw?.outline?.entries) && raw.outline.entries.length) return raw.outline;
  }
  return null;
}

function nestNodesByLevel(flatNodes) {
  const roots = [], stack = [];
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
    let startPage = node.startPage, endPage = node.endPage;
    for (const child of node.children) {
      for (const id of child.sourceIds || []) ids.add(id);
      if (Number.isInteger(child.startPage)) startPage = Number.isInteger(startPage) ? Math.min(startPage, child.startPage) : child.startPage;
      if (Number.isInteger(child.endPage)) endPage = Number.isInteger(endPage) ? Math.max(endPage, child.endPage) : child.endPage;
    }
    node.sourceIds = [...ids].sort((a, b) => (pageIndexBySourceId.get(a)?.order ?? 0) - (pageIndexBySourceId.get(b)?.order ?? 0));
    if (!Number.isInteger(startPage) && node.sourceIds.length) startPage = pageIndexBySourceId.get(node.sourceIds[0])?.page ?? 1;
    if (!Number.isInteger(endPage) && node.sourceIds.length) endPage = pageIndexBySourceId.get(node.sourceIds.at(-1))?.page ?? startPage ?? 1;
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
      nodeId: nextId(), title: entry.title, level: entry.level, docKey: doc.key, document: doc.title,
      startPage, endPage, sourceIds: spanIds, intro: entry.intro, children: [],
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
      nodeId: nextId(), title: normSpace(ch.title) || doc.title, level: Math.max(1, Math.min(4, Number(ch.level) || 1)),
      docKey: doc.key, document: doc.title, startPage, endPage: Math.max(startPage, endPage), sourceIds: spanIds, intro: '', children: [],
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
      nodeId: nextId(), title: normSpace(doc.title) || spanIds[0] || 'Document', level: 1,
      docKey: doc.key, document: doc.title, startPage, endPage, sourceIds: spanIds, intro: '', children: [],
    }];
  }
  const flat = sections.map(sec => {
    const page = pageIndexBySourceId.get(sec.sourceId)?.page ?? 1;
    return {
      nodeId: nextId(), title: normSpace(sec.title), level: Math.max(1, Math.min(4, Number(sec.level) || 1)),
      docKey: doc.key, document: doc.title, startPage: page, endPage: page, sourceIds: [sec.sourceId], intro: '', children: [],
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

/** Build a unified PageIndex-style hierarchical document outline tree from StudyHub's existing outlines, chapters, and headings. */
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
