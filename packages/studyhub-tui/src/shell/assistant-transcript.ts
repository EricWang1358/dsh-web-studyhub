/**
 * Assistant transcript lines (#1409): turns a conversation into wrapped, coloured terminal lines.
 *
 * Each speaker gets its own colour so a long session can be scanned by eye: the learner's own
 * instruction, the AI's answer and the status notes no longer share one grey. Wrapping happens on
 * plain text first; colour is applied per finished line, so widths stay correct.
 */
import type { ChalkInstance } from 'chalk';
import { wrapDisplay } from '../render/cjk.js';
import type { ThemeTokens } from '../theme/tokens.js';

export type TranscriptRole = 'user' | 'assistant' | 'system';

export interface TranscriptTurn {
  role: TranscriptRole;
  text: string;
  actionSummary?: string;
  /** Already-localised stage name, e.g. "复述"; omitted when the turn has no stage. */
  stageLabel?: string;
}

export interface TranscriptLabels {
  user: string;
  assistant: string;
  system: string;
  stage: string;
}

type Paint = (text: string) => string;

export interface TranscriptPalette {
  header: Record<TranscriptRole, Paint>;
  body: Record<TranscriptRole, Paint>;
  summary: Record<TranscriptRole, Paint>;
  stage: Paint;
  code: Paint;
  right: Paint;
  missed: Paint;
  wrong: Paint;
}

/** Verdict line prefixes written by the retell check; coloured by outcome. */
const VERDICT_PREFIXES: ReadonlyArray<{ re: RegExp; tone: 'right' | 'missed' | 'wrong' }> = Object.freeze([
  { re: /^(\s*)(讲对了：|Right:\s?)/, tone: 'right' },
  { re: /^(\s*)(漏掉了：|Missed:\s?)/, tone: 'missed' },
  { re: /^(\s*)(讲错了：|Wrong:\s?)/, tone: 'wrong' },
]);

const INLINE_CODE_RE = /`[^`]+`/g;

export function buildTranscriptPalette(theme: ThemeTokens, chalk: ChalkInstance): TranscriptPalette {
  const hex = (color: string): Paint => (text) => chalk.hex(color)(text);
  const bold = (color: string): Paint => (text) => chalk.hex(color).bold(text);
  return {
    header: { user: bold(theme.accent), assistant: bold(theme.ai), system: bold(theme.muted) },
    body: { user: hex(theme.accent), assistant: hex(theme.text), system: hex(theme.muted) },
    summary: { user: hex(theme.accent), assistant: hex(theme.success), system: hex(theme.muted) },
    stage: hex(theme.dim),
    code: hex(theme.warning),
    right: bold(theme.success),
    missed: bold(theme.warning),
    wrong: bold(theme.error),
  };
}

function paintBodyLine(line: string, role: TranscriptRole, palette: TranscriptPalette): string {
  if (!line.trim()) return line;
  const base = palette.body[role];
  if (role !== 'assistant') return base(line);
  for (const { re, tone } of VERDICT_PREFIXES) {
    const m = re.exec(line);
    if (m) return `${m[1]}${palette[tone](m[2])}${paintInlineCode(line.slice(m[0].length), base, palette.code)}`;
  }
  return paintInlineCode(line, base, palette.code);
}

function paintInlineCode(line: string, base: Paint, code: Paint): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(INLINE_CODE_RE)) {
    const start = m.index ?? 0;
    if (start > last) out += base(line.slice(last, start));
    out += code(m[0]);
    last = start + m[0].length;
  }
  if (last < line.length) out += base(line.slice(last));
  return out;
}

/**
 * The conversation in view (#1426): turns about `scope` (a card id, or '' away from any card).
 * Turns about other cards are kept and only counted, so the dock opens clean on a new card.
 */
export function turnsInScope<T extends { scope?: string }>(turns: readonly T[], scope: string): { current: T[]; earlier: number } {
  const current = turns.filter((turn) => (turn.scope ?? '') === scope);
  return { current, earlier: turns.length - current.length };
}

/** Lines for one turn: speaker header, optional action summary, wrapped body, blank separator. */
export function formatTurnLines(
  turn: TranscriptTurn,
  opts: { wrapW: number; labels: TranscriptLabels; palette: TranscriptPalette },
): string[] {
  const { wrapW, labels, palette } = opts;
  const out: string[] = [];
  const stageTag = turn.stageLabel ? palette.stage(` [${labels.stage}: ${turn.stageLabel}]`) : '';
  out.push(`${palette.header[turn.role](labels[turn.role])}${stageTag}${palette.header[turn.role](':')}`);
  if (turn.actionSummary) {
    for (const line of wrapDisplay(`  > ${turn.actionSummary}`, wrapW)) out.push(palette.summary[turn.role](line));
  }
  for (const para of turn.text.split('\n')) {
    for (const line of wrapDisplay(para ? `  ${para}` : ' ', wrapW)) out.push(paintBodyLine(line, turn.role, palette));
  }
  out.push('');
  return out;
}
