import { ui, uiFormat } from '../i18n.js';

/** The little word over a tutor line that gave something away. A learner's line and a plain reply have none. */
export function socraticTurnTag(turn) {
  if (turn?.role === 'learner') return '';
  if (turn?.kind === 'hint') return ui('提示');
  if (turn?.kind === 'reveal') return ui('参考答案');
  return '';
}

function turnLine(turn) {
  const text = String(turn?.text || '').trim();
  if (turn?.role === 'learner') return uiFormat('我：{0}', [text]);
  if (turn?.kind === 'hint') return uiFormat('老师（给了提示）：{0}', [text]);
  if (turn?.kind === 'reveal') return uiFormat('老师（给了参考答案）：{0}', [text]);
  return uiFormat('老师：{0}', [text]);
}

/** One line of the conversation for the clipboard (「复制本条」), with the question it is about. */
export function formatSocraticTurnCopy(turn, { prompt = '', topic = '' } = {}) {
  if (!turn) return '';
  const question = String(prompt || topic || '').trim();
  return [question ? uiFormat('题目：{0}', [question]) : '', turnLine(turn)].filter(Boolean).join('\n');
}

/** The whole conversation for the clipboard (「复制整段」): the question, every line with the help it gave, and how it ended. */
export function formatSocraticTranscriptCopy({ prompt = '', topic = '', state = null } = {}) {
  const record = state || {};
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const header = [
    uiFormat('苏格拉底带学：{0}', [topic || ui('当前题目')]),
    prompt ? uiFormat('题目：{0}', [String(prompt).trim()]) : '',
  ].filter(Boolean);
  const result = record.summary
    ? (record.summary.mastered ? ui('结果：讲清楚了（没用提示）') : ui('结果：讲清楚了（用过提示）'))
    : '';
  return [header.join('\n'), '', ...turns.map(turnLine), ...(result ? ['', result] : [])].join('\n').trim();
}

export async function copySocraticText(text) {
  const payload = String(text || '');
  if (!payload) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(payload);
      return true;
    } catch { /* fallback to textarea */ }
  }
  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = payload;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return Boolean(ok);
    } catch { /* unavailable */ }
  }
  return false;
}
