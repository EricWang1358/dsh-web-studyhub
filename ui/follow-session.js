import { ui, uiFormat } from './i18n.js';

/* What 「跟随当前会话」 follows, in words. The host puts the conversation's own default on the snapshot (snapshot.model.session =
   { provider, model, reasoningEffort: string | null }, lib/host.js sessionFollow); the 即时控制 row and 出题偏好 both name it here, so the
   one choice reads the same wherever it is offered. */

/** The model and the level a session gives, or null when its model is unknown; the level is the word default when the session sets none. */
function followed(session) {
  const model = typeof session?.model === 'string' ? session.model.trim() : '';
  return model ? { model, level: session.reasoningEffort || 'default' } : null;
}

/** 「跟随当前会话 · model · level」; the level is the word default when the session sets none, and the plain label when its model is unknown. */
export function followLabel(session) {
  const now = followed(session);
  return now ? uiFormat('跟随当前会话 · {0} · {1}', [now.model, now.level]) : ui('跟随当前会话');
}

/** The sentence under the closed select that follows the session ('' when the session's model is unknown, and there is nothing to add). */
export function followTip(session) {
  const now = followed(session);
  return now ? uiFormat('跟随当前会话：现在是 {0}，推理档位 {1}。会话换了模型，这里也跟着换。', [now.model, now.level]) : '';
}

/**
 * The option 「跟随当前会话」 of a Select, for the 即时控制 row and 出题偏好 alike. The closed select says only the short words; the whole label
 * (model and level, which can be long: `cn:deepseek-v4.1-flash`) is the option in the popup, wrapped, and the sentence is the trigger's tooltip.
 */
export function followOption(session) {
  return { value: 'follow', label: followLabel(session), triggerLabel: ui('跟随当前会话'), tip: followTip(session), wrap: true };
}
