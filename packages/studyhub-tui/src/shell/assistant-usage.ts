/**
 * Single usage-recording point for AI dialogue entrypoints (#1354 P3-a).
 *
 * Before this file, only `AssistantPanel` counted commands; the two drawers did not, and the
 * guided-retell branch had to rely on call ordering to stay out of the stats. The policy now
 * lives here, in one place:
 *
 * - `command` — an instruction the learner typed for the assistant: counted (drives the
 *   adaptive chip promotion in `assistant-chips.ts`, #1315).
 * - `answer` — learner prose such as a Feynman retell: never counted (#1406, #1469), because
 *   counting it would promote repeated short answers into command chips and evict real commands.
 */
import { recordCommandStat } from './assistant-chips.js';
import { saveTuiPreferences } from '../host/tui-prefs.js';
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
 * Record one assistant input. Returns the stats map that is now in the store, so callers that
 * need it (the panel's chip render) observe exactly what was persisted.
 */
export function recordAssistantCommandUsage(
  params: RecordAssistantCommandUsageParams,
): Record<string, Record<string, AssistantCommandStat>> | undefined {
  const { host, page, text, kind = 'command' } = params;
  const current = useTuiStore.getState().preferences.assistantCommandStats;
  if (!countsAsAssistantCommand(kind)) return current;

  const next = recordCommandStat(current, page, text);
  useTuiStore.getState().setPreferences({ assistantCommandStats: next });
  const dshHome = (host as { dshHome?: string }).dshHome;
  void saveTuiPreferences(
    { assistantCommandStats: next },
    dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
  ).catch(() => {});
  return next;
}
