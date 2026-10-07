import { ui, uiFormat } from './i18n.js';

/* What 「跟随当前会话」 follows, in words. The host puts the conversation's own default on the snapshot (snapshot.model.session =
   { provider, model, reasoningEffort: string | null }, lib/host.js sessionFollow); the 即时控制 row and 出题偏好 both name it here, so the
   one choice reads the same wherever it is offered. */

/** 「跟随当前会话 · model · level」; the level is the word default when the session sets none, and the plain label when its model is unknown. */
export function followLabel(session) {
  const model = typeof session?.model === 'string' ? session.model.trim() : '';
  if (!model) return ui('跟随当前会话');
  return uiFormat('跟随当前会话 · {0} · {1}', [model, session.reasoningEffort || 'default']);
}
