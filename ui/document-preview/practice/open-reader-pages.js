import { groupSourcesByDocument } from '../../../lib/source-groups.js';
import { isJsonCardSource } from '../../../lib/source-provenance.js';
import { isLibraryListSource } from '../../../lib/exam-point-list.js';
import { uiFormat } from '../../i18n.js';

/** Whether a source record can be opened in the material reader for page/section practice (excludes JSON-card imports and exam-point lists). */
export function isReadableMaterial(source) {
  return Boolean(
    source &&
    typeof source === 'object' &&
    !source.archived &&
    !source.historical &&
    !isJsonCardSource(source) &&
    !isLibraryListSource(source),
  );
}

/**
 * Group readable materials by document (one entry per multi-page PDF / slide deck / recording),
 * optionally restricted to documents that overlap `sourceIds`.
 */
export function readableMaterialItems(sources, sourceIds) {
  const readable = (Array.isArray(sources) ? sources : []).filter(isReadableMaterial);
  if (!readable.length) return [];
  const items = groupSourcesByDocument(readable);
  if (!Array.isArray(sourceIds) || !sourceIds.length) return items;
  const wanted = new Set(sourceIds);
  return items.filter((item) => item.sourceIds.some((id) => wanted.has(id)));
}

/**
 * Open the material reader ready to pick studied pages (`pickPages: true`):
 * - when `preferredSourceId` names a readable source, opens that page directly;
 * - when 1 material document matches, opens the reader directly on its first page;
 * - when 2+ material documents match, opens the grouped `SourceListDialog` with `pickPages: true`.
 */
export function openReaderForPages({ sources = [], sourceIds, preferredSourceId, openModal, back = false } = {}) {
  if (typeof openModal !== 'function') return false;
  const list = Array.isArray(sources) ? sources : [];
  const byId = new Map(list.filter(Boolean).map((source) => [source.id, source]));
  if (preferredSourceId && byId.has(preferredSourceId) && isReadableMaterial(byId.get(preferredSourceId))) {
    openModal({
      type: 'source',
      source: byId.get(preferredSourceId),
      pickPages: true,
      ...(back ? { back: true } : {}),
    });
    return true;
  }
  const items = readableMaterialItems(list, sourceIds);
  if (!items.length) return false;
  if (items.length === 1) {
    const firstId = items[0].pages[0]?.sourceId ?? items[0].sourceIds[0];
    const target = byId.get(firstId);
    if (!target) return false;
    openModal({
      type: 'source',
      source: target,
      pickPages: true,
      ...(back ? { back: true } : {}),
    });
    return true;
  }
  openModal({
    type: 'sources',
    sourceIds: items.map((item) => item.pages[0]?.sourceId ?? item.sourceIds[0]).filter(Boolean),
    pickPages: true,
    ...(back ? { back: true } : {}),
  });
  return true;
}

/**
 * Pure plan for in-round "还没学到第 N 页（本轮移出后续页）":
 * - collects unanswered queue entries at `index >= run.index` from the same document with `page >= currentPage`;
 * - returns `{ kind: 'remove', page, removeIndices, removedCount }` when at least one earlier/other entry remains;
 * - returns `{ kind: 'open-reader', page, removeIndices: [], removedCount: 0 }` when every entry in the round would be removed.
 */
export function deferUnstudiedPagesPlan(run) {
  const page = run?.cardSource?.page;
  if (!Number.isInteger(page) || run?.complete || run?.mode === 'exam' || run?.reading) return null;
  const nav = Array.isArray(run?.navigation) ? run.navigation : [];
  if (!nav.length) return null;
  const docKey = run.cardSource?.documentKey || null;
  const startAt = Number.isInteger(run.index) ? run.index : 0;
  const removeIndices = nav
    .filter((entry) =>
      Number.isInteger(entry?.index) &&
      entry.index >= startAt &&
      !entry.answered &&
      Number.isInteger(entry.page) &&
      entry.page >= page &&
      (!docKey || !entry.documentKey || entry.documentKey === docKey),
    )
    .map((entry) => entry.index);
  if (!removeIndices.length) return null;
  if (removeIndices.length >= nav.length) {
    return { kind: 'open-reader', page, removeIndices: [], removedCount: 0 };
  }
  return { kind: 'remove', page, removeIndices, removedCount: removeIndices.length };
}

/** Execute `deferUnstudiedPagesPlan` inside an active practice run (either opens the reader or trims `>= page` unanswered entries). */
export function runDeferUnstudiedPages({ run, sources, openModal, reviewAct, notify }) {
  const plan = deferUnstudiedPagesPlan(run);
  if (!plan) return;
  if (plan.kind === 'open-reader') {
    openReaderForPages({ sources, sourceIds: run.sourceIds, openModal, back: true });
    notify?.(uiFormat('本轮题目都在第 {0} 页及之后，已打开资料阅读器；翻到已学页点「做这几页的题」即可。', [plan.page]));
    return;
  }
  Promise.resolve(reviewAct('review.queue.edit', { removeIndices: plan.removeIndices, allowCurrent: true })).then((nextRun) => {
    if (nextRun) notify?.(uiFormat('已从本轮移出第 {0} 页及之后的 {1} 道未答题，题库中仍保留。', [plan.page, plan.removedCount]));
  });
}
