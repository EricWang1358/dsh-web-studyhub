/**
 * Single usage-recording point for AI dialogue entrypoints (#1354 P3-a, D11).
 *
 * Policy:
 * - `command` — an instruction the learner triggered for the assistant: counted in-session for
 *   adaptive chips (`assistant-chips.ts`, #1315).
 * - `answer` — learner prose such as a Feynman retell: never counted (#1406, #1469).
 * - Disk persistence (#1354 D11): NEVER writes to settings (`tui.json`), and NEVER persists raw
 *   user-typed text. Only invocations matching a registered recommended chip ID are persisted to
 *   the dedicated usage file (`tui-usage.json`) keyed strictly by canonical chip ID.
 */
import { extractPersistableChipStats, recordCommandStat, resolveAssistantChipId } from './assistant-chips.js';
import { saveTuiUsage } from '../host/tui-usage.js';
import { useTuiStore } from '../state/store.js';
import type { AssistantCommandStat, HostClient, PageId } from '../types/contracts.js';

export type AssistantDialogueInputKind = 'command' | 'answer';

/** The one predicate every entrypoint shares to decide whether an input is usage-worthy. */
export function countsAsAssistantCommand(kind: AssistantDialogueInputKind): boolean {
  return kind === 'command';
}

export interface RecordAssistantCommandUsageParams {
  host: HostClient;
  page: PageId;
  text: string;
  /** Defaults to `command`; retell and other learner prose must pass `answer`. */
  kind?: AssistantDialogueInputKind;
}

/**
 * Record one assistant input. Returns the stats map that is now in the store.
 * Free-text inputs stay strictly in-memory for the current session and are never written to disk;
 * only known recommended chip IDs are persisted to `tui-usage.json`.
 */
export function recordAssistantCommandUsage(
  params: RecordAssistantCommandUsageParams,
): Record<string, Record<string, AssistantCommandStat>> | undefined {
  const { host, page, text, kind = 'command' } = params;
  const current = useTuiStore.getState().preferences.assistantCommandStats;
  if (!countsAsAssistantCommand(kind)) return current;

  const next = recordCommandStat(current, page, text);
  useTuiStore.getState().setPreferences({ assistantCommandStats: next });

  // #1354 D11: only registered recommended chip IDs may be persisted, and only to `tui-usage.json`.
  const chipId = resolveAssistantChipId(text, page);
  if (!chipId) return next;

  const persistable = extractPersistableChipStats(next);
  if (!persistable) return next;

  const dshHome = (host as { dshHome?: string }).dshHome;
  void saveTuiUsage(
    { assistantChipStats: persistable },
    dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
  ).catch(() => {});
  return next;
}
