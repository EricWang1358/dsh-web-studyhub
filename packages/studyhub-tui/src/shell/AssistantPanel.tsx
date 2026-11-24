/**
 * Persistent AI Assistant & Unified Guided Study / Retell Panel (#1315 Phase 1 UX Gate).
 *
 * Full-workflow integration principles (docs/ASSISTANT-UX.md):
 * 1. One-key reachable anywhere (`Ctrl+Space` right-docked non-blocking, `Ctrl+G` open+focus; `Esc` collapses preserving state).
 * 2. Full live context awareness (active page, course, current card/index/wrong state, filter, practice stack).
 * 3. Context chips FIRST (`[1]–[4]`), input box below; 3x repeated command auto-promotes to permanent page chip.
 * 4. Right-docked non-stealing layout: never covers the question; user can answer/page while open!
 * 5. Clear before/after feedback: `将执行：动作+参数` (ConfirmDialog) -> `已完成：...` + `[z] 撤销`.
 * 6. Never dead-ends: unsupported/offline requests give nearest alternative + `[P] 复制提示词` (OSC 52 / file fallback).
 * 7. Perceptible latency: streaming output, `正在执行：xxx`, and >2s one-shot progress notice (zero idle polling).
 * 8. Concise Chinese short sentences; never parrots raw user text.
 * 9. Keyboard-first (`1-4`, `i`, `Tab`, `z`, `P`, `c/C/y`, `F`, `S`, `Esc`); `Alt+Click` additive.
 * 10. `marked`-free (`ScrollView` + `wrapDisplay`).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { useStableWindowSize } from '../components/resize.js';
import {
  KEY_LAYER_DRAWER,
  KEY_LAYER_MODAL_FRAME,
  useScopedInput as useInput,
} from '../components/key-dispatcher.js';
import { PAGE_REGISTRY, type HostClient, type PageId, type UiLanguage } from '../types/contracts.js';
import { t, useTuiStore, type AssistantCardContext, type AssistantTabId } from '../state/store.js';
import { getColorLevel, makeChalk, useTheme } from '../theme/tokens.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../components/Modal.js';
import { SelectList, type SelectOption } from '../components/SelectList.js';
import { SectionHeader } from '../components/Layout.js';
import { Panel } from '../components/Panel.js';
import { ScrollView } from '../components/ScrollView.js';
import { TextInput } from '../components/TextInput.js';
import { ClickableBox } from '../components/mouse.js';
import { useModalFooterHints } from '../components/focus.js';
import { useStreamingBuffer } from '../components/useStreamingBuffer.js';
import { tryAction } from '../host/sample-actions.js';
import {
  buildUnifiedAiSystemPrompt,
  formatRetellVerdictLines,
  submitRetellEvaluation,
} from '../host/ai-dialogue.js';
import { atomicWriteExportText, defaultBackupFilePath } from '../host/atomic-write.js';
import { saveTuiPreferences } from '../host/tui-prefs.js';
import {
  copyTextWithFallback,
  formatSessionTranscript,
  stageLabel,
  type CopyTurnRecord,
  type GuidedStageId,
} from '../render/clipboard.js';
import { displayWidth, truncateDisplay, wrapDisplay } from '../render/cjk.js';
import { buildContextChips, recordCommandStat, type AssistantChip } from './assistant-chips.js';
import { buildFallbackPrompt, errorReasonWriteIntent, parseAssistantIntent, type AssistantIntent } from './assistant-intent.js';
import { SET_ERROR_REASON_ACTION, errorReasonArgs, errorReasonName, type ErrorReasonTarget } from './error-reason-intent.js';
import { ERROR_REASONS, reasonLabel, reasonShort } from '../views/wrongbook/helpers.js';
import type { ErrorReasonId } from '../views/wrongbook/types.js';
import {
  formatWorkflowChecklist,
  isWorkflowComplete,
  markWorkflowStepResult,
  planAssistantWorkflow,
  type AssistantWorkflowPlan,
} from './assistant-workflow.js';
import { pruneTurnsWithSummary } from './assistant-memory.js';
import { buildTranscriptPalette, formatTurnLines, turnsInScope } from './assistant-transcript.js';
import { currentCourse, dueToday, modelInfo, wrongCount } from './data.js';

/** Each exchange is two turns now that the learner's instruction is recorded too (#1410). */
export const MAX_ASSISTANT_TURNS = 32;
export const SLOW_EXECUTION_NOTICE_MS = 2000;

export const GUIDED_STAGES: readonly GuidedStageId[] = Object.freeze([
  'question',
  'answer',
  'judge',
  'retell',
  'summary',
]);

export interface AssistantTurn extends CopyTurnRecord {
  id: string;
  at: number;
  /** The card this turn was about; '' or absent when asked away from any card (#1426). */
  scope?: string;
  skipped?: boolean;
  verdict?: {
    passed: boolean;
    right: string[];
    missed: string[];
    wrong: string[];
    gap?: string;
  };
}

export interface AssistantUndoEntry {
  label: string;
  run: () => Promise<string>;
}

export interface AssistantPanelProps {
  host: HostClient;
  /** Whether the panel currently has keyboard focus (`false` = right-docked passive mode, does NOT steal focus!). */
  isActive: boolean;
  onClose: () => void;
  /** Explicit docked container width/height when mounted inside AppShell split row. */
  width?: number;
  height?: number;
  /** True when docked beside main page (never uses modal overlay!). */
  docked?: boolean;
  /** Override slow-execution notice threshold (ms) for fast deterministic tests (default 2000ms). */
  slowNoticeMs?: number;
  /** Optional override for card context (defaults to `store.assistantCardContext`). */
  cardContext?: AssistantCardContext | null;
  /** Optional custom copy stdout for deterministic tests. */
  copyStdout?: { isTTY?: boolean; write?: (chunk: string) => unknown };
}

/**
 * Pure sizing helper for the Assistant / Guided Study panel (#1315).
 * Standalone default: `min(columns - 4, 120)` wide, `rows - 2` tall.
 * Fullscreen (`[F]`): `columns - 2` wide, `rows - 2` tall.
 */
export function resolveAssistantPanelSize(
  columns: number,
  rows: number,
  fullscreen: boolean,
): { width: number; height: number } {
  const safeCols = Math.max(40, columns);
  const safeRows = Math.max(14, rows);
  const width = fullscreen ? Math.max(40, safeCols - 2) : Math.max(40, Math.min(safeCols - 4, 120));
  const height = Math.max(12, safeRows - 2);
  return { width, height };
}

interface PersistentSessionMemory {
  turns: AssistantTurn[];
  retellRecords: Array<{
    cardId?: string;
    stage: 'retell';
    passed?: boolean;
    skipped?: boolean;
    gap?: string;
    at: number;
  }>;
  lastUndo: AssistantUndoEntry | null;
  lastFallback: { reason: string; altLabel: string; altCommand: string; instruction: string } | null;
}

const sessionMemory: PersistentSessionMemory = {
  turns: [],
  retellRecords: [],
  lastUndo: null,
  lastFallback: null,
};

export function _resetAssistantSessionMemory(): void {
  sessionMemory.turns = [];
  sessionMemory.retellRecords = [];
  sessionMemory.lastUndo = null;
  sessionMemory.lastFallback = null;
}

export function _getAssistantRetellRecords() {
  return [...sessionMemory.retellRecords];
}

let turnSeq = 0;

function trimTurns(turns: readonly AssistantTurn[], lang: UiLanguage = 'zh'): AssistantTurn[] {
  return pruneTurnsWithSummary(turns, MAX_ASSISTANT_TURNS, lang);
}

function formatStageStrip(current: GuidedStageId, lang: UiLanguage, asciiMode: boolean): string {
  const arrow = asciiMode ? ' -> ' : ' → ';
  return GUIDED_STAGES.map((st) => {
    const lbl = stageLabel(st, lang);
    return st === current ? `[${lbl}]` : lbl;
  }).join(arrow);
}

export const AssistantPanel = memo(function AssistantPanel({
  host,
  isActive,
  onClose,
  width: widthProp,
  height: heightProp,
  docked = false,
  slowNoticeMs = SLOW_EXECUTION_NOTICE_MS,
  cardContext: cardContextProp,
  copyStdout,
}: AssistantPanelProps) {
  const theme = useTheme();
  const { columns, rows } = useStableWindowSize();
  const { stdout } = useStdout();
  const page = useTuiStore((s) => s.page);
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const commandStats = useTuiStore((s) => s.preferences.assistantCommandStats);
  const snapshot = useTuiStore((s) => s.snapshot);
  const cfg = useTuiStore((s) => s.desktopConfig);
  const binding = useTuiStore((s) => s.binding);
  const practiceStack = useTuiStore((s) => s.practiceStack);
  const tab = useTuiStore((s) => s.assistantTab);
  const stage = useTuiStore((s) => s.assistantStage);
  const fullscreen = useTuiStore((s) => s.assistantFullscreen);
  const storeCardCtx = useTuiStore((s) => s.assistantCardContext);
  const setTab = useTuiStore((s) => s.setAssistantTab);
  const setStage = useTuiStore((s) => s.setAssistantStage);
  const setFullscreen = useTuiStore((s) => s.setAssistantFullscreen);
  const setFocused = useTuiStore((s) => s.setAssistantFocused);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const notify = useTuiStore((s) => s.notify);
  const navigate = useTuiStore((s) => s.navigate);

  const cardCtx = cardContextProp !== undefined ? cardContextProp : storeCardCtx;
  const courseName = currentCourse(snapshot);
  const model = useMemo(() => modelInfo(cfg, binding, snapshot), [cfg, binding, snapshot]);
  const modelReady = Boolean(model.ready || host.streamComplete);

  const [allTurns, setTurns] = useState<AssistantTurn[]>(() => [...sessionMemory.turns]);
  // #1426: only the conversation about the card in view is shown; the rest folds into one line.
  const turnScope = cardCtx?.cardId ?? '';
  const turnScopeRef = useRef(turnScope);
  turnScopeRef.current = turnScope;
  // A request keeps the scope it started in: its reply is filed under the card it was asked on,
  // even when the learner has moved to another card before it arrives.
  const requestScopeRef = useRef<string | null>(null);
  const [busyScope, setBusyScope] = useState('');
  const [showEarlier, setShowEarlier] = useState(false);
  useEffect(() => {
    setShowEarlier(false);
  }, [turnScope]);
  const scopedTurns = useMemo(() => turnsInScope(allTurns, turnScope), [allTurns, turnScope]);
  const earlierTurnCount = scopedTurns.earlier;
  const turns = showEarlier ? allTurns : scopedTurns.current;
  const [selectedTurnIdx, setSelectedTurnIdx] = useState<number>(() => Math.max(0, sessionMemory.turns.length - 1));
  const [inputValue, setInputValue] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [execStatus, setExecStatus] = useState<string | null>(null);
  const [slowNotice, setSlowNotice] = useState(false);
  const [lastUndo, setLastUndo] = useState<AssistantUndoEntry | null>(() => sessionMemory.lastUndo);
  const [lastFallback, setLastFallback] = useState(sessionMemory.lastFallback);
  const [pendingConfirm, setPendingConfirm] = useState<Extract<AssistantIntent, { kind: 'write_confirm' }> | null>(null);
  // #1439: the card whose mistake reason the learner is choosing; the reason list is open while set.
  const [reasonPickFor, setReasonPickFor] = useState<ErrorReasonTarget | null>(null);

  const stream = useStreamingBuffer();
  const abortRef = useRef<AbortController | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkflowRef = useRef<AssistantWorkflowPlan | null>(null);
  const mountedRef = useRef(true);

  const clearSlowTimer = useCallback(() => {
    if (slowTimerRef.current !== null) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    if (mountedRef.current) setSlowNotice(false);
  }, []);

  const beginExecution = useCallback(
    (label: string) => {
      clearSlowTimer();
      requestScopeRef.current = turnScopeRef.current;
      setBusyScope(turnScopeRef.current);
      setBusy(true);
      setExecStatus(t(lang, `正在执行：${label}`, `Running: ${label}`));
      slowTimerRef.current = setTimeout(() => {
        slowTimerRef.current = null;
        if (mountedRef.current) setSlowNotice(true);
      }, Math.max(10, slowNoticeMs));
    },
    [clearSlowTimer, lang, slowNoticeMs],
  );

  const endExecution = useCallback(() => {
    clearSlowTimer();
    requestScopeRef.current = null;
    if (mountedRef.current) {
      setBusy(false);
      setExecStatus(null);
    }
  }, [clearSlowTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (slowTimerRef.current !== null) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
    };
  }, []);

  // Context-aware chips (2–4 items) placed ABOVE input box (#1315 UX Gate #3 & #9)
  const chips = useMemo(
    () =>
      buildContextChips({
        page,
        card: cardCtx,
        practiceStack,
        statsByPage: commandStats,
        lang,
      }),
    [page, cardCtx, practiceStack, commandStats, lang],
  );

  const recordUsage = useCallback(
    (cmdText: string) => {
      const nextStats = recordCommandStat(useTuiStore.getState().preferences.assistantCommandStats, page, cmdText);
      setPreferences({ assistantCommandStats: nextStats });
      const dshHome = (host as { dshHome?: string }).dshHome;
      void saveTuiPreferences(
        { assistantCommandStats: nextStats },
        dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
      ).catch(() => {});
    },
    [page, setPreferences, host],
  );

  const appendTurn = useCallback((turn: Omit<AssistantTurn, 'id' | 'at'>) => {
    const entry: AssistantTurn = { ...turn, id: `at-${++turnSeq}`, at: Date.now(), scope: requestScopeRef.current ?? turnScopeRef.current };
    const next = trimTurns([...sessionMemory.turns, entry]);
    sessionMemory.turns = next;
    if (mountedRef.current) {
      setTurns(next);
      setSelectedTurnIdx(next.length - 1);
    }
    return entry;
  }, []);

  const registerUndo = useCallback((entry: AssistantUndoEntry | null) => {
    sessionMemory.lastUndo = entry;
    if (mountedRef.current) setLastUndo(entry);
  }, []);

  const doCopy = useCallback(
    async (text: string, whatZh: string, whatEn: string) => {
      const res = await copyTextWithFallback(text, {
        stdout: copyStdout ?? stdout,
        libraryRoot: host.getLibraryRoot?.() || snapshot?.root || null,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error || t(lang, '复制失败', 'Copy failed'), 'warning');
        return;
      }
      if (res.method === 'osc52') {
        notify(
          t(lang, `已复制${whatZh}（${res.chars} 字）`, `Copied ${whatEn} (${res.chars} chars)`),
          'success',
        );
      } else {
        notify(
          t(lang, `已保存${whatZh}（${res.chars} 字）至 ${res.filePath}`, `Saved ${whatEn} (${res.chars} chars) to ${res.filePath}`),
          'info',
        );
      }
    },
    [copyStdout, stdout, host, snapshot?.root, notify, lang],
  );

  const handleCopyCurrent = useCallback(() => {
    const target = turns[selectedTurnIdx] ?? turns[turns.length - 1];
    if (!target) {
      notify(t(lang, '暂无可复制条目', 'Nothing to copy yet'), 'info');
      return;
    }
    void doCopy(target.text, '当前条目', 'current entry');
  }, [turns, selectedTurnIdx, doCopy, notify, lang]);

  const handleCopyLastReply = useCallback(() => {
    const lastAi = [...turns].reverse().find((x) => x.role === 'assistant');
    if (!lastAi) {
      notify(t(lang, '暂无回答可复制', 'No AI reply yet'), 'info');
      return;
    }
    void doCopy(lastAi.text, '最后回答', 'last reply');
  }, [turns, doCopy, notify, lang]);

  const handleCopyFullSession = useCallback(() => {
    if (turns.length === 0 && !cardCtx?.prompt) {
      notify(t(lang, '当前会话为空', 'Session is empty'), 'info');
      return;
    }
    const md = formatSessionTranscript({
      title: tab === 'guided' ? t(lang, 'StudyHub 带学会话', 'StudyHub Guided Study Session') : undefined,
      prompt: cardCtx?.prompt,
      userAnswer: cardCtx?.userAnswer,
      currentStage: stage,
      turns: allTurns,
      lang,
    });
    void doCopy(md, '完整会话', 'full session');
  }, [turns, allTurns, cardCtx, tab, stage, lang, doCopy, notify]);

  const handleCopyFallbackPrompt = useCallback(() => {
    const promptText = buildFallbackPrompt({
      instruction: lastFallback?.instruction,
      card: cardCtx,
      page,
      course: courseName,
      lang,
    });
    void doCopy(promptText, '提示词', 'fallback prompt');
  }, [lastFallback, cardCtx, page, courseName, lang, doCopy]);

  const handleUndo = useCallback(async () => {
    if (!lastUndo || busy) {
      notify(t(lang, '当前没有可撤销的操作', 'Nothing to undo'), 'info');
      return;
    }
    const target = lastUndo;
    beginExecution(t(lang, '撤销上一步', 'Undo last action'));
    try {
      const msg = await target.run();
      if (!mountedRef.current) return;
      registerUndo(null);
      appendTurn({
        role: 'system',
        stage: tab === 'guided' ? stage : undefined,
        actionSummary: t(lang, `已撤销：${target.label}`, `Undone: ${target.label}`),
        text: msg,
      });
      notify(msg, 'success');
    } catch (err) {
      if (!mountedRef.current) return;
      appendTurn({
        role: 'system',
        text: t(lang, `撤销失败：${err instanceof Error ? err.message : String(err)}`, `Undo failed: ${String(err)}`),
      });
    } finally {
      endExecution();
    }
  }, [lastUndo, busy, beginExecution, endExecution, registerUndo, appendTurn, tab, stage, notify, lang]);

  const runWorkflowSteps = useCallback(
    (startPlan: AssistantWorkflowPlan) => {
      let plan: AssistantWorkflowPlan = startPlan;
      for (let i = plan.activeIndex; i < plan.steps.length; i += 1) {
        const step = plan.steps[i];
        if (!step) break;
        if (step.intent.kind === 'write_confirm') {
          pendingWorkflowRef.current = plan;
          setPendingConfirm(step.intent);
          appendTurn({
            role: 'system',
            stage: tab === 'guided' ? stage : undefined,
            actionSummary: t(
              lang,
              `多步任务暂停于第 ${step.index + 1}/${plan.steps.length} 步（需确认）`,
              `Paused at step ${step.index + 1}/${plan.steps.length} (confirmation required)`,
            ),
            text: `${formatWorkflowChecklist(plan, lang, asciiMode)}\n${step.intent.previewTitle}：${step.intent.previewMessage}`,
          });
          return;
        }
        if (step.intent.kind === 'navigate') {
          navigate(step.intent.page, {
            ...(step.intent.sourceId ? { sourceId: step.intent.sourceId } : {}),
            ...(step.intent.pageNumber ? { pageNumber: step.intent.pageNumber } : {}),
          });
          plan = markWorkflowStepResult(plan, 'done', t(lang, '已跳转', 'Navigated'));
        } else if (step.intent.kind === 'enter_guided') {
          setTab('guided');
          if (step.intent.stage) setStage(step.intent.stage);
          plan = markWorkflowStepResult(plan, 'done', t(lang, '已进入带学', 'Guided ready'));
        } else if (step.intent.kind === 'readonly_stats') {
          plan = markWorkflowStepResult(
            plan,
            'done',
            t(lang, `到期 ${dueToday(snapshot)} / 错题 ${wrongCount(snapshot)}`, `Due ${dueToday(snapshot)} / Wrong ${wrongCount(snapshot)}`),
          );
        } else {
          plan = markWorkflowStepResult(plan, 'skipped', t(lang, '请单步继续', 'Continue individually'));
        }
      }
      pendingWorkflowRef.current = null;
      appendTurn({
        role: 'assistant',
        stage: tab === 'guided' ? stage : undefined,
        actionSummary: t(lang, `多步任务已完成（${plan.steps.length} 步）`, `Completed ${plan.steps.length}-step plan`),
        text: formatWorkflowChecklist(plan, lang, asciiMode),
      });
    },
    [tab, stage, lang, asciiMode, snapshot, navigate, setTab, setStage, appendTurn],
  );

  const executeConfirmedWrite = useCallback(
    async (intent: Extract<AssistantIntent, { kind: 'write_confirm' }>) => {
      setPendingConfirm(null);
      beginExecution(
        intent.actionName === 'export.wrongbook'
          ? t(lang, '导出错题本', 'Exporting wrong-book')
          : intent.actionName === 'card.followup.add'
            ? t(lang, '保存通俗讲解', 'Saving plain explanation')
            : t(lang, '标记错题原因', 'Marking wrong reason'),
      );
      let succeeded = false;
      try {
        if (intent.actionName === 'card.followup.add') {
          const saved = await tryAction(host, 'card.followup.add', intent.params);
          if (!mountedRef.current) return;
          if (saved.ok) {
            succeeded = true;
            appendTurn({
              role: 'system',
              stage: tab === 'guided' ? stage : undefined,
              actionSummary: t(lang, '已保存到本题讲解', 'Saved to question'),
              text: t(
                lang,
                '已将通俗讲解保存到当前题目，下次打开可直接复用。',
                'Saved plain explanation to this question for reuse next time.',
              ),
            });
            notify(t(lang, '通俗讲解已保存到本题', 'Plain explanation saved'), 'success');
          } else {
            appendTurn({
              role: 'system',
              stage: tab === 'guided' ? stage : undefined,
              actionSummary: t(lang, '保存失败', 'Save failed'),
              text: saved.error?.message || t(lang, '保存通俗讲解失败，请重试。', 'Failed to save plain explanation.'),
            });
          }
        } else if (intent.actionName === SET_ERROR_REASON_ACTION) {
          const cardId = typeof intent.params.cardId === 'string' ? intent.params.cardId : '';
          const deckId =
            (typeof intent.params.deckId === 'string' && intent.params.deckId) ||
            snapshot?.decks?.find((d) => Array.isArray(d.cards) && d.cards.some((c) => c.id === cardId))?.id ||
            '';
          if (!cardId || !deckId) {
            appendTurn({
              role: 'system',
              stage,
              actionSummary: '未定位题目',
              text: t(lang, '请先在刷题页打开一道题再标记错因。', 'Open a question in Review first.'),
            });
          } else {
            const target: ErrorReasonTarget = { deckId, cardId };
            const reasonId = intent.params.errorReason as ErrorReasonId;
            const res = await tryAction<{ updated?: boolean }>(host, SET_ERROR_REASON_ACTION, errorReasonArgs(target, reasonId));
            if (!mountedRef.current) return;
            if (res.ok && res.value?.updated === false) {
              appendTurn({
                role: 'system',
                stage,
                actionSummary: t(lang, '没有作答记录', 'No answer on record'),
                text: t(
                  lang,
                  '这道题还没有作答记录，标不了错因。答错的题会自动进入错题本。',
                  'This question has no answer on record yet, so there is nothing to mark. Wrong answers enter the wrong-book on their own.',
                ),
              });
            } else if (res.ok) {
              succeeded = true;
              const appliedReason = errorReasonName(reasonId, lang);
              registerUndo({
                label: t(lang, `清除错因「${appliedReason}」`, `Clear reason "${appliedReason}"`),
                run: async () => {
                  await tryAction(host, SET_ERROR_REASON_ACTION, errorReasonArgs(target, null));
                  return t(lang, '已撤销：错题原因已清空。', 'Undone: wrong reason cleared.');
                },
              });
              appendTurn({
                role: 'system',
                stage,
                actionSummary: t(lang, `已标记错因「${appliedReason}」`, `Marked reason: ${appliedReason}`),
                text: t(lang, `已完成：错因已标为「${appliedReason}」。按 [z] 可撤销。`, `Done: marked "${appliedReason}". Press [z] to undo.`),
              });
              notify(t(lang, `错因已标为「${appliedReason}」`, `Marked "${appliedReason}"`), 'success');
            } else {
              appendTurn({
                role: 'system',
                stage,
                actionSummary: '执行失败',
                text: res.error?.message || t(lang, '写入错题原因失败，请重试。', 'Failed to mark wrong reason.'),
              });
            }
          }
        } else if (intent.actionName === 'export.wrongbook') {
          const root = host.getLibraryRoot?.() || snapshot?.root || '';
          const wb = await tryAction<{ items?: Array<{ prompt?: string; errorReason?: string }> }>(
            host,
            'wrongbook',
            { course: intent.params.course ?? '*', view: 'weak', offset: 0, limit: 100 },
          );
          if (!mountedRef.current) return;
          const items = Array.isArray(wb.value?.items) ? wb.value.items : [];
          if (!root) {
            appendTurn({
              role: 'system',
              stage,
              actionSummary: '未绑定学习库',
              text: t(lang, '未绑定学习库目录，无法导出。', 'No library root bound.'),
            });
          } else {
            const md = [
              `# ${t(lang, '错题本导出', 'Wrong-Book Export')}`,
              '',
              ...(items.length > 0
                ? items.map((it, idx) => `${idx + 1}. ${String(it.prompt || '').trim()}${it.errorReason ? t(lang, `（错因：${reasonLabel(it.errorReason, lang)}）`, ` (reason: ${reasonLabel(it.errorReason, lang)})`) : ''}`)
                : [t(lang, '当前暂无错题记录。', 'No wrong cards found.')]),
              '',
            ].join('\n');
            const outPath = defaultBackupFilePath(root, 'studyhub-wrongbook', 'md');
            const saved = await atomicWriteExportText(outPath, md);
            succeeded = true;
            appendTurn({
              role: 'system',
              stage,
              actionSummary: `已完成：导出 ${items.length} 道错题`,
              text: t(lang, `已导出 ${items.length} 道错题至 ${saved.path}`, `Exported ${items.length} cards to ${saved.path}`),
            });
            notify(t(lang, `已导出至 ${saved.path}`, `Exported to ${saved.path}`), 'success');
          }
        }
        // Resume remaining steps in a multi-step workflow after confirmation (#1339)
        const wf = pendingWorkflowRef.current;
        if (wf && mountedRef.current) {
          pendingWorkflowRef.current = null;
          const nextPlan = markWorkflowStepResult(
            wf,
            succeeded ? 'done' : 'failed',
            succeeded ? t(lang, '已完成', 'Done') : t(lang, '执行失败', 'Failed'),
          );
          if (succeeded && !isWorkflowComplete(nextPlan)) {
            runWorkflowSteps(nextPlan);
          } else {
            appendTurn({
              role: 'assistant',
              stage: tab === 'guided' ? stage : undefined,
              actionSummary: succeeded
                ? t(lang, `多步任务已完成（${nextPlan.steps.length} 步）`, `Completed ${nextPlan.steps.length}-step plan`)
                : t(lang, '多步任务已中止', 'Multi-step plan stopped'),
              text: formatWorkflowChecklist(nextPlan, lang, asciiMode),
            });
          }
        }
      } finally {
        endExecution();
      }
    },
    [host, snapshot?.root, tab, stage, lang, asciiMode, beginExecution, endExecution, appendTurn, registerUndo, notify, runWorkflowSteps],
  );

  const handleSkipRetell = useCallback(() => {
    sessionMemory.retellRecords.push({
      cardId: cardCtx?.cardId,
      stage: 'retell',
      skipped: true,
      at: Date.now(),
    });
    appendTurn({
      role: 'system',
      stage: 'retell',
      skipped: true,
      actionSummary: 'stage=retell (skipped=true)',
      text: t(
        lang,
        '已跳过本轮复述（已记录 skipped=true，便于统计复述通过率），进入「小结」阶段。',
        'Skipped retell (recorded skipped=true); entering Summary.',
      ),
    });
    setStage('summary');
    notify(t(lang, '已跳过复述并记录', 'Retell skipped'), 'info');
  }, [cardCtx?.cardId, appendTurn, setStage, notify, lang]);

  const handleSubmitInput = useCallback(
    async (raw: string, opts?: { viaCommand?: boolean }) => {
      const text = raw.trim();
      if (!text || busy) return;
      setInputValue('');
      setInputFocused(false);
      setLastFallback(null);
      sessionMemory.lastFallback = null;
      recordUsage(text);
      // Always show what was asked, so every answer below has its question above it (#1410).
      const userTurn = appendTurn({ role: 'user', stage: tab === 'guided' ? stage : undefined, text });

      // Guided Study Retell stage submits to backend `teach.retell` (#1348). Only text the learner
      // typed counts as a retell: chips and the [A] alternative are commands, not answers (#1406).
      if (tab === 'guided' && stage === 'retell' && !opts?.viaCommand) {
        if (!cardCtx?.cardId) {
          appendTurn({
            role: 'system',
            stage: 'retell',
            text: t(lang, '请先在刷题页打开一道题再复述。', 'Open a card in Review first.'),
          });
          return;
        }
        const resolvedDeckId =
          cardCtx.deckId ||
          snapshot?.decks?.find((d) => Array.isArray(d.cards) && d.cards.some((c) => c.id === cardCtx.cardId))?.id ||
          '';
        if (!resolvedDeckId) {
          appendTurn({
            role: 'system',
            stage: 'retell',
            actionSummary: t(lang, '复述评估失败', 'Retell evaluation failed'),
            text: t(lang, '缺少题组信息，请返回刷题页重新打开本题后再复述。', 'Missing deck context; reopen this card in Review and try again.'),
          });
          return;
        }
        beginExecution(t(lang, '评估费曼复述', 'Evaluating retell'));
        try {
          const res = await submitRetellEvaluation(host, {
            deckId: resolvedDeckId,
            cardId: cardCtx.cardId,
            text,
            language: lang,
          });
          if (!mountedRef.current) return;
          if (!res.ok) {
            const fb = {
              reason: res.error || t(lang, '模型暂不可用，无法在线评估复述。', 'Model unavailable for retell.'),
              altLabel: res.isModelError
                ? t(lang, '改为：按 [S] 跳过复述，或按 [P] 复制提示词到外部模型', 'Alternative: [S] skip or [P] copy prompt')
                : t(lang, '可按 [S] 跳过复述，或重试提交', 'Press [S] to skip retell or try again'),
              altCommand: '查看统计',
              instruction: text,
            };
            sessionMemory.lastFallback = fb;
            setLastFallback(fb);
            appendTurn({
              role: 'system',
              stage: 'retell',
              actionSummary: res.isModelError ? t(lang, '模型暂不可用', 'Model unavailable') : t(lang, '复述评估失败', 'Retell failed'),
              text: `${fb.reason} ${fb.altLabel}`,
            });
            return;
          }
          const v = res.verdict;
          sessionMemory.retellRecords.push({
            cardId: cardCtx.cardId,
            stage: 'retell',
            passed: v.passed,
            skipped: false,
            gap: v.gap,
            at: Date.now(),
          });
          const lines = formatRetellVerdictLines(v, lang);
          appendTurn({
            role: 'assistant',
            stage: 'retell',
            actionSummary: v.passed ? t(lang, '复述评估：通过', 'Retell check: passed') : t(lang, '复述评估：待补强', 'Retell check: needs review'),
            text: lines.join('\n'),
            verdict: { passed: v.passed, right: v.right, missed: v.missed, wrong: v.wrong, gap: v.gap },
          });
          setStage('summary');
        } finally {
          endExecution();
        }
        return;
      }

      // Round 88 Track D4 (#1315 Phase 3): Multi-step workflow skeleton ("先 X 再 Y", step-by-step confirmation)
      const workflowPlan = planAssistantWorkflow(text, {
        snapshot,
        currentCardId: cardCtx?.cardId,
        currentDeckId: cardCtx?.deckId,
        lang,
      });
      if (workflowPlan) {
        runWorkflowSteps(workflowPlan);
        return;
      }

      const intent = parseAssistantIntent(text, {
        snapshot,
        currentCardId: cardCtx?.cardId,
        currentDeckId: cardCtx?.deckId,
        lang,
      });

      // 0) Unsupported -> nearest alternative + [P] Copy prompt fallback (never parroting raw input!)
      if (intent.kind === 'unsupported') {
        const fb = {
          reason: intent.reason,
          altLabel: intent.alternativeLabel,
          altCommand: intent.alternativeCommand,
          instruction: text,
        };
        sessionMemory.lastFallback = fb;
        setLastFallback(fb);
        appendTurn({
          role: 'system',
          actionSummary: '能力边界兜底',
          text: `${intent.reason}\n${intent.alternativeLabel}\n也可按 [P] 复制带上下文的提示词。`,
        });
        return;
      }

      // 1) Switch to Guided Study tab
      if (intent.kind === 'enter_guided') {
        setTab('guided');
        if (intent.stage) setStage(intent.stage);
        appendTurn({
          role: 'system',
          stage: intent.stage ?? stage,
          actionSummary: '已切换：带学模式',
          text: t(lang, '已进入带学工作台，可按 [i] 回答或 [n]/[p] 切换阶段。', 'Switched to Guided Study.'),
        });
        return;
      }

      // 2) Write/export action -> P2 ConfirmDialog preview
      if (intent.kind === 'write_confirm') {
        appendTurn({
          role: 'system',
          stage: tab === 'guided' ? stage : undefined,
          actionSummary: `将执行：${intent.actionName}（${intent.paramsSummary}）`,
          text: intent.previewMessage,
        });
        setPendingConfirm(intent);
        return;
      }

      // 2b) Mark a mistake reason without naming one -> list the reasons (#1439)
      if (intent.kind === 'pick_error_reason') {
        if (!intent.target.cardId) {
          appendTurn({
            role: 'system',
            stage: tab === 'guided' ? stage : undefined,
            actionSummary: '未定位题目',
            text: t(lang, '请先在刷题页打开一道题再标记错因。', 'Open a question in Review first.'),
          });
          return;
        }
        setReasonPickFor(intent.target);
        return;
      }

      // 3) Navigation (0 model calls + real [z] undo!)
      if (intent.kind === 'navigate') {
        const prevPage = useTuiStore.getState().page;
        const prevCtx = { ...useTuiStore.getState().navContext };
        const navCtx: { sourceId?: string; pageNumber?: number } = {};
        if (intent.sourceId) navCtx.sourceId = intent.sourceId;
        if (intent.pageNumber) navCtx.pageNumber = intent.pageNumber;
        navigate(intent.page as PageId, navCtx);
        registerUndo({
          label: t(lang, `返回 ${prevPage}`, `Back to ${prevPage}`),
          run: async () => {
            useTuiStore.getState().navigate(prevPage, prevCtx);
            return t(lang, `已撤销：返回 ${prevPage}。`, `Undone: returned to ${prevPage}.`);
          },
        });
        appendTurn({
          role: 'system',
          stage: tab === 'guided' ? stage : undefined,
          actionSummary: `已完成：${intent.actionName}（${intent.paramsSummary}）`,
          text: t(
            lang,
            `已定位至 ${intent.page}${intent.pageNumber ? ` 第 ${intent.pageNumber} 页` : ''}。按 [z] 可撤销。`,
            `Navigated to ${intent.page}${intent.pageNumber ? ` p.${intent.pageNumber}` : ''}. [z] undo.`,
          ),
        });
        notify(t(lang, `已定位：${intent.paramsSummary}`, `Navigated: ${intent.paramsSummary}`), 'success');
        return;
      }

      // 3b) Preference update (theme / density — 0 model calls + persisted + [z] undo)
      if (intent.kind === 'set_preference') {
        const curPrefs = useTuiStore.getState().preferences;
        const prevPatch: Partial<typeof curPrefs> = {};
        if (intent.patch.theme !== undefined) prevPatch.theme = curPrefs.theme;
        if (intent.patch.compactMode !== undefined) prevPatch.compactMode = curPrefs.compactMode;
        if (intent.patch.proactiveHints !== undefined) prevPatch.proactiveHints = curPrefs.proactiveHints;
        const dshHome = (host as { dshHome?: string } | undefined)?.dshHome;
        const persist = (patch: Partial<typeof curPrefs>) => {
          useTuiStore.getState().setPreferences(patch);
          void saveTuiPreferences(patch, dshHome ? { env: { DSH_HOME: dshHome } } : undefined).catch(() => {});
        };
        persist(intent.patch);
        registerUndo({
          label: t(lang, '恢复原偏好', 'Restore previous preference'),
          run: async () => {
            persist(prevPatch);
            return t(lang, '已撤销：偏好设置已恢复。', 'Undone: preferences restored.');
          },
        });
        appendTurn({
          role: 'system',
          stage: tab === 'guided' ? stage : undefined,
          actionSummary: `已完成：${intent.actionName}（${intent.paramsSummary}）`,
          text: t(
            lang,
            `已应用偏好（${intent.paramsSummary}）并持久化。按 [z] 可撤销。`,
            `Applied (${intent.paramsSummary}) and saved. [z] undo.`,
          ),
        });
        notify(t(lang, `已切换：${intent.paramsSummary}`, `Updated: ${intent.paramsSummary}`), 'success');
        return;
      }

      // 4) Read-only stats summary
      if (intent.kind === 'readonly_stats') {
        const due = dueToday(snapshot);
        const wrong = wrongCount(snapshot);
        const decks = Array.isArray(snapshot?.decks) ? snapshot.decks.filter((d) => !d.archived).length : 0;
        const sources = Array.isArray(snapshot?.sources) ? snapshot.sources.length : 0;
        appendTurn({
          role: 'assistant',
          stage: tab === 'guided' ? stage : undefined,
          actionSummary: '已完成：只读统计（0 模型调用）',
          text: t(
            lang,
            `活跃题组 ${decks} 个 · 资料 ${sources} 份 · 今日到期 ${due} 题 · 待巩固错题 ${wrong} 题。`,
            `${decks} active decks · ${sources} sources · ${due} due · ${wrong} weak.`,
          ),
        });
        return;
      }

      // 5) Streaming AI generation (offline fallback with [P] Copy Prompt if model unavailable)
      if (!host.streamComplete || !modelReady) {
        const fb = {
          reason: t(lang, '当前未配置可用模型。', 'No AI model configured.'),
          altLabel: t(lang, '改为：按 , → 1 配模型，或按 [P] 复制提示词', 'Alternative: Settings (, -> 1) or [P] copy prompt'),
          altCommand: '跳到设置',
          instruction: text,
        };
        sessionMemory.lastFallback = fb;
        setLastFallback(fb);
        appendTurn({
          role: 'system',
          stage: tab === 'guided' ? stage : undefined,
          actionSummary: '模型暂不可用',
          text: `${fb.reason}${fb.altLabel}`,
        });
        return;
      }

      const isPlainExplain = intent.kind === 'generate_plain_explain';
      beginExecution(isPlainExplain ? '生成通俗讲解' : '生成回答');
      stream.reset();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const recentContext = turnsInScope(sessionMemory.turns, turnScopeRef.current).current
        .filter((x) => x.id !== userTurn.id)
        .slice(-6)
        .map((x) => `${x.role}: ${x.text.slice(0, 200)}`)
        .join('\n');

      try {
        const system = buildUnifiedAiSystemPrompt(
          isPlainExplain ? 'plain_explain' : tab === 'guided' ? 'guided' : 'assistant',
          lang,
          { stageLabel: stageLabel(stage, lang) },
        );
        const promptParts = [
          cardCtx?.prompt ? `当前题目：${cardCtx.prompt}` : '',
          cardCtx?.userAnswer ? `我的作答：${cardCtx.userAnswer}` : '',
          recentContext ? `近期上下文：\n${recentContext}` : '',
          `指令：${text}`,
        ].filter(Boolean);

        const reply = await host.streamComplete({
          system,
          prompt: promptParts.join('\n\n'),
          signal: ctrl.signal,
          onChunk: (delta) => stream.push(delta),
        });
        stream.finish();
        if (!mountedRef.current) return;
        const cleanReply = (reply || stream.text).trim();

        const actionSummary = isPlainExplain
          ? t(lang, '已完成：通俗讲解已生成', 'Done: plain explanation ready')
          : t(lang, '已完成：回答已生成', 'Done: reply ready');

        appendTurn({
          role: 'assistant',
          stage: tab === 'guided' ? stage : undefined,
          actionSummary,
          text: cleanReply || t(lang, '未收到有效回复。', 'Empty reply.'),
        });
        if (isPlainExplain && cardCtx?.cardId && cleanReply) {
          setPendingConfirm({
            kind: 'write_confirm',
            actionName: 'card.followup.add',
            params: {
              ...(cardCtx.deckId ? { deckId: cardCtx.deckId } : {}),
              cardId: cardCtx.cardId,
              question: text,
              answer: cleanReply,
              source: 'assistant',
              silent: true,
              replace: true,
            },
            previewTitle: t(lang, '保存通俗讲解到本题', 'Save Plain Explanation'),
            previewMessage: t(
              lang,
              '将执行：将这条通俗讲解保存到当前题目，方便下次直接查看（取消则仅保留在本次对话）。',
              'Will save this plain explanation to the current question for reuse next time (cancel to keep in chat only).',
            ),
            paramsSummary: t(lang, '保存到当前题目', 'save to current question'),
            requiresConfirm: true,
          });
        }
        if (tab === 'guided') {
          if (stage === 'question') setStage('answer');
          else if (stage === 'answer') setStage('judge');
          else if (stage === 'judge') setStage('retell');
        }
      } catch (err) {
        if (!mountedRef.current || ctrl.signal.aborted) return;
        appendTurn({
          role: 'system',
          stage: tab === 'guided' ? stage : undefined,
          actionSummary: '执行失败',
          text: `${err instanceof Error ? err.message : String(err)}（按 [P] 可复制提示词兜底）`,
        });
      } finally {
        stream.reset();
        endExecution();
      }
    },
    [
      busy,
      tab,
      stage,
      cardCtx,
      host,
      snapshot,
      lang,
      modelReady,
      stream,
      recordUsage,
      beginExecution,
      endExecution,
      navigate,
      appendTurn,
      registerUndo,
      setTab,
      setStage,
      notify,
      runWorkflowSteps,
    ],
  );

  const runChip = useCallback(
    (chip: AssistantChip) => {
      if (chip.kind === 'return_practice') {
        useTuiStore.getState().returnViaPracticeStack();
        return;
      }
      if (chip.kind === 'guided') {
        setTab('guided');
        return;
      }
      void handleSubmitInput(chip.command, { viaCommand: true });
    },
    [setTab, handleSubmitInput],
  );

  // #1439: the six reasons the wrong-book uses, for the learner to pick from.
  const reasonOptions = useMemo<Array<SelectOption<ErrorReasonId>>>(
    () =>
      ERROR_REASONS.map((reason) => ({
        value: reason.id,
        label: t(lang, reason.zh, reason.en),
        badge: reasonShort(reason.id, lang),
        badgeTone: reason.tone,
      })),
    [lang],
  );
  const pickReason = useCallback(
    (reason: ErrorReasonId) => {
      if (!reasonPickFor) return;
      setReasonPickFor(null);
      // Picking is the decision, so it is written at once; [z] takes it back.
      void executeConfirmedWrite(errorReasonWriteIntent(reasonPickFor, reason, lang));
    },
    [reasonPickFor, executeConfirmedWrite, lang],
  );
  const cancelReasonPick = useCallback(() => {
    setReasonPickFor(null);
    appendTurn({
      role: 'system',
      stage: tab === 'guided' ? stage : undefined,
      actionSummary: '已取消',
      text: t(lang, '已取消，数据未改动。', 'Cancelled; unchanged.'),
    });
  }, [appendTurn, tab, stage, lang]);

  // #1412: on the practice page Esc hands the keyboard back and the dock stays; the page's own Esc
  // ("back") folds it afterwards. Other pages have no such second step, so there Esc folds the dock.
  // #1412 / #1428: unified 2-step Esc on every docked page — 1st Esc hands the keyboard back
  // while keeping the dock visible; 2nd Esc (when no page modal/filter claims it) folds the dock.
  const escKeepsDock = Boolean(docked);
  const handleEscape = useCallback(() => {
    if (busy) {
      abortRef.current?.abort();
      endExecution();
      notify(t(lang, '已中止当前操作', 'Cancelled'), 'info');
      return;
    }
    if (inputFocused) {
      setInputFocused(false);
      return;
    }
    if (fullscreen) {
      setFullscreen(false);
      return;
    }
    if (escKeepsDock) {
      // Hand the keyboard back to the page and stay visible, so the page's own shortcuts work while
      // the conversation is still readable (#1412 / #1428). A second Esc folds the passive dock.
      setFocused(false);
      return;
    }
    onClose();
  }, [busy, endExecution, notify, lang, inputFocused, fullscreen, setFullscreen, escKeepsDock, setFocused, onClose]);

  useInput(
    (input, key) => {
      if (pendingConfirm) return false;
      if (key.escape) {
        handleEscape();
        return true;
      }
      if (inputFocused) return false;

      if (key.tab) {
        const next: AssistantTabId = tab === 'assistant' ? 'guided' : 'assistant';
        setTab(next);
        return true;
      }
      // Number keys 1-4 trigger the top context chips directly!
      if (/^[1-4]$/.test(input)) {
        const idx = Number.parseInt(input, 10) - 1;
        if (chips[idx]) {
          runChip(chips[idx]);
          return true;
        }
      }
      if (input === 'F') {
        setFullscreen(!fullscreen);
        return true;
      }
      if (input === 'o' && earlierTurnCount > 0) {
        setShowEarlier((shown) => !shown);
        return true;
      }
      if (input === 'i' || input === 'a' || key.return) {
        setInputFocused(true);
        return true;
      }
      if (input === 'z') {
        void handleUndo();
        return true;
      }
      if (input === 'P') {
        handleCopyFallbackPrompt();
        return true;
      }
      if (input === 'A' && lastFallback) {
        void handleSubmitInput(lastFallback.altCommand, { viaCommand: true });
        return true;
      }
      if (input === 'c') {
        handleCopyCurrent();
        return true;
      }
      if (input === 'C') {
        handleCopyFullSession();
        return true;
      }
      if (input === 'y') {
        handleCopyLastReply();
        return true;
      }
      if (tab === 'guided') {
        if (input === 'S' && stage === 'retell') {
          handleSkipRetell();
          return true;
        }
        if (input === 'n') {
          const idx = GUIDED_STAGES.indexOf(stage);
          if (idx >= 0 && idx < GUIDED_STAGES.length - 1) setStage(GUIDED_STAGES[idx + 1]);
          return true;
        }
        if (input === 'p') {
          const idx = GUIDED_STAGES.indexOf(stage);
          if (idx > 0) setStage(GUIDED_STAGES[idx - 1]);
          return true;
        }
      }
      return false;
    },
    { isActive: isActive && !pendingConfirm && !reasonPickFor, layer: KEY_LAYER_DRAWER, id: 'AssistantPanel:main' },
  );

  // #1354 D1 / #1428: single-letter catch-all sink below ScrollView (KEY_LAYER_WIDGET) so while the
  // assistant panel holds focus, no unbound single-letter key can ever leak to the left page or shell.
  useInput(
    (input, key) => {
      if (!key.ctrl && !key.meta && input.length === 1) return true;
      return false;
    },
    {
      isActive: isActive && !pendingConfirm && !inputFocused,
      layer: KEY_LAYER_MODAL_FRAME,
      id: 'AssistantPanel:sink',
    },
  );

  const fallbackSize = resolveAssistantPanelSize(columns, rows, fullscreen);
  const frameW = widthProp ?? fallbackSize.width;
  const frameH = heightProp ?? fallbackSize.height;
  const innerW = Math.max(24, frameW - 4);
  const reasonPickW = Math.min(60, innerW);
  const bodyH = Math.max(6, frameH - 2);
  // Pack 2–4 context chips across 1 or 2 clean rows so chip labels are never chopped in half on docked panes
  const chipRows = useMemo(() => {
    const rowsOut: Array<Array<{ chip: AssistantChip; idx: number }>> = [];
    let curRow: Array<{ chip: AssistantChip; idx: number }> = [];
    let curW = 0;
    chips.forEach((chip, idx) => {
      const labelW = displayWidth(`[${idx + 1}]${chip.label}`);
      const gapW = curRow.length > 0 ? 1 : 0;
      if (curRow.length > 0 && curW + gapW + labelW > innerW && rowsOut.length < 1) {
        rowsOut.push(curRow);
        curRow = [{ chip, idx }];
        curW = labelW;
      } else {
        curRow.push({ chip, idx });
        curW += gapW + labelW;
      }
    });
    if (curRow.length > 0) rowsOut.push(curRow);
    return rowsOut;
  }, [chips, innerW]);
  const chromeRows = 4 + chipRows.length + (tab === 'guided' ? 1 : 0) + (lastFallback ? 1 : 0) + (execStatus ? 1 : 0);
  const scrollH = Math.max(3, bodyH - chromeRows);
  const ell = asciiMode ? '...' : '…';

  // Live context awareness summary line (#1315 UX Gate #2)
  const pageMeta = PAGE_REGISTRY.find((p) => p.id === page);
  const pageName = pageMeta ? t(lang, pageMeta.labelZh, pageMeta.labelEn) : page;
  const cardPos =
    page === 'review' && cardCtx
      ? ` · 第 ${(cardCtx.cardIndex ?? 0) + 1}${cardCtx.total ? `/${cardCtx.total}` : ''} 题${cardCtx.isWrong ? '(答错)' : ''}`
      : '';
  const contextLine = `${t(lang, '当前', 'Context')}：${pageName}${cardPos}${courseName ? ` · ${courseName}` : ''}`;

  // #1412: while the dock holds the keyboard the footer shows the dock's own keys, not a generic "Esc close".
  const dockFooterHints = useMemo(
    () => [
      { key: 'Esc', label: fullscreen ? t(lang, '退出全屏', 'Exit full') : escKeepsDock ? t(lang, '回页面', 'Back to page') : t(lang, '收起', 'Hide') },
      { key: 'i', label: t(lang, '输入', 'Type') },
      { key: '1-4', label: t(lang, '推荐动作', 'Quick actions') },
      { key: 'Tab', label: t(lang, '助手/带学', 'Tabs') },
      { key: 'Ctrl+G', label: t(lang, '收起', 'Hide') },
    ],
    [lang, fullscreen, escKeepsDock],
  );
  useModalFooterHints(dockFooterHints, isActive && !inputFocused && !pendingConfirm && !reasonPickFor);

  const colorLevel = getColorLevel();
  const transcriptLines = useMemo(() => {
    const out: string[] = [];
    const wrapW = Math.max(18, innerW - 2);
    const chalk = makeChalk(colorLevel);
    const palette = buildTranscriptPalette(theme, chalk);
    const labels = {
      user: t(lang, '我', 'You'),
      assistant: t(lang, '助手', 'AI'),
      system: t(lang, '状态', 'Status'),
      stage: t(lang, '阶段', 'Stage'),
    };
    if (!modelReady) {
      out.push(
        ...wrapDisplay(
          t(lang, '模型未就绪：本地导航与导出可用，生成类可按 [P] 复制提示词。', 'Model offline: navigation works; press [P] to copy prompt.'),
          wrapW,
        ).map((line) => chalk.hex(theme.warning)(line)),
        '',
      );
    }
    if (earlierTurnCount > 0) {
      const fold = showEarlier
        ? t(lang, `已展开之前的对话 ${earlierTurnCount} 条 · 按 [o] 收起`, `Showing ${earlierTurnCount} earlier turn(s) · [o] to fold`)
        : t(lang, `之前的对话 ${earlierTurnCount} 条已收起 · 按 [o] 展开`, `${earlierTurnCount} earlier turn(s) folded · [o] to show`);
      out.push(...wrapDisplay(fold, wrapW).map((line) => chalk.hex(theme.dim)(line)), '');
    }
    if (turns.length === 0 && !busy) {
      const intro =
        tab === 'guided'
          ? stage === 'retell'
            ? t(lang, '复述阶段：按 [i] 用自己的话复述要点，或按 [S] 跳过并记录。', 'Retell: [i] explain in your own words, or [S] skip.')
            : t(lang, '带学模式：按 [i] 回答或追问，[p/n] 切阶段，Tab 切助手不丢进度。', 'Guided Study: [i] answer, [p/n] stages, Tab switches tab.')
          : t(lang, '按 [1-4] 直达推荐动作，或按 [i] 输入自然语言指令。', 'Press [1-4] for quick actions, or [i] for natural language.');
      out.push(...wrapDisplay(intro, wrapW).map((line) => chalk.hex(theme.muted)(line)));
    }

    for (const entry of turns) {
      out.push(
        ...formatTurnLines(
          {
            role: entry.role,
            text: entry.text,
            actionSummary: entry.actionSummary,
            stageLabel: entry.stage ? stageLabel(entry.stage, lang) : undefined,
          },
          { wrapW, labels, palette },
        ),
      );
    }

    if (busy && busyScope === turnScope) {
      const live = stream.text.trim();
      if (live) {
        for (const para of live.split('\n')) {
          out.push(...wrapDisplay(`  ${para}`, wrapW).map((line) => palette.body.assistant(line)));
        }
      }
    }
    return out;
  }, [innerW, modelReady, lang, turns, earlierTurnCount, showEarlier, busy, busyScope, turnScope, tab, stage, stream.text, theme, colorLevel]);

  return (
    <Box flexDirection="column" width={frameW} height={frameH}>
      <Panel
        title={t(lang, 'AI 助手 · 带学', 'AI Assistant')}
        icon={asciiMode ? '*' : '✦'}
        subtitle={
          fullscreen
            ? t(lang, '全屏 (Esc分栏)', 'Full (Esc split)')
            : isActive
              ? escKeepsDock
                ? t(lang, '已聚焦 (Esc回页面)', 'Focused (Esc to page)')
                : t(lang, '已聚焦 (Esc收起)', 'Focused (Esc hide)')
              : escKeepsDock
                ? t(lang, '停靠不抢焦点 (Ctrl+G聚焦 · Esc收起)', 'Docked (Ctrl+G focus · Esc hide)')
                : t(lang, '停靠不抢焦点 (Ctrl+G聚焦)', 'Docked (Ctrl+G focus)')
        }
        focused={isActive}
        width={frameW}
        height={frameH}
        ascii={asciiMode}
      >
        {/* 1) Tabs + Live Context Ribbon */}
        <Box height={1} width={innerW} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <ClickableBox
              clickActive
              onClick={() => {
                setFocused(true);
                setTab('assistant');
              }}
            >
              <Text
                backgroundColor={tab === 'assistant' ? theme.primary : theme.surface}
                color={tab === 'assistant' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                bold={tab === 'assistant'}
              >
                {` ${t(lang, '助手', 'Assistant')} `}
              </Text>
            </ClickableBox>
            <ClickableBox
              clickActive
              onClick={() => {
                setFocused(true);
                setTab('guided');
              }}
            >
              <Text
                backgroundColor={tab === 'guided' ? theme.primary : theme.surface}
                color={tab === 'guided' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                bold={tab === 'guided'}
              >
                {` ${t(lang, '带学', 'Guided')} `}
              </Text>
            </ClickableBox>
          </Box>
          <Text color={theme.muted} wrap="truncate">
            {truncateDisplay(contextLine, Math.max(10, innerW - 18), ell)}
          </Text>
        </Box>

        {/* 2) Context-Aware Chips FIRST (1–2 tidy rows, never mid-word truncated) */}
        {chipRows.map((rowItems, rIdx) => (
          <Box key={`chip-row-${rIdx}`} height={1} width={innerW} flexDirection="row" gap={1} overflow="hidden" flexShrink={0}>
            {rowItems.map(({ chip, idx }) => (
              <ClickableBox
                key={chip.id}
                clickActive
                flexShrink={0}
                onClick={() => {
                  setFocused(true);
                  runChip(chip);
                }}
              >
                <Text
                  backgroundColor={theme.surface}
                  color={chip.promoted ? theme.warning : theme.accent}
                  bold={chip.promoted}
                >
                  {`[${idx + 1}]${chip.label}`}
                </Text>
              </ClickableBox>
            ))}
          </Box>
        ))}

        {/* Guided Study 5-stage progress strip */}
        {tab === 'guided' ? (
          <SectionHeader
            title={formatStageStrip(stage, lang, asciiMode)}
            meta={stage === 'retell' ? t(lang, '[S]跳过', '[S]Skip') : t(lang, '[p/n]阶段', '[p/n]Stage')}
            width={innerW}
            ascii={asciiMode}
            focused={isActive}
          />
        ) : null}

        {/* Latency & Progress Line (>2s notice) */}
        {execStatus ? (
          <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
            <Text color={slowNotice ? theme.warning : theme.ai} bold wrap="truncate">
              {slowNotice
                ? t(lang, `${execStatus}（耗时较长，请稍候，Esc 可中止）`, `${execStatus} (taking >2s, Esc to abort)`)
                : execStatus}
            </Text>
          </Box>
        ) : null}

        {/* Never-dead-end fallback action bar */}
        {lastFallback ? (
          <Box height={1} width={innerW} flexDirection="row" gap={1} overflow="hidden" flexShrink={0}>
            <ClickableBox
              clickActive
              onClick={() => {
                setFocused(true);
                void handleSubmitInput(lastFallback.altCommand, { viaCommand: true });
              }}
            >
              <Text color={theme.accent} bold>
                {`[A] ${truncateDisplay(lastFallback.altLabel, Math.max(10, innerW - 16), ell)}`}
              </Text>
            </ClickableBox>
            <ClickableBox
              clickActive
              onClick={() => {
                setFocused(true);
                handleCopyFallbackPrompt();
              }}
            >
              <Text backgroundColor={theme.surface} color={theme.primary} bold>
                {` [P] ${t(lang, '复制提示词', 'Copy Prompt')} `}
              </Text>
            </ClickableBox>
          </Box>
        ) : null}

        {/* Scrollable Wrapped Body (auto-follows newest replies/status) */}
        <ScrollView
          lines={transcriptLines}
          height={scrollH}
          width={innerW}
          isActive={isActive && !inputFocused && !pendingConfirm && !reasonPickFor}
          follow
        />

        {/* Shared Input Box BELOW Chips */}
        <SectionHeader
          title={
            tab === 'guided' && stage === 'retell'
              ? t(lang, '复述作答', 'Retell')
              : t(lang, '指令输入', 'Ask / Command')
          }
          meta={
            inputFocused
              ? t(lang, 'Enter发送 · Esc退', 'Enter/Esc')
              : lastUndo
                ? t(lang, '[i]输入 [z]撤销 [c/C/y]复制 [F]全屏', '[i]Type [z]Undo [F]Full')
                : t(lang, '[i]输入 [Tab]切页 [c/C/y]复制 [F]全屏', '[i]Type [Tab]Tab [F]Full')
          }
          width={innerW}
          ascii={asciiMode}
          focused={inputFocused}
        />
        <ClickableBox
          clickActive
          onClick={() => {
            setFocused(true);
            setInputFocused(true);
          }}
          width={innerW}
          height={1}
        >
          <TextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={(val) => void handleSubmitInput(val)}
            onCancel={() => setInputFocused(false)}
            isActive={isActive && inputFocused && !pendingConfirm && !reasonPickFor}
            width={innerW}
            placeholder={
              tab === 'guided' && stage === 'retell'
                ? t(lang, '用自己的话复述要点…', 'Explain in your own words...')
                : t(lang, '如：通俗讲解 / 跳到资料第12页 / 导出错题…', 'e.g. plain explain / open source p.12...')
            }
          />
        </ClickableBox>
      </Panel>

      {reasonPickFor ? (
        <Modal
          title={t(lang, '选择错因', 'Pick a reason')}
          icon={asciiMode ? '#' : '✎'}
          tone="accent"
          width={reasonPickW}
          onClose={cancelReasonPick}
          isActive={isActive}
          hints={[
            { key: '1-6', label: t(lang, '选择', 'Pick') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Box marginY={1} flexDirection="column">
            <SelectList
              options={reasonOptions}
              isActive={isActive}
              width={modalContentWidth(reasonPickW)}
              onSelect={(opt) => pickReason(opt.value)}
            />
          </Box>
        </Modal>
      ) : null}

      {pendingConfirm ? (
        <ConfirmDialog
          title={pendingConfirm.previewTitle}
          message={pendingConfirm.previewMessage}
          confirmLabel={t(lang, '确认执行', 'Confirm')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onConfirm={() => void executeConfirmedWrite(pendingConfirm)}
          onCancel={() => {
            pendingWorkflowRef.current = null;
            appendTurn({
              role: 'system',
              stage: tab === 'guided' ? stage : undefined,
              actionSummary: '已取消',
              text: t(lang, '已取消，数据未改动。', 'Cancelled; unchanged.'),
            });
            setPendingConfirm(null);
          }}
        />
      ) : null}
    </Box>
  );
});
