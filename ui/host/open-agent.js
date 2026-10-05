import { ui, uiFormat } from '../i18n.js';

/* Opening a background assistant (a DSH subagent's session) from the panel.

   Two ways exist, by DSH version: an older build offers `sessions.open(id)`; DSH 0.2 has no such call but lists every
   sub-agent in its parent's catalog, so the panel resolves the child's address (`sessions.subagentAddress`, after asking DSH to load
   the parent's catalog when the child is not known yet) and opens it with `uiWorkspace.openSession(address)`.
   The links ("查看子代理", "查看后台助手") are drawn only when one of the two is there, and, for a child, only when DSH can resolve it. */

function opener(ctx) {
  const sessions = ctx?.get?.('sessions'), workspace = ctx?.get?.('uiWorkspace');
  if (typeof sessions?.open === 'function') return { kind: 'open', sessions };
  if (typeof sessions?.subagentAddress === 'function' && typeof workspace?.openSession === 'function') return { kind: 'address', sessions, workspace };
  return null;
}

/**
 * Whether this DSH can open a sub-agent's session from the panel. With `id` (and the `parentId` the task knows): whether it can
 * open THAT one, which is when the DSH build opens sessions by id, or the child is already in a loaded catalog, or its parent is known
 * and can be asked to load it.
 */
export function canOpenBackgroundAgent(ctx, id, { parentId } = {}) {
  const way = opener(ctx);
  if (!way) return false;
  if (id === undefined || way.kind === 'open') return true;
  return !!id && (way.sessions.subagentAddress(id) !== undefined || (!!parentId && typeof way.sessions.refreshProjections === 'function'));
}

/**
 * Open a background assistant (a DSH subagent's session) from the panel.
 *
 * It resolves once DSH has taken the request, so the panel can tell "opened" from "nothing
 * happened", and rejects with a message for the user otherwise. `reveal` brings the
 * conversation area to the front: StudyHub as a top-level page covers it, so without this the
 * assistant opens behind the page and the click looks like it did nothing.
 */
export async function openBackgroundAgent(ctx, id, { reveal, parentId } = {}) {
  if (!id) throw new Error(ui('这一步没有可打开的后台助手。'));
  const way = opener(ctx);
  if (!way) throw new Error(ui('当前 DSH 版本不能从这里打开后台助手。'));
  try {
    if (way.kind === 'open') await way.sessions.open(id);
    else {
      let address = way.sessions.subagentAddress(id);
      if (address === undefined && parentId && typeof way.sessions.refreshProjections === 'function') {
        await way.sessions.refreshProjections(parentId);
        address = way.sessions.subagentAddress(id);
      }
      if (address === undefined) throw new Error(ui('DSH 的子代理列表里还没有它，可能已经结束并被清理。'));
      await way.workspace.openSession(address);
    }
  } catch (error) {
    throw new Error(uiFormat('没能打开后台助手：{0}', [error?.message || ui('DSH 没有说明原因，助手可能已经结束。')]));
  }
  try { await reveal?.(); }
  catch (error) {
    throw new Error(uiFormat('后台助手已打开，但未能切换到对话区：{0}',
      [error?.message || ui('请从会话列表打开助手。')]));
  }
}
