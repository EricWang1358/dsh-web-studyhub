/**
 * Long-form reading typography & rhythm formatter (Round 88 Track A7).
 *
 * Transforms dense PDF/text extracts into comfortable, scannable terminal prose:
 * - CJK-aware reading-time estimator (~350 CJK chars/min, ~220 Latin words/min)
 * - Clean paragraph breathing (1 blank line in relaxed mode, compact when `compactMode=true`)
 * - Subtle breathing before structural section headings (`第N章`, `Chapter N`, `1.2 ...`)
 * - Strictly `marked`-free and O(n) single-pass.
 */
import { wrapDisplay } from './cjk.js';
import type { UiLanguage } from '../types/contracts.js';

const HEADING_LIKE_RE = /^(?:第[一二三四五六七八九十百千万0-9]+[章节讲节篇部分]|Chapter\s+\d+|Section\s+\d+|\d+(?:\.\d+){1,3}\s+\S)/i;
const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;

/** Estimate reading duration in minutes (minimum 1 when text is non-empty). */
export function estimateReadingMinutes(text: string): number {
  const clean = String(text ?? '').trim();
  if (!clean) return 0;
  const cjkMatches = clean.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = clean.replace(CJK_CHAR_RE, ' ');
  const latinWords = nonCjk.trim() ? nonCjk.trim().split(/\s+/).length : 0;
  const mins = cjkCount / 350 + latinWords / 220;
  return Math.max(1, Math.round(mins));
}

export function formatReadingTimeLabel(text: string, lang: UiLanguage): string {
  const mins = estimateReadingMinutes(text);
  if (mins <= 0) return '';
  return lang === 'en' ? `~${mins} min read` : `约 ${mins} 分钟`;
}

export interface LongformOptions {
  /** Relaxed mode inserts comfortable 1-line paragraph breathing (default true). */
  relaxed?: boolean;
}

/**
 * Format plain extracted long-form text into wrapped terminal lines with clean paragraph rhythm.
 * Preserves short explicit lines (lists, equations, headings) while wrapping long paragraphs cleanly.
 */
export function formatLongformProse(
  text: string,
  width: number,
  opts: LongformOptions = {},
): string[] {
  const relaxed = opts.relaxed !== false;
  const safeW = Math.max(12, Math.floor(width));
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  // Collapse 3+ consecutive newlines to a single paragraph break
  const blocks = normalized.replace(/\n{3,}/g, '\n\n').split(/\n\n+/);
  const out: string[] = [];

  for (let b = 0; b < blocks.length; b += 1) {
    const rawBlock = blocks[b].trim();
    if (!rawBlock) continue;
    const rawLines = rawBlock.split('\n');
    const isHeading = rawLines.length === 1 && HEADING_LIKE_RE.test(rawLines[0].trim());

    if (out.length > 0 && (relaxed || isHeading)) {
      if (out[out.length - 1] !== '') out.push('');
    }

    for (let i = 0; i < rawLines.length; i += 1) {
      const line = rawLines[i].trimEnd();
      if (!line.trim()) {
        if (relaxed && out.length > 0 && out[out.length - 1] !== '') out.push('');
        continue;
      }
      if (i > 0 && HEADING_LIKE_RE.test(line.trim()) && out.length > 0 && out[out.length - 1] !== '') {
        out.push('');
      }
      const wrapped = wrapDisplay(line, safeW);
      for (const wl of wrapped) out.push(wl);
    }
  }

  return out;
}
