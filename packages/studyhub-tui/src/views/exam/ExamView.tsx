import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { Spinner } from '../../components/Badge.js';
import { useFooterHints } from '../../components/hooks.js';
import { tryAction } from '../../host/index.js';
import { t, useTuiStore } from '../../state/store.js';
import { ExamSetup } from './ExamSetup.js';

const ExamReportView = lazy(() => import('./ExamReportView.js').then((m) => ({ default: m.ExamReportView })));
const ExamRunner = lazy(() => import('./ExamRunner.js').then((m) => ({ default: m.ExamRunner })));
import type {
  CaseHighlight,
  ExamReport,
  ExamSetupValue,
  HistoryItem,
  OralReport,
  OralView,
  ReportState,
  RunView,
  ScopeChoice,
} from './types.js';

type Phase = 'setup' | 'running' | 'report';

export const ExamView: React.FC<ViewProps> = memo(function ExamView({
  host,
  width,
  height,
  isActive,
}) {
  const snapshot = useTuiStore((s) => s.snapshot);
  const lang = useTuiStore((s) => s.preferences.language);
  const navContext = useTuiStore((s) => s.navContext);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const setSnapshot = useTuiStore((s) => s.setSnapshot);

  const [phase, setPhase] = useState<Phase>('setup');
  const [runKind, setRunKind] = useState<'written' | 'case' | 'oral'>('written');
  const [run, setRun] = useState<RunView | null>(null);
  const [oral, setOral] = useState<OralView | null>(null);
  const [reportState, setReportState] = useState<ReportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const startingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const res = await tryAction(host, 'snapshot');
    if (mountedRef.current && res.ok && res.value && typeof res.value === 'object') {
      setSnapshot(res.value as never);
    }
  }, [host, setSnapshot]);

  // Open report if navigated with examId
  useEffect(() => {
    const examId = navContext.examId;
    if (!examId) return;
    const epoch = ++epochRef.current;
    setBusy(true);
    setError(null);
    void (async () => {
      const isOral = (snapshot?.oralExams ?? []).some((x) => String(x.runId) === examId);
      const action = isOral ? 'oral.report' : 'exam.report';
      const res = await tryAction<ExamReport | OralReport>(host, action, { runId: examId });
      if (!mountedRef.current || epochRef.current !== epoch) return;
      setBusy(false);
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '打开考试报告失败', 'Failed to load report'));
        return;
      }
      setReportState(
        isOral
          ? { kind: 'oral', report: res.value as OralReport }
          : { kind: 'written', report: res.value as ExamReport },
      );
      setPhase('report');
    })();
  }, [navContext.examId, host, lang, snapshot?.oralExams]);

  const resumableRun = useMemo(() => {
    const open = (snapshot?.runs ?? []).find(
      (r) => r.mode === 'exam' && r.status !== 'closed' && r.status !== 'completed',
    );
    return open ? { id: open.id, title: open.title, mode: open.mode } : null;
  }, [snapshot?.runs]);

  const handleStart = useCallback(
    async (value: ExamSetupValue, scopeChoice: ScopeChoice) => {
      if (startingRef.current) return;
      startingRef.current = true;
      const epoch = ++epochRef.current;
      setBusy(true);
      setError(null);
      try {
        if (value.mode === 'oral') {
          const res = await tryAction<OralView>(host, 'oral.start', {
            ...scopeChoice.args,
            count: value.count,
          });
          if (!mountedRef.current || epochRef.current !== epoch) return;
          setBusy(false);
          if (!res.ok || !res.value) {
            setError(res.error?.message || t(lang, '启动口试失败', 'Failed to start oral exam'));
            return;
          }
          setRunKind('oral');
          setOral(res.value);
          setRun(null);
          setPhase('running');
          return;
        }

        const payload: Record<string, unknown> =
          value.mode === 'case'
            ? {
                mode: 'exam',
                examKinds: 'case',
                ...scopeChoice.args,
                fresh: true,
              }
            : {
                mode: 'exam',
                examKinds: value.kinds,
                count: value.count,
                limitMinutes: value.minutes,
                ...scopeChoice.args,
                fresh: true,
              };

        const res = await tryAction<RunView>(host, 'review.start', payload);
        if (!mountedRef.current || epochRef.current !== epoch) return;
        setBusy(false);
        if (!res.ok || !res.value) {
          setError(res.error?.message || t(lang, '开始模拟考失败', 'Failed to start exam'));
          return;
        }
        setRunKind(value.mode === 'case' ? 'case' : 'written');
        setRun(res.value);
        setOral(null);
        setPhase('running');
      } finally {
        startingRef.current = false;
      }
    },
    [host, lang],
  );

  const handleResume = useCallback(async () => {
    if (!resumableRun) return;
    const epoch = ++epochRef.current;
    setBusy(true);
    setError(null);
    const res = await tryAction<RunView>(host, 'review.get', { runId: resumableRun.id });
    if (!mountedRef.current || epochRef.current !== epoch) return;
    setBusy(false);
    if (!res.ok || !res.value) {
      setError(res.error?.message || t(lang, '恢复考试失败', 'Failed to resume exam'));
      return;
    }
    setRunKind(res.value.examKinds === 'case' ? 'case' : 'written');
    setRun(res.value);
    setOral(null);
    setPhase('running');
  }, [host, lang, resumableRun]);

  const handleOpenHistory = useCallback(
    async (item: HistoryItem) => {
      const epoch = ++epochRef.current;
      setBusy(true);
      setError(null);
      const action = item.kind === 'oral' ? 'oral.report' : 'exam.report';
      const res = await tryAction<ExamReport | OralReport>(host, action, { runId: item.runId });
      if (!mountedRef.current || epochRef.current !== epoch) return;
      setBusy(false);
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '打开考试报告失败', 'Failed to load report'));
        return;
      }
      setReportState(
        item.kind === 'oral'
          ? { kind: 'oral', report: res.value as OralReport }
          : { kind: 'written', report: res.value as ExamReport },
      );
      setPhase('report');
    },
    [host, lang],
  );

  const handleSelectPick = useCallback(
    async (cardId: string, selected: string[]) => {
      if (!run) return;
      const res = await tryAction<RunView>(host, 'review.answer', {
        runId: run.id,
        cardId,
        selected,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '保存选择失败', 'Failed to save pick'));
        return;
      }
      setError(null);
      setRun(res.value);
    },
    [host, lang, run],
  );

  const handleSaveCaseResponse = useCallback(
    async (cardId: string, response: string) => {
      if (!run) return;
      const res = await tryAction<RunView>(host, 'review.answer', {
        runId: run.id,
        cardId,
        response,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '保存回答失败', 'Failed to save response'));
        return;
      }
      setError(null);
      setRun(res.value);
    },
    [host, lang, run],
  );

  const handleJumpWritten = useCallback(
    async (index: number) => {
      if (!run) return;
      const res = await tryAction<RunView>(host, 'review.move', { runId: run.id, index });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '切题失败', 'Failed to jump question'));
        return;
      }
      setError(null);
      setRun(res.value);
    },
    [host, lang, run],
  );

  const handleSubmitWritten = useCallback(
    async (caseResponses?: Record<string, string>) => {
      if (!run) return;
      const epoch = ++epochRef.current;
      setBusy(true);
      setError(null);
      const res = await tryAction<ExamReport>(host, 'exam.submit', {
        runId: run.id,
        ...(caseResponses ? { responses: caseResponses } : {}),
      });
      if (!mountedRef.current || epochRef.current !== epoch) return;
      setBusy(false);
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '交卷失败', 'Submit failed'));
        return;
      }
      setReportState({ kind: 'written', report: res.value });
      setRun(null);
      setPhase('report');
      notify(t(lang, '已交卷并生成成绩单', 'Exam submitted'), 'success');
      void refreshSnapshot();
    },
    [host, lang, run, notify, refreshSnapshot],
  );

  const handleSaveOralAnswer = useCallback(
    async (cardId: string, answer: string, field: 'main' | 'followup') => {
      if (!oral) return;
      setBusy(true);
      const res = await tryAction<OralView>(host, 'oral.answer', {
        runId: oral.id,
        cardId,
        answer,
        field,
      });
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '保存回答失败', 'Failed to save oral answer'));
        return;
      }
      setError(null);
      setOral(res.value);
    },
    [host, lang, oral],
  );

  const handleOralFollowup = useCallback(
    async (cardId: string) => {
      if (!oral) return;
      setBusy(true);
      const res = await tryAction<OralView>(host, 'oral.followup', {
        runId: oral.id,
        cardId,
      });
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok || !res.value) {
        setError(res.error?.message || t(lang, '生成追问失败', 'Failed to generate follow-up'));
        return;
      }
      setError(null);
      setOral(res.value);
    },
    [host, lang, oral],
  );

  const handleOralNext = useCallback(async () => {
    if (!oral) return;
    setBusy(true);
    const res = await tryAction<OralView>(host, 'oral.next', { runId: oral.id });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok || !res.value) {
      setError(res.error?.message || t(lang, '切题失败', 'Failed to move next'));
      return;
    }
    setError(null);
    setOral(res.value);
  }, [host, lang, oral]);

  const handleSubmitOral = useCallback(async () => {
    if (!oral) return;
    const epoch = ++epochRef.current;
    setBusy(true);
    setError(null);
    const res = await tryAction<OralReport>(host, 'oral.submit', { runId: oral.id });
    if (!mountedRef.current || epochRef.current !== epoch) return;
    setBusy(false);
    if (!res.ok || !res.value) {
      setError(res.error?.message || t(lang, '提交口试失败', 'Failed to submit oral exam'));
      return;
    }
    setReportState({ kind: 'oral', report: res.value });
    setOral(null);
    setPhase('report');
    notify(t(lang, '口试评估完成', 'Oral exam assessed'), 'success');
    void refreshSnapshot();
  }, [host, lang, oral, notify, refreshSnapshot]);

  const handlePracticeWeak = useCallback(
    async (scope: Array<{ deckId: string; cardId?: string }>) => {
      if (!scope.length) return;
      setBusy(true);
      const res = await tryAction<{ id: string }>(host, 'review.start', {
        mode: 'path',
        scope,
        fresh: true,
      });
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok || !res.value?.id) {
        notify(res.error?.message || t(lang, '启动错题练习失败', 'Failed to start weak practice'), 'error');
        return;
      }
      navigate('review', { runId: res.value.id });
    },
    [host, lang, navigate, notify],
  );

  const handleSaveHighlights = useCallback(
    async (highlights: CaseHighlight[]) => {
      if (!run) return;
      const res = await tryAction<{ runId: string; highlights: CaseHighlight[] }>(host, 'review.highlights', {
        runId: run.id,
        highlights,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '保存高亮失败', 'Failed to save highlight'), 'error');
        return;
      }
      setRun((prev) => (prev ? { ...prev, highlights: res.value!.highlights } : prev));
    },
    [host, lang, notify, run],
  );

  const handleLoadSourceText = useCallback(
    async (sourceId: string): Promise<string | null> => {
      if (!sourceId) return null;
      const res = await tryAction<{ text?: string }>(host, 'source.get', { id: sourceId });
      if (!mountedRef.current || !res.ok || !res.value) return null;
      return typeof res.value.text === 'string' ? res.value.text : null;
    },
    [host],
  );

  const hints: readonly KeyHint[] = useMemo(() => {
    if (phase === 'setup') {
      return [
        { key: '1-3', label: t(lang, '模式', 'Mode') },
        { key: 'c/t', label: t(lang, '题数/时长', 'Count/Time') },
        { key: 'Enter', label: t(lang, '开始/查看', 'Start/View') },
        { key: 'Tab', label: t(lang, '历史', 'History') },
      ];
    }
    if (phase === 'running') {
      if (runKind === 'case') {
        return [
          { key: 's', label: t(lang, '案例', 'Scenario') },
          { key: 'H', label: t(lang, '高亮', 'Highlight') },
          { key: 'e', label: t(lang, '作答', 'Answer') },
          { key: 'n/p', label: t(lang, '切题', 'Move') },
          { key: 'Ctrl+S', label: t(lang, '交卷', 'Submit') },
        ];
      }
      if (runKind === 'oral') {
        return [
          { key: 'e', label: t(lang, '作答', 'Answer') },
          { key: 'a', label: t(lang, '追问', 'Follow-up') },
          { key: 'n', label: t(lang, '下一题', 'Next') },
          { key: 'Ctrl+S', label: t(lang, '交卷', 'Submit') },
        ];
      }
      return [
        { key: '1-9', label: t(lang, '作答', 'Answer') },
        { key: 'n/p', label: t(lang, '切题', 'Prev/Next') },
        { key: 'f', label: t(lang, '标记', 'Flag') },
        { key: 'Ctrl+S', label: t(lang, '交卷', 'Submit') },
      ];
    }
    return [
      { key: 'w', label: t(lang, '练错题', 'Practise Weak') },
      { key: 'Tab', label: t(lang, '切换面板', 'Pane') },
      { key: 'b', label: t(lang, '返回', 'Back') },
    ];
  }, [phase, runKind, lang]);

  useFooterHints(hints, isActive);

  if (phase === 'running' && (run || oral)) {
    return (
      <Suspense
        fallback={
          <Box paddingX={1} paddingY={1}>
            <Spinner label={useTuiStore.getState().preferences.asciiMode ? t(lang, '正在载入考场...', 'Loading exam runner...') : t(lang, '正在载入考场…', 'Loading exam runner…')} active={isActive} />
          </Box>
        }
      >
        <ExamRunner
          kind={runKind}
          run={run}
          oral={oral}
          width={width}
          height={height}
          lang={lang}
          isActive={isActive}
          busy={busy}
          error={error}
          onSelectPick={handleSelectPick}
          onSaveCaseResponse={handleSaveCaseResponse}
          onSaveHighlights={handleSaveHighlights}
          onLoadSourceText={handleLoadSourceText}
          onJumpWritten={handleJumpWritten}
          onSubmitWritten={handleSubmitWritten}
          onSaveOralAnswer={handleSaveOralAnswer}
          onOralFollowup={handleOralFollowup}
          onOralNext={handleOralNext}
          onSubmitOral={handleSubmitOral}
          onAbortBack={() => {
            setPhase('setup');
            setError(null);
          }}
        />
      </Suspense>
    );
  }

  if (phase === 'report' && reportState) {
    return (
      <Suspense
        fallback={
          <Box paddingX={1} paddingY={1}>
            <Spinner label={useTuiStore.getState().preferences.asciiMode ? t(lang, '正在载入成绩报告...', 'Loading exam report...') : t(lang, '正在载入成绩报告…', 'Loading exam report…')} active={isActive} />
          </Box>
        }
      >
        <ExamReportView
          state={reportState}
          width={width}
          height={height}
          lang={lang}
          isActive={isActive}
          busy={busy}
          onPracticeWeak={handlePracticeWeak}
          onBack={() => {
            setPhase('setup');
            setError(null);
          }}
        />
      </Suspense>
    );
  }

  return (
    <ExamSetup
      snapshot={snapshot}
      width={width}
      height={height}
      lang={lang}
      isActive={isActive}
      busy={busy}
      error={error}
      resumableRun={resumableRun}
      onStart={handleStart}
      onResume={handleResume}
      onOpenHistory={handleOpenHistory}
    />
  );
});
