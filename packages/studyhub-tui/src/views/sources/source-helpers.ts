import type { StudySnapshot } from '../../types/contracts.js';
import type { Tone } from '../../components/index.js';

export interface DocumentGroup {
  key: string;
  documentId?: string;
  title: string;
  format: string;
  pageCount: number;
  sourceIds: string[];
  pages: Array<{ sourceId: string; page: number; title: string; chars: number }>;
  courses: string[];
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

function isPdfSource(source: RawSource): boolean {
  const doc = asDocMeta(source);
  if (!doc) return false;
  const fmt = String(doc.format || '').toLowerCase();
  if (OFFICE_FORMATS.has(fmt)) return false;
  return Number.isInteger(doc.page) || fmt === 'pdf' || PDF_MAT_RE.test(String(doc.materialId || ''));
}

export function detectSourceFormat(source: RawSource): string {
  if (isPdfSource(source)) return 'pdf';
  const doc = asDocMeta(source);
  const declared = FORMAT_MAP[String(doc?.format || '').toLowerCase()];
  if (declared) return declared;
  if (asAudioMeta(source)) return 'audio';
  const legacy = FORMAT_MAP[String(source.format || source.ext || '').toLowerCase()];
  return legacy || 'text';
}

export function sourceGroupKey(source: RawSource): string {
  const doc = asDocMeta(source);
  if (isPdfSource(source) && doc) {
    const idStr = typeof doc.id === 'string' ? doc.id : '';
    const matId = typeof doc.materialId === 'string' ? doc.materialId : '';
    const hash = idStr || PDF_MAT_RE.exec(matId)?.[1] || '';
    if (matId && hash && matId !== `document-${hash}-pdf`) {
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

function buildCardCountIndex(snapshot: StudySnapshot | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: unknown) => {
    if (typeof id === 'string' && id) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const container of [...(snapshot?.decks ?? []), ...(snapshot?.drafts ?? [])]) {
    const cards = Array.isArray((container as Record<string, unknown>).cards)
      ? ((container as Record<string, unknown>).cards as Array<Record<string, unknown>>)
      : [];
    for (const card of cards) {
      const seenForCard = new Set<string>();
      const sels = Array.isArray(card.selections) ? card.selections : [];
      for (const s of sels) {
        const sid = (s as Record<string, unknown>)?.sourceId;
        if (typeof sid === 'string' && !seenForCard.has(sid)) {
          seenForCard.add(sid);
          bump(sid);
        }
      }
      const cits = Array.isArray(card.citations) ? card.citations : [];
      for (const c of cits) {
        const cit = c as Record<string, unknown>;
        const sel = cit?.selection as Record<string, unknown> | undefined;
        const sid = sel?.sourceId || cit?.sourceId;
        if (typeof sid === 'string' && !seenForCard.has(sid)) {
          seenForCard.add(sid);
          bump(sid);
        }
      }
    }
  }
  return counts;
}

/** Group page-level snapshot sources into document-level items (mirrors lib/source-groups.js). */
export function groupSourcesFromSnapshot(snapshot: StudySnapshot | null | undefined): DocumentGroup[] {
  const sources = snapshot?.sources ?? [];
  if (sources.length === 0) return [];
  const pins = pinnedKeysFromSnapshot(snapshot);
  const pinIndex = new Map(pins.map((k, i) => [k, i]));
  const cardIndex = buildCardCountIndex(snapshot);

  const buckets = new Map<string, { key: string; format: string; members: RawSource[] }>();
  for (const s of sources) {
    if (!s || typeof s.id !== 'string') continue;
    const key = sourceGroupKey(s);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, format: detectSourceFormat(s), members: [] };
      buckets.set(key, bucket);
    }
    bucket.members.push(s);
  }

  const groups: DocumentGroup[] = [];
  for (const { key, format, members } of buckets.values()) {
    const ordered = members
      .map((src, idx) => {
        const doc = asDocMeta(src);
        const audio = asAudioMeta(src);
        const batch = audio?.batch as Record<string, unknown> | undefined;
        const pg = Number.isInteger(doc?.page)
          ? Number(doc?.page)
          : format === 'audio' && Number.isInteger(batch?.volume)
            ? Number(batch?.volume)
            : idx + 1;
        return { src, page: pg };
      })
      .sort((a, b) => a.page - b.page);

    const first = ordered[0].src;
    const doc = asDocMeta(first);
    const audio = asAudioMeta(first);
    const batch = audio?.batch as Record<string, unknown> | undefined;

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
    let totalChars = 0;
    let totalCards = 0;
    let allArchived = true;
    let documentId: string | undefined;
    let updatedAt: string | number | undefined;

    const pages = ordered.map(({ src, page }) => {
      const sDoc = asDocMeta(src);
      if (!documentId && typeof sDoc?.materialId === 'string' && sDoc.materialId) documentId = sDoc.materialId;
      if (!documentId && typeof sDoc?.id === 'string' && sDoc.id) documentId = sDoc.id;

      const sCourses = Array.isArray(src.courses) ? src.courses : src.course ? [src.course] : [];
      for (const c of sCourses) if (typeof c === 'string' && c.trim()) courseSet.add(c.trim());

      const chars = Number((src as Record<string, unknown>).chars ?? 0) || (typeof (src as Record<string, unknown>).text === 'string' ? ((src as Record<string, unknown>).text as string).length : 0);
      totalChars += chars;
      const cards = Number(src.cardCount ?? 0) || (cardIndex.get(src.id) ?? 0);
      totalCards += cards;
      if (!src.archived) allArchived = false;
      if (src.updatedAt !== undefined) updatedAt = src.updatedAt;

      return {
        sourceId: src.id,
        page,
        title: String(src.title ?? src.id),
        chars,
      };
    });

    const pinned = pinIndex.has(key) || ordered.some(({ src }) => Boolean(src.pinned));
    groups.push({
      key,
      ...(documentId ? { documentId } : {}),
      title,
      format,
      pageCount: pages.length,
      sourceIds: pages.map((p) => p.sourceId),
      pages,
      courses: [...courseSet],
      cardCount: totalCards,
      chars: totalChars,
      pinned,
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
    return a.title.localeCompare(b.title);
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
