import { ui, uiFormat } from '../i18n.js';

/**
 * Open a background assistant (a DSH subagent's session) from the panel.
 *
 * It resolves once DSH has taken the request, so the panel can tell "opened" from "nothing
 * happened", and rejects with a message for the user otherwise. `reveal` brings the
 * conversation area to the front: StudyHub as a top-level page covers it, so without this the
 * assistant opens behind the page and the click looks like it did nothing.
 */
export async function openBackgroundAgent(ctx, id, { reveal } = {}) {
  if (!id) throw new Error(ui('这一步没有可打开的后台助手。'));
  const sessions = ctx.get('sessions');
  if (typeof sessions?.open !== 'function') throw new Error(ui('当前 DSH 版本不能从这里打开后台助手。'));
  try {
    await sessions.open(id);
  } catch (error) {
    throw new Error(uiFormat('没能打开后台助手：{0}', [error?.message || ui('DSH 没有说明原因，助手可能已经结束。')]));
  }
  try { await reveal?.(); }
  catch (error) {
    throw new Error(uiFormat('后台助手已打开，但未能切换到对话区：{0}',
      [error?.message || ui('请从会话列表打开助手。')]));
  }
}
