/**
 * Proactive 20-second Stuck Nudge Guardrails (Round 83 Track D1).
 *
 * Enforces all three ROADMAP-82-100 red lines for proactive AI prompts:
 * 1. Explicit disable switch (`proactiveHints === false` -> never fires).
 * 2. Strict rate limits (max 3 nudges per round, >= 60s cooldown, at most once per card).
 * 3. Non-interrupting (never schedules during text editing, open modals, or revealed cards;
 *    one-shot timer cancelled on any keypress/unmount — zero polling).
 */
import type { UiLanguage } from '../../types/contracts.js';

export const STUCK_NUDGE_DELAY_MS = 20_000;
export const MAX_STUCK_NUDGES_PER_ROUND = 3;
export const STUCK_NUDGE_COOLDOWN_MS = 60_000;

export interface StuckNudgePolicyInput {
  enabled: boolean;
  isActive: boolean;
  revealed: boolean;
  hasFeedback: boolean;
  isEditing: boolean;
  anyModalOpen: boolean;
  cardId: string | null;
  nudgedCardIds: ReadonlySet<string>;
  roundNudgeCount: number;
  lastNudgeAt: number | null;
  now?: number;
  cooldownMs?: number;
  maxPerRound?: number;
}

/** Pure policy check: returns true only if all 3 proactive guardrails permit scheduling a stuck nudge. */
export function shouldScheduleStuckNudge(input: StuckNudgePolicyInput): boolean {
  if (!input.enabled) return false;
  if (!input.isActive) return false;
  if (input.revealed || input.hasFeedback) return false;
  if (input.isEditing || input.anyModalOpen) return false;
  if (!input.cardId) return false;
  if (input.nudgedCardIds.has(input.cardId)) return false;

  const cap = input.maxPerRound ?? MAX_STUCK_NUDGES_PER_ROUND;
  if (input.roundNudgeCount >= cap) return false;

  const cooldown = input.cooldownMs ?? STUCK_NUDGE_COOLDOWN_MS;
  if (input.lastNudgeAt !== null) {
    const now = input.now ?? Date.now();
    if (now - input.lastNudgeAt < cooldown) return false;
  }

  return true;
}

/** Calm 1-line inline stuck hint (never steals focus or pops a modal). */
export function buildStuckNudgeMessage(lang: UiLanguage, asciiMode = false): string {
  const sep = asciiMode ? ' | ' : ' · ';
  if (lang === 'en') {
    return `Stuck? [t] Guided hint${sep}[h] AI Tutor${sep}[/proactive] Turn off`;
  }
  return `卡住了？[t] 带学提示${sep}[h] AI 讲解${sep}[/proactive] 关闭主动提示`;
}
