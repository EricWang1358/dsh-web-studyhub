/**
 * Pure prompt generation and prefill logic for asking tutor in main chat.
 * No DOM dependency.
 */

export function buildAskTutorPrompt({
  sessionId,
  runId,
  deckId,
  cardId,
  stem = '',
  answered = false,
  correct = null,
  userMessage = '',
  language = 'zh',
}) {
  const isZh = language !== 'en';
  const defaultMsg = isZh
    ? '我在这道题卡住了，想请教一下思路。'
    : "I'm stuck on this question and would like some guidance on how to think about it.";

  const text = (userMessage && userMessage.trim()) || defaultMsg;
  // Enough for the main chat to know which question without guessing (#548): its stem, whether the learner has answered, and where to read the rest.
  const shortStem = String(stem || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const state = !answered ? (isZh ? '还没作答' : 'not answered yet')
    : correct === true ? (isZh ? '已作答，答对了' : 'answered, correct') : correct === false ? (isZh ? '已作答，答错了' : 'answered, wrong') : (isZh ? '已作答' : 'answered');
  const lines = isZh
    ? [shortStem && `题目：${shortStem}`, `状态：${state}`,
      `（先用 study.scene.get {"sessionId":"${sessionId || ''}"} 读我的作答，再讲；不要直接告诉我答案。sessionId=${sessionId || ''} runId=${runId || ''} deckId=${deckId || ''} cardId=${cardId || ''}）`]
    : [shortStem && `Question: ${shortStem}`, `State: ${state}`,
      `(Read my answer with study.scene.get {"sessionId":"${sessionId || ''}"} first, then explain; do not just give me the answer. sessionId=${sessionId || ''} runId=${runId || ''} deckId=${deckId || ''} cardId=${cardId || ''})`];
  return [text, '', ...lines.filter(Boolean)].join('\n');
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
