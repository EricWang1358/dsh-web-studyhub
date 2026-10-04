/* Materials as people think of them (plan §4 C5, P18): one item per document.
   A PDF is stored as one source per page so citations can point at a page;
   pages imported through materials.document.import (document.materialId) and
   through the older source.import path (document.id only) share the PDF's
   content hash and group into one item. A transcript split into volumes is one
   recording. Everything else is a single item. Pure, no I/O: the Sources page,
   the generation picker and the tour share it. */
import { isJsonCardSource } from './source-provenance.js';
import { stampSourceVersions } from './material-source-versions.js';

const PDF_MATERIAL = /^document-([a-f0-9]{64})-pdf$/;
const PAGE_SUFFIX = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;
const PART_SUFFIX = /\s\(\d+\/\d+\)$/;
const FORMATS = { pdf: 'pdf', docx: 'docx', pptx: 'pptx', md: 'md', markdown: 'md', html: 'html', htm: 'html', txt: 'txt' };
// Word and PowerPoint declare their format; a PowerPoint slide carries a page number like a PDF page but is not a PDF.
const OFFICE = new Set(['docx', 'pptx']);

const isPdf = source => {
  const document = source?.document;
  return !!document && !OFFICE.has(document.format) && (Number.isInteger(document.page) || document.format === 'pdf' || PDF_MATERIAL.test(document.materialId || ''));
};

/** pdf | docx | pptx | md | html | txt | audio | json | text — what kind of material a source came from. */
export function sourceFormat(source) {
  if (isPdf(source)) return 'pdf';
  const declared = FORMATS[String(source?.document?.format || '').toLowerCase()];
  if (declared) return declared;
  if (source?.audio) return 'audio';
  if (isJsonCardSource(source)) return 'json';
  return FORMATS[String(source?.format || '').toLowerCase()] === 'md' ? 'md' : 'text';
}

/** Only PDF pages from the first text parser need a fresh import; text documents never do. */
export const isLegacyExtraction = source => isPdf(source) && !(Number(source.document.extractionVersion) >= 2);

const charsOf = source => typeof source?.text === 'string' ? source.text.length : Number(source?.chars) || 0;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function keyOf(source) {
  const document = source.document;
  if (isPdf(source)) {
    const hash = document.id || PDF_MATERIAL.exec(document.materialId || '')?.[1];
    // A refreshed logical document may reuse another original's bytes; its pages must keep their own reader target.
    if (document.materialId && hash && document.materialId !== `document-${hash}-pdf`)
      return `pdf:${document.materialId}:${hash}`;
    return `pdf:${hash || document.materialId || source.id}`;
  }
  if (document?.materialId) return `doc:${document.materialId}`;
  const audio = source.audio;
  if (audio?.batch?.id) return `audio:${audio.batch.id}`;
  if (Array.isArray(audio?.sourceIds) && audio.sourceIds.length > 1) return `audio:${audio.sourceIds[0]}`;
  return `source:${source.id}`;
}

function titleOf(first, format) {
  const title = String(first.title ?? '');
  if (format === 'pdf') return first.document.bookTitle || first.document.filename || title.replace(PAGE_SUFFIX, '');
  if (format === 'pptx') return title.replace(PAGE_SUFFIX, '') || first.document.filename || title;
  if (format === 'audio') return first.audio?.batch?.title || title.replace(PART_SUFFIX, '');
  return title;
}

function pageOf(source, index, format) {
  if ((format === 'pdf' || format === 'pptx') && Number.isInteger(source.document.page)) return source.document.page;
  if (format === 'audio' && Number.isInteger(source.audio?.batch?.volume)) return source.audio.batch.volume;
  return index + 1;
}

const unique = (values, key = value => value) => [...new Map(values.map(value => [key(value), value])).values()];

/* Chapters of a converted book (WP28): pages grouped by the chapter they were stored under, in page order.
   Pages before the first chapter form a front-matter group (index -1). Empty when the book has no chapters. */
function chaptersOf(ordered) {
  const groups = new Map();
  for (const { source, page } of ordered) {
    const chapter = source.document?.chapter;
    const index = Number.isInteger(chapter?.index) ? chapter.index : -1;
    if (!groups.has(index)) groups.set(index, { index, title: index < 0 ? '' : String(chapter.title ?? ''), level: index < 0 ? 0 : Number(chapter.level) || 1,
      front: index < 0, startPage: page, endPage: page, sourceIds: [], chars: 0 });
    const group = groups.get(index);
    group.startPage = Math.min(group.startPage, page); group.endPage = Math.max(group.endPage, page);
    group.sourceIds.push(source.id); group.chars += charsOf(source);
  }
  return groups.size > 1 || (groups.size === 1 && !groups.has(-1)) ? [...groups.values()].sort((a, b) => a.startPage - b.startPage || a.index - b.index) : [];
}

/* Chapters the learner chose (a kept outline applied as the document's segmentation; lib/document-outline.js). The view is
   stamped on the document's first source and holds while its pages are exactly this document's pages. Pages follow the
   chapter that contains their START; a chapter that starts inside a page remembers where (startSourceId, startOffset) and
   holds no page of its own unless a later page starts inside it. Pages before the first chapter are front matter. */
function chaptersFromSegmentation(ordered, segmentation) {
  const position = new Map(ordered.map((entry, index) => [entry.source.id, index]));
  const starts = (segmentation.chapters || []).map(chapter => ({ chapter, at: position.get(chapter.sourceId), offset: Number(chapter.offset) || 0 }))
    .filter(start => start.at !== undefined).sort((a, b) => a.at - b.at || a.offset - b.offset);
  if (!starts.length) return [];
  const groups = starts.map(({ chapter, at, offset }) => ({ index: chapter.index, title: String(chapter.title ?? ''), level: Number(chapter.level) || 1, front: false,
    startPage: ordered[at].page, endPage: ordered[at].page, sourceIds: [], chars: 0, startSourceId: chapter.sourceId, startOffset: offset, partial: offset > 0 }));
  const front = { index: -1, title: '', level: 0, front: true, startPage: 0, endPage: 0, sourceIds: [], chars: 0 };
  if (ordered.length === 1) {
    // One text (Markdown, Word, a transcript, a pasted note): the chapters are places inside it and hold no whole source, so
    // generation stays whole-document; their sizes come from where they start.
    const { source, page } = ordered[0], total = charsOf(source);
    groups.forEach((group, index) => { group.chars = Math.max(0, (index + 1 < starts.length ? starts[index + 1].offset : total) - starts[index].offset); });
    return starts[0].offset > 0 ? [{ ...front, startPage: page, endPage: page, chars: starts[0].offset }, ...groups] : groups;
  }
  let owner = -1;
  ordered.forEach(({ source, page }, at) => {
    while (owner + 1 < starts.length && (starts[owner + 1].at < at || (starts[owner + 1].at === at && starts[owner + 1].offset === 0))) owner += 1;
    const group = owner < 0 ? front : groups[owner];
    if (owner < 0 && !group.sourceIds.length) group.startPage = page;
    group.sourceIds.push(source.id); group.chars += charsOf(source); group.endPage = Math.max(group.endPage, page);
  });
  return front.sourceIds.length ? [front, ...groups] : groups;
}

/** The stamped segmentation of a document, when it still describes exactly these pages. */
function segmentationOf(members) {
  const stamped = members.find(source => source.segmentation && typeof source.segmentation === 'object')?.segmentation;
  if (!stamped || !Array.isArray(stamped.chapters) || !stamped.chapters.length || !Array.isArray(stamped.sourceIds)) return null;
  const ids = new Set(members.map(source => source.id));
  return stamped.sourceIds.length === ids.size && stamped.sourceIds.every(id => ids.has(id)) ? stamped : null;
}

function describe(key, members) {
  const format = sourceFormat(members[0]);
  // Pages in reading order; equal page numbers keep their input order.
  const ordered = members.map((source, index) => ({ source, index, page: pageOf(source, index, format) }))
    .sort((a, b) => (format === 'pdf' || format === 'pptx' || format === 'audio' ? a.page - b.page : 0) || a.index - b.index);
  const sources = ordered.map(entry => entry.source);
  const material = sources.find(source => source.document?.materialId)?.document.materialId;
  const pdfHash = format === 'pdf' ? key.slice(4) : '';
  const dated = sources.filter(source => validDate(source.createdAt));
  const newest = dated.reduce((best, source) => !best || source.createdAt > best.createdAt ? source : best, null);
  const warnings = new Set();
  for (const source of sources) {
    if (source.document?.warnings?.length) warnings.add('layout');
    if (source.document?.sparseText) warnings.add('sparse');
    if (isLegacyExtraction(source)) warnings.add('legacy-extraction');
  }
  const totalPages = Math.max(0, ...sources.map(source => Number(source.document?.totalPages) || 0));
  const converted = sources.find(source => source.document?.origin === 'converted')?.document.converter;
  // The learner's segmentation wins over the converter's own chapters; a document with neither has no chapters.
  const segmentation = segmentationOf(members);
  const chapters = segmentation ? chaptersFromSegmentation(ordered, segmentation) : converted ? chaptersOf(ordered) : [];
  const chapterUnit = format === 'pdf' || format === 'pptx' ? 'page' : sources.length > 1 ? 'part' : 'text';
  const filename = sources.find(source => typeof source.document?.filename === 'string' && source.document.filename)?.document.filename;
  const renamedFrom = sources.find(source => typeof source.renamedFrom === 'string' && source.renamedFrom)?.renamedFrom;
  const item = {
    key,
    documentId: material || (format === 'pdf' && /^[a-f0-9]{64}$/.test(pdfHash) ? `legacy-${pdfHash}` : null),
    title: titleOf(sources[0], format),
    format,
    archived: sources.every(source => source.archived === true),
    sourceIds: sources.map(source => source.id),
    pages: ordered.map(({ source, page }) => ({ sourceId: source.id, page, chars: charsOf(source), title: source.title,
      ...(isLegacyExtraction(source) ? { legacy: true } : {}) })),
    chars: sources.reduce((sum, source) => sum + charsOf(source), 0),
    createdAt: newest?.createdAt,
    createdAtInferred: dated.length > 0 && dated.every(source => source.createdAtInferred),
    courses: unique(sources.flatMap(source => source.courses || [])),
    coursesInferred: sources.some(source => source.coursesInferred),
    usedBy: unique(sources.flatMap(source => source.usedBy || []), deck => `${deck.kind}:${deck.id}`),
    warnings: [...warnings],
    excerpt: String(sources[0].excerpt ?? sources[0].text ?? '').slice(0, 160),
    ...(totalPages ? { totalPages } : {}),
    ...(filename ? { filename } : {}),
    ...(renamedFrom ? { renamedFrom } : {}),
    ...(converted ? { converted } : {}),
    ...(chapters.length ? { chapters, chapterUnit } : {}),
    ...(segmentation && chapters.length ? { segmentation: { level: segmentation.level, revision: segmentation.revision, savedAt: segmentation.savedAt } } : {}),
  };
  if (sources.some(source => source.sample === true || String(source.id).startsWith('sample-'))) item.sample = true;
  return item;
}

/**
 * [{ key, documentId, title, format, sourceIds, pages:[{sourceId,page,chars,title,legacy?}],
 *    chars, createdAt, createdAtInferred, courses, coursesInferred, usedBy, warnings, excerpt, totalPages?, sample?,
 *    filename? (the original file name), renamedFrom? (what the document was called before its first rename; 恢复原名 goes back to it),
 *    converted? (converter name), chapters? [{ index, title, level, front, startPage, endPage, sourceIds, chars }],
 *    chapterUnit? ('page' | 'part' | 'text'), segmentation? { level, revision, savedAt } (the chapters are the learner's: a kept outline
 *    applied; each chapter then also has startSourceId, startOffset, partial) }]
 * Items keep the order in which their first source appears; pages are in page order.
 */
export function groupSourcesByDocument(sources, { documents } = {}) {
  const groups = new Map();
  for (const source of stampSourceVersions(Array.isArray(sources) ? sources : [], documents)) {
    if (!source || typeof source !== 'object') continue;
    if (source.historical) continue;
    const key = keyOf(source);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }
  return [...groups].map(([key, members]) => describe(key, members));
}

/** How many materials a learner sees (the nav badge counts documents, not pages). */
export const countDocuments = sources => groupSourcesByDocument(sources).filter(item => !item.archived).length;

/** Every source id of the document that contains `sourceId` (a page opens as its whole PDF). */
export function documentSourceIds(sources, sourceId) {
  const item = groupSourcesByDocument(sources).find(group => group.sourceIds.includes(sourceId));
  return item ? item.sourceIds : [sourceId];
}
