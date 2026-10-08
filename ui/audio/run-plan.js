import { ui, uiFormat } from '../i18n.js';

/* What the one start button of the audio form says it will do, and what the estimate under it is asked about. Pure: the form gives the chosen files and their
   pre-flight checks (ui/audio/preflight.js). The button is the learner's consent, so it names the work in full: how long the recording is, that a long one
   is split (and into how many requests), and that several recordings become ONE transcript. */

/** The totals of the chosen recordings: { count, known, split, minutes, parts, requests, merged }. `known` is false while a check is missing or a file is blocked. */
export function runPlan(files, checks = {}) {
  const audio = files.filter(file => file.kind !== 'subtitle');
  let seconds = 0, parts = 0, requests = 0, known = audio.length > 0, split = false;
  for (const file of audio) {
    const check = checks[file.key];
    if (!check || check.checking || check.blocked) { known = false; continue; }
    if (check.issue?.code === 'long-split') {
      split = true;
      seconds += (check.issue.minutes || 0) * 60;
      parts += check.issue.parts || 1;
      requests += check.issue.requests ?? check.issue.parts ?? 1;
    } else { seconds += check.seconds || 0; parts += 1; requests += check.requests || 1; }
  }
  return { count: audio.length, known, split, minutes: Math.max(1, Math.round(seconds / 60)), parts, requests, merged: audio.length > 1 };
}

/** The text of the start button. A split is not a second question: pressing start accepts it, and the button says so. */
export function startLabel(files, checks = {}) {
  const plan = runPlan(files, checks);
  if (plan.split && plan.known) {
    const work = [plan.minutes, plan.parts, plan.requests];
    return plan.merged ? uiFormat('开始（约 {0} 分钟，分 {1} 段，{2} 次请求；{3} 个录音合成 1 份逐字稿）', [...work, plan.count])
      : uiFormat('开始（约 {0} 分钟，分 {1} 段，{2} 次请求）', work);
  }
  return plan.merged ? uiFormat('开始（{0} 个录音合成 1 份逐字稿）', [plan.count]) : ui('开始导入');
}

const CJK = /[㐀-鿿]/g;
/** 'zh' when most letters are Chinese characters, else 'en': the same rule the pipeline uses to choose the translation's direction (lib/transcript.js cjkShare). */
export function textLanguage(text) {
  const letters = String(text).replace(/[\s\d\p{P}]/gu, '');
  return letters && (letters.match(CJK) || []).length / letters.length >= 0.5 ? 'zh' : 'en';
}

/** The characters of what a subtitle file says, without its numbers and time stamps (the part the text models read). */
export function subtitleChars(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  if (/^\s*(\{|\[\s*\{)/.test(text)) {
    try {
      const value = JSON.parse(text), body = Array.isArray(value) ? value : value?.body;
      if (Array.isArray(body)) return body.reduce((sum, cue) => sum + String(cue?.content ?? '').trim().length, 0);
    } catch { /* not JSON after all: read it as lines */ }
  }
  return text.split(/\r?\n/).filter(line => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes('-->') && !/^(WEBVTT|NOTE)\b/.test(line))
    .reduce((sum, line) => sum + line.replace(/^\s*\[\d[\d:.,]*\]\s*/, '').trim().length, 0);
}

const termCount = terms => String(terms || '').split(/[\n,，、;；]+/).map(term => term.trim()).filter(Boolean).length;

/**
 * What the estimate under the button is asked: { enabled, request }. A subtitle file's text is known, so its length and language are exact; a recording's
 * language is not known before it is transcribed, so the estimate is asked for both (`language: 'auto'`) and shows the range that covers either.
 */
export function estimateRequest(files, checks, { subject = '', terms = '' } = {}) {
  const base = { feature: 'audio', terms: termCount(terms), subject: String(subject).trim() };
  const subtitle = files.find(file => file.kind === 'subtitle');
  if (subtitle) {
    const chars = subtitleChars(subtitle.text);
    return { enabled: chars > 0, request: { ...base, transcriptChars: chars, language: textLanguage(subtitle.text) } };
  }
  const seconds = files.reduce((sum, file) => sum + (checks[file.key]?.seconds || 0), 0), minutes = Math.round(seconds / 60);
  return { enabled: minutes > 0, request: { ...base, minutes, language: 'auto' } };
}
