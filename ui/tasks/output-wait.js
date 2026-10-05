import { ui, uiFormat } from '../i18n.js';
import { formatNumber } from '../format.js';

/* What the output panel says while a running call has written no text yet (2.6.1). A call is in one of four states:
     text      something is on screen: no note;
     thinking  reasoning has arrived (it is only counted, never shown): the model is working, and how much it has thought so far is the proof;
     working   a DSH sub-agent that has been quiet for QUIET_AFTER_MS: some models give their reply only at the end (or only to the sub-agent's own
               session), so "waiting for the model to start" would be a lie, and the way to see the work is the DSH session;
     waiting   it has only just started. */

export const QUIET_AFTER_MS = 20000;

export function waitState({ call, text, reasoning, elapsedMs }) {
  if (text) return 'text';
  if (Number(reasoning) > 0) return 'thinking';
  if (call?.runner === 'subagent' && Number.isFinite(elapsedMs) && elapsedMs >= QUIET_AFTER_MS) return 'working';
  return 'waiting';
}

export function waitNote(state, reasoning = 0) {
  if (state === 'thinking') return uiFormat('模型正在思考（已思考约 {0} 字）；正文开始后会显示在这里。', [formatNumber(reasoning)]);
  if (state === 'working') return ui('子代理正在工作，完成前这里可能没有文字；完整内容在 DSH 会话里。');
  return ui('等待模型开始输出…');
}
