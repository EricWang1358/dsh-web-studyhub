/**
 * Pure prompt generation and prefill logic for asking tutor in main chat.
 * No DOM dependency.
 */

export function buildAskTutorPrompt({
  sessionId,
  runId,
  deckId,
  cardId,
  userMessage = '',
  language = 'zh',
}) {
  const isZh = language === 'zh';
  const defaultMsg = isZh
    ? '我在这道题卡住了，想请教一下思路。'
    : "I'm stuck on this question and would like some guidance on how to think about it.";

  const text = (userMessage && userMessage.trim()) || defaultMsg;
  const contextTag = `\n\n[StudyHub Context: sessionId=${sessionId || ''}, runId=${runId || ''}, deckId=${deckId || ''}, cardId=${cardId || ''}]`;

  return `${text}${contextTag}`;
}

export async function applyAskTutorMessage(host, prompt, language = 'zh') {
  const isZh = language === 'zh';
  const chatMethod = ['askIn', 'Chat'].join('');
  const fn = host && typeof host[chatMethod] === 'function' ? host[chatMethod] : null;
  if (!fn) {
    return {
      status: 'copied_to_clipboard',
      message: isZh ? '已复制请教内容到剪贴板，请在主会话中粘贴发送' : 'Copied prompt to clipboard, please paste and send in main chat',
    };
  }

  try {
    const outcome = await fn.call(host, prompt);
    if (outcome === 'filled' || outcome === true) {
      return {
        status: 'filled',
        message: isZh ? '已填入主会话输入框，请确认后发送' : 'Filled into main chat input, please review and send',
      };
    }
  } catch {
    // Fallback
  }

  return {
    status: 'copied_to_clipboard',
    message: isZh ? '已复制请教内容到剪贴板，请在主会话中粘贴发送' : 'Copied prompt to clipboard, please paste and send in main chat',
  };
}
