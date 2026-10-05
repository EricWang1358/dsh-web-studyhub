import { ui, uiFormat } from '../i18n.js';
import { archiveJobs, deleteJobs, unarchiveJobs } from '../quick-actions.js';
import { chunk } from './task-selection.js';

/* 归档, 取消归档 and 删除 of several tasks at once, from the console. The light path (ui/quick-actions.js: the view changes at once, one call per 100 tasks) when the app
   offers it; otherwise the same calls through the app's own act(). One result shape either way: { ok, archived, unarchived, deleted, skipped, message? }. */

const RUNNERS = { archive: archiveJobs, unarchive: unarchiveJobs, delete: deleteJobs };
const COUNT = { archive: 'archived', unarchive: 'unarchived', delete: 'deleted' };
const size = (value) => (Array.isArray(value) ? value.length : 0);

/** Send `action` (archive | unarchive | delete) for task ids. Never rejects. */
export async function batchRun(action, ids, { quick, core } = {}) {
  if (quick) return RUNNERS[action](quick, ids);
  const total = { ok: true, archived: 0, unarchived: 0, deleted: 0, skipped: 0 };
  for (const part of chunk(ids)) {
    let reply;
    try { reply = await core.act(`job.${action}`, { jobIds: part }, undefined, { rethrow: true }); } catch (error) { return { ...total, ok: false, message: String(error?.message || error) }; }
    if (reply === undefined) return { ...total, ok: false, message: ui('另一个操作还在进行，请稍后重试。') };
    total[COUNT[action]] += size(reply.archived) + size(reply.alreadyArchived) + size(reply.unarchived) + size(reply.deleted);
    total.skipped += size(reply.skipped);
  }
  return total;
}

/** What the toast says after a batch: how many, where they went, and how many running tasks were left alone. */
export function batchMessage(action, result) {
  const done = result[COUNT[action]] || 0;
  const head = action === 'archive' ? uiFormat('已归档 {0} 个，在「已归档」里可以找到', [done]) : action === 'unarchive' ? uiFormat('已取消归档 {0} 个', [done]) : uiFormat('已删除 {0} 个', [done]);
  return [done > 0 || !result.skipped ? head : '', result.skipped > 0 ? uiFormat('跳过 {0} 个进行中的任务', [result.skipped]) : ''].filter(Boolean).join('；');
}
