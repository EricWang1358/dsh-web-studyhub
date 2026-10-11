/* The owner's real cases of flow A (2026-10-11), rebuilt from the real writers: eight lecture recordings merged into one transcript (two of them long, six short: the short six held 60% of
   the text and got no question), a 36-page PDF asked for 25 questions, and one recording of 107 parts. Each recording's sentences say where they stand ("Recording 3, part 2, point 1.1: …"),
   so a fake planner can quote any section and a test can tell which material a question is about. */
import { buildDocuments } from '../../lib/transcript.js';
import { batchDocuments } from '../../lib/audio-batch.js';

const sentence = (recording, part, index) => [1, 2, 3, 4].map(k => `Recording ${recording}, part ${part}, point ${index + 1}.${k}: we discuss the platform team and what each product group must build, and why that choice has a cost for the teams that reuse it.`).join(' ');
const chinese = (recording, part, index) => [1, 2, 3, 4].map(k => `录音${recording}，第${part}段，第${index + 1}点.${k}：我们讨论平台团队，以及每个产品组必须构建什么。`).join('');

/** A merged transcript of recordings: `shape[i]` = [parts, paragraphs per part] of recording i + 1. -> { sources, names } */
export function recordingBatch(shape, { id = 'batch' } = {}) {
  const names = shape.map((_, index) => `lecture-${String(index + 1).padStart(2, '0')}.mp3`);
  const members = names.map((filename, index) => ({ filename, index }));
  const results = shape.map(([parts, paragraphs], at) => ({ documents: buildDocuments({ filename: names[at], titleEn: `Lecture ${at + 1}`, language: 'zh', limit: Infinity,
    parts: Array.from({ length: parts }, (_, part) => ({ titleZh: `段落 ${part + 1}`, titleEn: `Passage ${part + 1}`,
      english: Array.from({ length: paragraphs }, (_, index) => sentence(at + 1, part + 1, index)),
      chinese: Array.from({ length: paragraphs }, (_, index) => chinese(at + 1, part + 1, index)) })) }) }));
  const volumes = batchDocuments(`${names[0]} + ${names.length - 1}`, members, results);
  return { names, sources: volumes.map((text, index) => ({ id: `${id}-vol${index + 1}`, title: `lectures (${index + 1}/${volumes.length})`, text, audio: { batch: { id, title: 'lectures', volume: index + 1 } } })) };
}

/** The owner's eight recordings: two long ones and six short ones that together hold most of the text of the short half. */
export const eightRecordings = () => recordingBatch([[12, 6], [12, 6], [4, 6], [4, 6], [4, 6], [4, 6], [4, 6], [4, 6]]);

const pageText = (book, page, chars) => {
  let text = `${book} page ${page}. `;
  for (let n = 1; text.length < chars; n++) text += `Page ${page}, claim ${n}: a service boundary is drawn where a team can change its part without asking another team first. `;
  return text;
};

/** A PDF of `pages` pages (one source per page, the shape of lib/documents.js). */
export function pdfBook({ pages = 36, chars = 1800, hash = 'a'.repeat(64), filename = 'book.pdf', sizes } = {}) {
  return Array.from({ length: pages }, (_, index) => ({ id: `pdf-${hash.slice(0, 6)}-p${index + 1}`, title: `${filename.replace(/\.pdf$/, '')} · p. ${index + 1}`, text: pageText(filename, index + 1, sizes?.[index] ?? chars),
    document: { id: hash, page: index + 1, totalPages: pages, filename, format: 'pdf', extractionVersion: 2 } }));
}

/** Short notes, one source each. */
export const notes = (count, chars = 900) => Array.from({ length: count }, (_, index) => ({ id: `note-${index + 1}`, title: `Note ${index + 1}`, text: pageText(`note ${index + 1}`, 1, chars) }));

/** A library state of these sources. */
export const stateOf = (sources, extra = {}) => ({ sources, decks: [], drafts: [], documents: [], ...extra });
