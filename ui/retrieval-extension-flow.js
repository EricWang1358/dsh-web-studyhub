/* The flows behind the search extension's buttons (WP28b). Each takes the page's
   call(action, args) and resolves a plain outcome instead of throwing, so the
   components only render it. */
import { ui, uiFormat } from './i18n.js';

const message = error => error?.message || String(error);

/** Install the extension: { phase: 'installed', restartRequired, status } | { phase: 'approval', pending } | { phase: 'error', message }. */
export async function runInstall(call, approvedBuilds) {
  try {
    const result = await call('retrieval.extension.install', approvedBuilds?.length ? { approvedBuilds } : {});
    if (result?.status === 'needs-approval') return { phase: 'approval', pending: result.pending };
    const status = await Promise.resolve(call('retrieval.status', {})).catch(() => null);
    return { phase: 'installed', restartRequired: !!result?.restartRequired, status };
  } catch (error) { return { phase: 'error', message: message(error) }; }
}

/** Remove the extension: { phase: 'removed', status } | { phase: 'error', message }. */
export async function runUninstall(call) {
  try {
    await call('retrieval.extension.uninstall', {});
    return { phase: 'removed', status: await Promise.resolve(call('retrieval.status', {})).catch(() => null) };
  } catch (error) { return { phase: 'error', message: message(error) }; }
}

/** Start building the index of a course: { phase: 'started', run } | { phase: 'error', message, code? }. */
export async function startIndex(call, course) {
  try { return { phase: 'started', run: await call('retrieval.index.start', { course }) }; }
  catch (error) { return { phase: 'error', message: message(error), ...(error?.code ? { code: error.code } : {}) }; }
}

/** { percent, label } of a running build. */
export function indexProgress(run) {
  const total = Number(run?.total) || 0, done = Math.min(total, Number(run?.done) || 0);
  const percent = total ? Math.round((done / total) * 100) : 0;
  const label = run?.stage === 'model' ? ui('正在准备检索模型（首次需要下载，可能要一两分钟）…')
    : run?.stage === 'preparing' ? ui('正在准备…') : uiFormat('正在建立索引 {0} / {1} 页', [done, total]);
  return { percent, label };
}
