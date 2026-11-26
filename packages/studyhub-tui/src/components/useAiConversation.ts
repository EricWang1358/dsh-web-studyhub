/**
 * Single AI dialogue transport for every AI study entrypoint (#1354 P3-a).
 *
 * Explain (`AiHelpDrawer`), Next-Step follow-up (`NextStepFollowupBar`), and Guided Study
 * (`AssistantPanel`) used to duplicate: a local `AbortController` ref, their own
 * `ctrl.signal.aborted` checks, their own error copy, and their own "is streaming available"
 * gate. They now share this hook:
 *
 * - `send()` always starts from a fresh controller and aborts the previous turn.
 * - An outcome is published only while this request still owns `abortRef`; a newer `send()`
 *   therefore resolves the old one as `superseded` and the old caller must not write any state.
 * - `abort()` marks the owning request `aborted` (only that caller may clear the ref).
 * - Errors go through `describeAiDialogueError`, so one copy is shown everywhere.
 *
 * Retell (`teach.retell`) is request/response rather than token streaming, so it enters this
 * layer through `submitRetellEvaluation` and shares the same error/usage policy, not `send()`.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ChatMessage, HostClient, UiLanguage } from '../types/contracts.js';
import {
  aiStreamUnavailableMessage,
  describeAiDialogueError,
  isAiStreamingAvailable,
} from '../host/ai-dialogue.js';

export type AiConversationStatus = 'done' | 'aborted' | 'superseded' | 'unavailable' | 'error';

export interface AiConversationSendParams {
  system: string;
  /** Single-string rendering for adapters that only read `(system, prompt)`. */
  prompt?: string;
  /** True multi-turn history (#1445/#1447): forwarded verbatim when non-empty. */
  messages?: readonly ChatMessage[];
  onChunk?: (delta: string) => void;
  onReasoning?: (chars: number) => void;
}

export type AiConversationOutcome =
  | { status: 'done'; text: string }
  | { status: 'aborted'; text: '' }
  | { status: 'superseded'; text: '' }
  | { status: 'unavailable'; error: string; text: '' }
  | { status: 'error'; error: string; text: '' };

export interface AiConversation {
  send: (params: AiConversationSendParams) => Promise<AiConversationOutcome>;
  /** Abort the in-flight turn; its owning `send()` resolves as `aborted`. */
  abort: () => void;
}

export function useAiConversation(host: HostClient, lang: UiLanguage): AiConversation {
  const abortRef = useRef<AbortController | null>(null);
  const hostRef = useRef(host);
  const langRef = useRef(lang);
  hostRef.current = host;
  langRef.current = lang;

  useEffect(
    () => () => {
      // Unmount is not a user-visible outcome: abort without publishing `aborted`.
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async (params: AiConversationSendParams): Promise<AiConversationOutcome> => {
    const activeHost = hostRef.current;
    if (!isAiStreamingAvailable(activeHost) || typeof activeHost.streamComplete !== 'function') {
      return { status: 'unavailable', error: aiStreamUnavailableMessage(langRef.current), text: '' };
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let outcome: AiConversationOutcome;
    try {
      const text = await activeHost.streamComplete({
        system: params.system,
        prompt: params.prompt ?? '',
        ...(params.messages && params.messages.length > 0 ? { messages: params.messages } : {}),
        signal: ctrl.signal,
        ...(params.onChunk ? { onChunk: params.onChunk } : {}),
        ...(params.onReasoning ? { onReasoning: params.onReasoning } : {}),
      });
      outcome = { status: 'done', text: typeof text === 'string' ? text : String(text ?? '') };
    } catch (err) {
      outcome = ctrl.signal.aborted
        ? { status: 'aborted', text: '' }
        : { status: 'error', error: describeAiDialogueError(err, langRef.current), text: '' };
    }

    // Ownership gate: only the newest request may publish its outcome. A newer send() (or an
    // unmount) has already replaced/cleared the ref, so this stale caller stays silent.
    if (abortRef.current !== ctrl) {
      return { status: 'superseded', text: '' };
    }
    abortRef.current = null;
    return outcome;
  }, []);

  return { send, abort };
}
