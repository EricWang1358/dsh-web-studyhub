import { ui, uiFormat } from '../i18n.js';

export const SOCRATIC_STAGE_ORDER = Object.freeze(['ask', 'answer', 'judge', 'retell', 'summary']);

const STAGE_LABELS = Object.freeze({
  ask: '提问',
  answer: '作答',
  judge: '判定',
  retell: '复述',
  summary: '小结',
});

const HINT_LABELS = Object.freeze({
  0: 'L0 无提示',
  1: 'L1 最小提示',
  2: 'L2 关键线索',
});

export function socraticStageLabel(stage) {
  return ui(STAGE_LABELS[stage] || STAGE_LABELS.ask);
}

export function socraticHintTag(hintLevel) {
  const level = Number.isInteger(hintLevel) ? Math.max(0, Math.min(2, hintLevel)) : 0;
  return `L${level}`;
}

export function socraticHintLabel(hintLevel) {
  const level = Number.isInteger(hintLevel) ? Math.max(0, Math.min(2, hintLevel)) : 0;
  return ui(HINT_LABELS[level] || HINT_LABELS[0]);
}

function roleLabel(turn) {
  if (turn?.role === 'learner') {
    return turn.kind === 'retell' ? ui('我的复述') : ui('我的作答');
  }
  if (turn?.kind === 'hint') return ui('AI 提示');
  if (turn?.kind === 'retell-prompt' || turn?.kind === 'retell-probe') return ui('AI 追问');
  if (turn?.kind === 'summary') return ui('AI 小结');
  if (turn?.kind === 'reveal') return ui('AI 揭晓与追问');
  return ui('AI 引导提问');
}

/**
 * Formats a single inline Socratic turn for clipboard copy (「复制本条」).
 * Contains question stem, stage, hint tier (L0/L1/L2), and learner/AI text.
 */
export function formatSocraticTurnCopy(turn, { prompt = '', topic = '', state = null } = {}) {
  if (!turn) return '';
  const question = String(prompt || topic || '').trim();
  const stage = socraticStageLabel(turn.stage || state?.stage || 'ask');
  const hint = socraticHintLabel(turn.hintLevel ?? state?.hintLevel ?? 0);
  const lines = [
    question ? uiFormat('题目：{0}', [question]) : '',
    uiFormat('阶段：{0} ｜ 提示等级：{1}', [stage, hint]),
    `${roleLabel(turn)}：${String(turn.text || '').trim()}`,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Formats the full inline Socratic conversation for a card (「复制整段」).
 * Contains question stem, stage, hint level, every learner answer and AI probe, and closing summary.
 */
export function formatSocraticTranscriptCopy({ prompt = '', topic = '', state = null } = {}) {
  const record = state || {};
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const header = [
    uiFormat('苏格拉底带学：{0}', [topic || ui('当前题目')]),
    prompt ? uiFormat('题目：{0}', [String(prompt).trim()]) : '',
    uiFormat('当前阶段：{0} ｜ 提示等级：{1}', [socraticStageLabel(record.stage || 'ask'), socraticHintLabel(record.hintLevel ?? 0)]),
  ].filter(Boolean);

  const body = turns.map((turn, idx) => {
    const stage = socraticStageLabel(turn.stage || 'ask');
    const hint = socraticHintTag(turn.hintLevel ?? 0);
    return `${idx + 1}. [${stage} / ${hint}] ${roleLabel(turn)}：${String(turn.text || '').trim()}`;
  });

  const summary = record.summary;
  const summaryLines = [];
  if (summary) {
    summaryLines.push(summary.mastered ? ui('判定结果：已掌握（无提示独立过关）') : uiFormat('判定结果：待巩固（最高提示 {0}）', [socraticHintTag(summary.maxHintLevelUsed ?? summary.hintLevel ?? 0)]));
    if (summary.nextStep) summaryLines.push(uiFormat('下一步建议：{0}', [summary.nextStep]));
  }

  return [
    header.join('\n'),
    '',
    ...body,
    ...(summaryLines.length ? ['', ui('阶段小结'), ...summaryLines] : []),
  ].join('\n').trim();
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
