/**
 * Unified AI conversation hook (#1354 D7): single streaming/history/abort/error state machine
 * shared across AiHelpDrawer, NextStepFollowupBar, and any future AI study surface.
 *
 * Lifecycle: `idle` -> `streaming` -> `done` | `error` | `aborted`.
 * Zero `marked` dependency so non-markdown lazy chunks stay `marked`-free.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostClient, UiLanguage } from '../types/contracts.js';
import { errorMessage } from '../host/sample-actions.js';
import { appendCappedTurns, type AiConversationStatus, type DialogueTurn } from '../host/ai-dialogue.js';
import { useStreamingBuffer } from './useStreamingBuffer.js';

export interface UseAiConversationOptions {
  host: HostClient;
  /** Entity/content scope key (e.g. `cardId` or `buildConversationScopeKey(cardId, prompt)`). */
  scopeKey: string;
  lang: UiLanguage;
  maxTurns?: number;
  /** Optional controlled/lifted history (owned by parent view across drawer open/close). */
  history?: readonly DialogueTurn[];
  onHistoryChange?: (scopeKey: string, nextTurns: DialogueTurn[]) => void;
  /** Optional fallback seed turns (e.g. saved follow-ups) used when neither controlled nor local history exists. */
  seedTurns?: readonly DialogueTurn[];
}

export interface SendConversationTurnParams {
  question: string;
  system: string;
  buildPrompt: (question: string, priorTurns: readonly DialogueTurn[]) => string;
  onBeforeSend?: () => void;
}

export interface UseAiConversationReturn {
  turns: DialogueTurn[];
  turnsRef: React.MutableRefObject<DialogueTurn[]>;
  status: AiConversationStatus;
  streaming: boolean;
  streamingText: string;
  reasoningChars: number;
  errorText: string | null;
  hasLocalOrLiftedHistory: boolean;
  send: (params: SendConversationTurnParams) => Promise<boolean>;
  abort: () => void;
  clearError: () => void;
  resetScope: () => void;
}

export function useAiConversation({
  host,
  scopeKey,
  lang,
  maxTurns = 20,
  history: controlledHistory,
  onHistoryChange,
  seedTurns,
}: UseAiConversationOptions): UseAiConversationReturn {
  const [localByScope, setLocalByScope] = useState<Record<string, DialogueTurn[]>>({});
  const [status, setStatus] = useState<AiConversationStatus>('idle');
  const [reasoningChars, setReasoningChars] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  const {
    text: streamingText,
    push: pushStreamingChunk,
    finish: finishStreaming,
    reset: resetStreaming,
  } = useStreamingBuffer();

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Abort in-flight stream and clear transient status whenever scope changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    resetStreaming();
    setReasoningChars(0);
    setErrorText(null);
  }, [scopeKey, resetStreaming]);

  const turns = useMemo<DialogueTurn[]>(() => {
    if (controlledHistory && controlledHistory.length > 0) return [...controlledHistory];
    const local = localByScope[scopeKey];
    if (local && local.length > 0) return local;
    if (seedTurns && seedTurns.length > 0) return [...seedTurns];
    return [];
  }, [controlledHistory, localByScope, scopeKey, seedTurns]);

  const turnsRef = useRef<DialogueTurn[]>(turns);
  turnsRef.current = turns;

  const hasLocalOrLiftedHistory = Boolean(
    (controlledHistory && controlledHistory.length > 0) ||
      (localByScope[scopeKey] && localByScope[scopeKey].length > 0),
  );

  const commitTurns = useCallback(
    (targetScope: string, nextTurns: DialogueTurn[]) => {
      const capped = nextTurns.slice(-Math.max(1, maxTurns));
      if (onHistoryChange) {
        onHistoryChange(targetScope, capped);
      } else {
        setLocalByScope((prev) => ({ ...prev, [targetScope]: capped }));
      }
    },
    [maxTurns, onHistoryChange],
  );

  const abort = useCallback(() => {
    const ctrl = abortRef.current;
    if (ctrl) {
      ctrl.abort();
      abortRef.current = null;
    }
    resetStreaming();
    setStatus((prev) => (prev === 'streaming' ? 'aborted' : prev));
  }, [resetStreaming]);

  const clearError = useCallback(() => {
    setErrorText(null);
  }, []);

  const resetScope = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    resetStreaming();
    setStatus('idle');
    setReasoningChars(0);
    setErrorText(null);
    turnsRef.current = [];
    if (onHistoryChange) {
      onHistoryChange(scopeKey, []);
    } else {
      setLocalByScope((prev) => ({ ...prev, [scopeKey]: [] }));
    }
  }, [onHistoryChange, resetStreaming, scopeKey]);

  const send = useCallback(
    async ({ question, system, buildPrompt, onBeforeSend }: SendConversationTurnParams): Promise<boolean> => {
      const q = question.trim();
      if (!q) return false;
      if (typeof host.streamComplete !== 'function') {
        setErrorText(
          lang === 'en'
            ? 'Streaming AI completion is unavailable on this host'
            : '当前 Host 未提供流式 AI 接口',
        );
        setStatus('error');
        return false;
      }

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      onBeforeSend?.();
      const priorTurns = turnsRef.current;
      const withUser = appendCappedTurns(priorTurns, { role: 'user', text: q }, maxTurns);
      turnsRef.current = withUser;
      commitTurns(scopeKey, withUser);

      setStatus('streaming');
      resetStreaming();
      setReasoningChars(0);
      setErrorText(null);

      try {
        const finalText = await host.streamComplete({
          system,
          prompt: buildPrompt(q, priorTurns),
          signal: ctrl.signal,
          onChunk: (delta) => {
            if (!mountedRef.current || ctrl.signal.aborted) return;
            pushStreamingChunk(delta);
          },
          onReasoning: (chars) => {
            if (!mountedRef.current || ctrl.signal.aborted) return;
            setReasoningChars(chars);
          },
        });
        if (!mountedRef.current || ctrl.signal.aborted) {
          if (mountedRef.current && ctrl.signal.aborted) setStatus('aborted');
          return false;
        }
        const flushed = finishStreaming();
        const reply = (finalText || flushed).trim();
        if (reply) {
          const next = appendCappedTurns(withUser, { role: 'assistant', text: reply }, maxTurns);
          turnsRef.current = next;
          commitTurns(scopeKey, next);
        }
        resetStreaming();
        setStatus('done');
        return true;
      } catch (err) {
        if (!mountedRef.current || ctrl.signal.aborted) {
          if (mountedRef.current && ctrl.signal.aborted) setStatus('aborted');
          return false;
        }
        const flushed = finishStreaming();
        const partial = flushed.trim();
        if (partial) {
          const next = appendCappedTurns(withUser, { role: 'assistant', text: partial }, maxTurns);
          turnsRef.current = next;
          commitTurns(scopeKey, next);
          resetStreaming();
        }
        setErrorText(errorMessage(err));
        setStatus('error');
        return false;
      } finally {
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          if (!mountedRef.current || ctrl.signal.aborted) {
            resetStreaming();
            if (mountedRef.current) setStatus('aborted');
          } else {
            finishStreaming();
          }
        }
      }
    },
    [commitTurns, finishStreaming, host, lang, maxTurns, pushStreamingChunk, resetStreaming, scopeKey],
  );

  return {
    turns,
    turnsRef,
    status,
    streaming: status === 'streaming',
    streamingText,
    reasoningChars,
    errorText,
    hasLocalOrLiftedHistory,
    send,
    abort,
    clearError,
    resetScope,
  };
}
