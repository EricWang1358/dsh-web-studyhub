import type { StudySnapshot } from '../../types/contracts.js';
import type { Tone } from '../../theme/tokens.js';

export interface MaterialFoldersState {
  folders: string[];
  items: Record<string, string>;
}

export interface DocumentGroup {
  key: string;
  documentId?: string;
  title: string;
  format: string;
  pageCount: number;
  sourceIds: string[];
  pages: Array<{ sourceId: string; page: number; title: string; chars: number }>;
  courses: string[];
  folder?: string;
  cardCount: number;
  chars: number;
  pinned: boolean;
  archived: boolean;
  updatedAt?: string | number;
}

type RawSource = NonNullable<StudySnapshot['sources']>[number];

const PDF_MAT_RE = /^document-([a-f0-9]{64})-pdf$/;
const PAGE_SUFFIX_RE = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;
const PART_SUFFIX_RE = /\s\(\d+\/\d+\)$/;
const OFFICE_FORMATS = new Set(['docx', 'pptx', 'ppt']);
// Reuse one Collator instead of invoking String#localeCompare thousands of times inside sort().
const TITLE_COLLATOR = new Intl.Collator();

const FORMAT_MAP: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  ppt: 'ppt',
  md: 'md',
  markdown: 'md',
  tex: 'tex',
  latex: 'tex',
  ltx: 'tex',
  html: 'html',
  htm: 'html',
  txt: 'txt',
};

function baseNameOnly(value: string): string {
  const s = String(value || '').trim();
  if (!s) return '未命名资料';
  const parts = s.split(/[\\/]+/);
  return parts[parts.length - 1] || s;
}

function asDocMeta(source: RawSource): Record<string, unknown> | undefined {
  const doc = (source as Record<string, unknown>).document;
  return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : undefined;
}

function asAudioMeta(source: RawSource): Record<string, unknown> | undefined {
  const audio = (source as Record<string, unknown>).audio;
  return audio && typeof audio === 'object' ? (audio as Record<string, unknown>) : undefined;
}

function isPdfDoc(doc: Record<string, unknown> | undefined): boolean {
  if (!doc) return false;
  const rawFmt = doc.format;
  const fmt = typeof rawFmt === 'string' ? rawFmt.toLowerCase() : String(rawFmt || '').toLowerCase();
  if (OFFICE_FORMATS.has(fmt)) return false;
  return Number.isInteger(doc.page) || fmt === 'pdf' || PDF_MAT_RE.test(String(doc.materialId || ''));
}

function detectFormatWithMeta(
  source: RawSource,
  doc: Record<string, unknown> | undefined,
  isPdf: boolean,
): string {
  if (isPdf) return 'pdf';
  if (doc && typeof doc.format === 'string') {
    const declared = FORMAT_MAP[doc.format.toLowerCase()];
    if (declared) return declared;
  } else if (doc?.format) {
    const declared = FORMAT_MAP[String(doc.format).toLowerCase()];
    if (declared) return declared;
  }
  if (asAudioMeta(source)) return 'audio';
  const legacyRaw = source.format || source.ext;
  const legacy = legacyRaw ? FORMAT_MAP[String(legacyRaw).toLowerCase()] : undefined;
  return legacy || 'text';
}

export function detectSourceFormat(source: RawSource): string {
  const doc = asDocMeta(source);
  return detectFormatWithMeta(source, doc, isPdfDoc(doc));
}

function isCanonicalPdfMaterialId(matId: string, hash: string): boolean {
  return (
    matId.length === 13 + hash.length &&
    matId.startsWith('document-') &&
    matId.endsWith('-pdf') &&
    matId.indexOf(hash, 9) === 9
  );
}

function groupKeyWithMeta(
  source: RawSource,
  doc: Record<string, unknown> | undefined,
  isPdf: boolean,
): string {
  if (isPdf && doc) {
    const idStr = typeof doc.id === 'string' ? doc.id : '';
    const matId = typeof doc.materialId === 'string' ? doc.materialId : '';
    const hash = idStr || PDF_MAT_RE.exec(matId)?.[1] || '';
    if (matId && hash && !isCanonicalPdfMaterialId(matId, hash)) {
      return `pdf:${matId}:${hash}`;
    }
    return `pdf:${hash || matId || source.id}`;
  }
  if (typeof doc?.materialId === 'string' && doc.materialId) {
    return `doc:${doc.materialId}`;
  }
  const audio = asAudioMeta(source);
  const batch = audio?.batch as Record<string, unknown> | undefined;
  if (typeof batch?.id === 'string' && batch.id) {
    return `audio:${batch.id}`;
  }
  if (Array.isArray(audio?.sourceIds) && audio.sourceIds.length > 1) {
    return `audio:${String(audio.sourceIds[0])}`;
  }
  return `source:${source.id}`;
}

export function sourceGroupKey(source: RawSource): string {
  const doc = asDocMeta(source);
  return groupKeyWithMeta(source, doc, isPdfDoc(doc));
}

export function normalizeFolderName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

export function materialFoldersFromSnapshot(snapshot: StudySnapshot | null | undefined): MaterialFoldersState {
  const topRaw = snapshot?.materialFolders;
  const raw =
    topRaw && typeof topRaw === 'object' && !Array.isArray(topRaw)
      ? (topRaw as Record<string, unknown>)
      : (snapshot?.settings?.materialFolders as Record<string, unknown> | undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { folders: [], items: {} };
  }
  const folders: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.folders)) {
    for (const entry of raw.folders) {
      const name = normalizeFolderName(entry);
      if (!name || name.length > 80 || seen.has(name)) continue;
      seen.add(name);
      folders.push(name);
    }
  }
  const items: Record<string, string> = {};
  if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
    for (const [key, val] of Object.entries(raw.items)) {
      if (typeof key !== 'string' || !key.trim()) continue;
      const folder = normalizeFolderName(val);
      if (!folder || folder.length > 80) continue;
      if (!seen.has(folder)) {
        seen.add(folder);
        folders.push(folder);
      }
      items[key] = folder;
    }
  }
  return { folders, items };
}

export function pinnedKeysFromSnapshot(snapshot: StudySnapshot | null | undefined): string[] {
  const raw = snapshot?.settings?.materialPins;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of raw) {
    if (typeof k === 'string' && k.trim() && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function addCardSourceCounts(
  containers: unknown[] | undefined,
  counts: Map<string, number>,
): void {
  if (!Array.isArray(containers)) return;
  for (let i = 0; i < containers.length; i++) {
    const container = containers[i];
    if (!container || typeof container !== 'object') continue;
    const cards = (container as Record<string, unknown>).cards;
    if (!Array.isArray(cards)) continue;
    for (let j = 0; j < cards.length; j++) {
      const card = cards[j] as Record<string, unknown> | undefined;
      if (!card || typeof card !== 'object') continue;
      const sels = card.selections;
      const cits = card.citations;
      const hasSels = Array.isArray(sels) && sels.length > 0;
      const hasCits = Array.isArray(cits) && cits.length > 0;
      if (!hasSels && !hasCits) continue;

      // Avoid allocating a Set per card when 0 or 1 distinct sourceId is referenced.
      let firstSid: string | undefined;
      let seenForCard: Set<string> | undefined;

      const recordSid = (sid: unknown) => {
        if (typeof sid !== 'string' || !sid) return;
        if (firstSid === undefined) {
          firstSid = sid;
          counts.set(sid, (counts.get(sid) ?? 0) + 1);
        } else if (sid !== firstSid) {
          if (!seenForCard) {
            seenForCard = new Set<string>();
            seenForCard.add(firstSid);
          }
          if (!seenForCard.has(sid)) {
            seenForCard.add(sid);
            counts.set(sid, (counts.get(sid) ?? 0) + 1);
          }
        }
      };

      if (hasSels) {
        for (let k = 0; k < sels.length; k++) {
          const s = sels[k] as Record<string, unknown> | undefined;
          recordSid(s?.sourceId);
        }
      }
      if (hasCits) {
        for (let k = 0; k < cits.length; k++) {
          const cit = cits[k] as Record<string, unknown> | undefined;
          const sel = cit?.selection as Record<string, unknown> | undefined;
          recordSid(sel?.sourceId || cit?.sourceId);
        }
      }
    }
  }
}

function buildCardCountIndex(snapshot: StudySnapshot | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  addCardSourceCounts(snapshot?.decks as unknown[] | undefined, counts);
  addCardSourceCounts(snapshot?.drafts as unknown[] | undefined, counts);
  return counts;
}

function libraryListField(prov: string): string | undefined {
  switch (prov) {
    case 'exam-blueprint':
      return 'blueprint';
    case 'course-outline':
      return 'courseOutline';
    case 'course-outline-notes':
      return 'courseNotes';
    case 'course-book-doc':
      return 'bookDoc';
    case 'course-outline-inventory':
      return 'courseInventory';
    default:
      return undefined;
  }
}

/** Mirror lib/exam-point-list.js isLibraryListSource so derived lists are excluded from material pickers. */
export function isLibraryListSource(source: RawSource): boolean {
  const rec = source as Record<string, unknown>;
  const prov = rec.provenance;
  if (typeof prov !== 'string') return false;
  const field = libraryListField(prov);
  if (!field) return false;
  const val = rec[field];
  return Boolean(val && typeof val === 'object');
}

interface SnapshotDocumentLike {
  currentRevision?: unknown;
  superseded?: unknown;
  versions?: Array<{
    revision?: unknown;
    superseded?: unknown;
    sourceIds?: unknown[];
  }>;
}

function buildVersionMembership(snapshot: StudySnapshot | null | undefined): {
  retained: Set<string>;
  current: Set<string>;
} {
  const retained = new Set<string>();
  const current = new Set<string>();
  const rawDocs = (snapshot as Record<string, unknown> | null | undefined)?.documents;
  if (!Array.isArray(rawDocs)) return { retained, current };
  for (const doc of rawDocs as SnapshotDocumentLike[]) {
    if (!doc || typeof doc !== 'object') continue;
    const versions = Array.isArray(doc.versions) ? doc.versions : [];
    for (const version of versions) {
      if (!version || typeof version !== 'object') continue;
      const isCurrent =
        doc.superseded !== true &&
        version.superseded !== true &&
        version.revision !== undefined &&
        version.revision !== null &&
        version.revision === doc.currentRevision;
      const ids = Array.isArray(version.sourceIds) ? version.sourceIds : [];
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        retained.add(id);
        if (isCurrent) current.add(id);
      }
    }
  }
  return { retained, current };
}

/** Mirror lib/material-source-versions.js stampSourceVersions for historical/superseded revisions. */
export function isHistoricalSource(
  source: RawSource,
  membership?: { retained: Set<string>; current: Set<string> },
): boolean {
  const rec = source as Record<string, unknown>;
  const docMeta = asDocMeta(source);
  if (rec.superseded === true || docMeta?.superseded === true) return true;
  if (membership && membership.retained.has(source.id)) {
    return !membership.current.has(source.id);
  }
  return rec.historical === true;
}

/** Group page-level snapshot sources into document-level items (mirrors lib/source-groups.js). */
export function groupSourcesFromSnapshot(snapshot: StudySnapshot | null | undefined): DocumentGroup[] {
  const sources = snapshot?.sources ?? [];
  if (sources.length === 0) return [];
  const pins = pinnedKeysFromSnapshot(snapshot);
  const pinIndex = new Map<string, number>();
  for (let i = 0; i < pins.length; i++) pinIndex.set(pins[i], i);
  const cardIndex = buildCardCountIndex(snapshot);
  const folderState = materialFoldersFromSnapshot(snapshot);
  const versionMembership = buildVersionMembership(snapshot);

  const buckets = new Map<string, { key: string; format: string; members: RawSource[] }>();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s || typeof s.id !== 'string') continue;
    if (isHistoricalSource(s, versionMembership) || isLibraryListSource(s)) continue;
    const doc = asDocMeta(s);
    const pdf = isPdfDoc(doc);
    const key = groupKeyWithMeta(s, doc, pdf);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, format: detectFormatWithMeta(s, doc, pdf), members: [] };
      buckets.set(key, bucket);
    }
    bucket.members.push(s);
  }

  const groups: DocumentGroup[] = [];
  for (const { key, format, members } of buckets.values()) {
    let ordered: Array<{ src: RawSource; page: number }>;
    if (members.length === 1) {
      const src = members[0];
      const doc = asDocMeta(src);
      const batch = format === 'audio' ? (asAudioMeta(src)?.batch as Record<string, unknown> | undefined) : undefined;
      const pg = Number.isInteger(doc?.page)
        ? Number(doc?.page)
        : format === 'audio' && Number.isInteger(batch?.volume)
          ? Number(batch?.volume)
          : 1;
      ordered = [{ src, page: pg }];
    } else {
      ordered = members
        .map((src, idx) => {
          const doc = asDocMeta(src);
          const batch = format === 'audio' ? (asAudioMeta(src)?.batch as Record<string, unknown> | undefined) : undefined;
          const pg = Number.isInteger(doc?.page)
            ? Number(doc?.page)
            : format === 'audio' && Number.isInteger(batch?.volume)
              ? Number(batch?.volume)
              : idx + 1;
          return { src, page: pg };
        })
        .sort((a, b) => a.page - b.page);
    }

    const first = ordered[0].src;
    const doc = asDocMeta(first);
    const batch = format === 'audio' ? (asAudioMeta(first)?.batch as Record<string, unknown> | undefined) : undefined;

    let rawTitle = String(first.title ?? first.name ?? first.filename ?? first.id);
    if (format === 'pdf') {
      rawTitle = String(doc?.bookTitle || doc?.filename || rawTitle.replace(PAGE_SUFFIX_RE, ''));
    } else if (format === 'pptx' || format === 'ppt') {
      rawTitle = String(rawTitle.replace(PAGE_SUFFIX_RE, '') || doc?.filename || rawTitle);
    } else if (format === 'audio') {
      rawTitle = String(batch?.title || rawTitle.replace(PART_SUFFIX_RE, ''));
    }
    const title = baseNameOnly(rawTitle);

    const courseSet = new Set<string>();
    const pages: Array<{ sourceId: string; page: number; title: string; chars: number }> = new Array(ordered.length);
    const sourceIds: string[] = new Array(ordered.length);
    const isPinnedByIndex = pinIndex.has(key);
    const assignedFolder = folderState.items[key];
    let totalChars = 0;
    let totalCards = 0;
    let allArchived = true;
    let anyPinned = isPinnedByIndex;
    let firstFolder = assignedFolder || '';
    let documentId: string | undefined;
    let updatedAt: string | number | undefined;

    for (let i = 0; i < ordered.length; i++) {
      const { src, page } = ordered[i];
      const sDoc = asDocMeta(src);
      if (!documentId && typeof sDoc?.materialId === 'string' && sDoc.materialId) documentId = sDoc.materialId;
      if (!documentId && typeof sDoc?.id === 'string' && sDoc.id) documentId = sDoc.id;

      if (Array.isArray(src.courses)) {
        for (let k = 0; k < src.courses.length; k++) {
          const c = src.courses[k];
          if (typeof c === 'string') {
            const trimmed = c.trim();
            if (trimmed) courseSet.add(trimmed);
          }
        }
      } else if (typeof src.course === 'string') {
        const trimmed = src.course.trim();
        if (trimmed) courseSet.add(trimmed);
      }

      const rawRec = src as Record<string, unknown>;
      const chars = Number(rawRec.chars ?? 0) || (typeof rawRec.text === 'string' ? rawRec.text.length : 0);
      totalChars += chars;
      const cards = Number(src.cardCount ?? 0) || (cardIndex.get(src.id) ?? 0);
      totalCards += cards;
      if (!src.archived) allArchived = false;
      if (!anyPinned && src.pinned) anyPinned = true;
      if (!firstFolder && src.folder) {
        const norm = normalizeFolderName(src.folder);
        if (norm) firstFolder = norm;
      }
      if (src.updatedAt !== undefined) updatedAt = src.updatedAt;

      sourceIds[i] = src.id;
      pages[i] = {
        sourceId: src.id,
        page,
        title: String(src.title ?? src.id),
        chars,
      };
    }

    groups.push({
      key,
      ...(documentId ? { documentId } : {}),
      title,
      format,
      pageCount: pages.length,
      sourceIds,
      pages,
      courses: [...courseSet],
      ...(firstFolder ? { folder: firstFolder } : {}),
      cardCount: totalCards,
      chars: totalChars,
      pinned: anyPinned,
      archived: allArchived,
      updatedAt,
    });
  }

  groups.sort((a, b) => {
    const aPin = pinIndex.get(a.key);
    const bPin = pinIndex.get(b.key);
    if (aPin !== undefined && bPin !== undefined) return aPin - bPin;
    if (aPin !== undefined) return -1;
    if (bPin !== undefined) return 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return TITLE_COLLATOR.compare(a.title, b.title);
  });

  return groups;
}

export function formatLabel(format: string): string {
  switch (format.toLowerCase()) {
    case 'pdf':
      return 'PDF';
    case 'pptx':
    case 'ppt':
      return 'PPTX';
    case 'docx':
      return 'DOCX';
    case 'md':
    case 'markdown':
      return 'MD';
    case 'tex':
    case 'latex':
      return 'TEX';
    case 'html':
      return 'HTML';
    case 'txt':
      return 'TXT';
    case 'audio':
      return 'AUDIO';
    default:
      return 'TEXT';
  }
}

export function formatTone(format: string): Tone {
  switch (format.toLowerCase()) {
    case 'pdf':
      return 'error';
    case 'pptx':
    case 'ppt':
      return 'warning';
    case 'docx':
      return 'info';
    case 'md':
    case 'tex':
      return 'primary';
    case 'audio':
      return 'ai';
    default:
      return 'muted';
  }
}
