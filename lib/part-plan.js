import { fileNameOf } from './document-title.js';

/* What each part of a question run covers, so the 任务 console can follow a part to its material (资料部分 → 在资料中查看). Pure.

   A question run is split into parts (lib/batch.js planGeneration); each part has the source objects it is written from. The job records, per part and from the
   moment the parts are planned (a waiting part has it too), `{ part, sourceIds, sourceCount, label }`: the ids of the sources (each once, at most PART_PLAN_SOURCES;
   `sourceCount` is how many there really are) and a short label of the range ("Book · 第 12–14 页", or the titles of notes and transcripts), at most PART_PLAN_LABEL
   characters. lib/job-contract.js reads it into partList[i].sourceIds / .sourceCount / .range. A PDF page is a source of its own, so its page is `document.page`. */

export const PART_PLAN_SOURCES = 20;
export const PART_PLAN_LABEL = 80;

const PAGE_SUFFIX = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;
const ZH = { range: (from, to) => (from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`), join: '、' };

const EN = { range: (from, to) => (from === to ? `p. ${from}` : `pp. ${from}–${to}`), join: ', ' };
/** How a label is written in a language ('en' or anything else, which is Chinese). */
export const partPlanText = (language) => (language === 'en' ? EN : ZH);

/** The text of a label cut to `max` characters, with an ellipsis when something was left out. */
export const clipLabel = (text, max = PART_PLAN_LABEL) => {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…` : value;
};

/** The name and page of a source as the label shows them: a PDF page is its book and page number, anything else its title. */
function nameOf(source) {
  const page = source?.document?.page, title = String(source?.title ?? '');
  if (Number.isInteger(page)) return { name: fileNameOf(source.document.bookTitle || source.document.filename || title.replace(PAGE_SUFFIX, '')), page };
  return { name: fileNameOf(title.replace(PAGE_SUFFIX, '')), page: null };
}

/** The label of the sources of one part: documents in turn, each with its consecutive page runs; sources without pages by their titles. */
function labelOf(ids, text) {
  const groups = [];
  for (const source of ids) {
    const { name, page } = nameOf(source), last = groups.at(-1);
    if (!name) continue;
    if (!last || last.name !== name) { groups.push({ name, runs: page === null ? [] : [{ from: page, to: page }] }); continue; }
    if (page === null) continue;
    const run = last.runs.at(-1);
    if (run && page === run.to + 1) run.to = page; else last.runs.push({ from: page, to: page });
  }
  return groups.map((group) => (group.runs.length ? `${group.name} · ${group.runs.map((run) => text.range(run.from, run.to)).join(text.join)}` : group.name)).join(text.join);
}

/**
 * The plan of a run's parts, from what planGeneration cut: [{ part, sourceIds, sourceCount, label }] in part order (parts are numbered from 1).
 * `text` says how a page range and a list are written ({ range(from, to), join }); the default is Chinese.
 */
export function partPlanOf(planned, text = ZH) {
  if (!Array.isArray(planned)) return [];
  return planned.map((entry, index) => {
    const seen = new Set(), unique = [];
    for (const source of Array.isArray(entry?.sources) ? entry.sources : []) {
      if (typeof source?.id !== 'string' || !source.id || seen.has(source.id)) continue;
      seen.add(source.id); unique.push(source);
    }
    return { part: index + 1, sourceIds: unique.slice(0, PART_PLAN_SOURCES).map((source) => source.id), sourceCount: unique.length, label: clipLabel(labelOf(unique, text)) };
  });
}

/** The plan a job record carries, made safe to read: only well-formed entries, ids and label bounded. Keyed by part number. */
export function readPartPlan(plan) {
  const byPart = new Map();
  for (const entry of Array.isArray(plan) ? plan : []) {
    if (!entry || !Number.isInteger(entry.part) || entry.part < 1) continue;
    const ids = (Array.isArray(entry.sourceIds) ? entry.sourceIds : []).filter((id) => typeof id === 'string' && id).slice(0, PART_PLAN_SOURCES);
    const label = clipLabel(entry.label);
    if (!ids.length && !label) continue;
    byPart.set(entry.part, { ...(ids.length ? { sourceIds: ids, sourceCount: Number.isInteger(entry.sourceCount) && entry.sourceCount >= ids.length ? entry.sourceCount : ids.length } : {}),
      ...(label ? { range: label } : {}) });
  }
  return byPart;
}
