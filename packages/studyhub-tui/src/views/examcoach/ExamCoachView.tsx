import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  Divider,
  EmptyState,
  Modal,
  Panel,
  ProgressBar,
  ScrollView,
  Spinner,
  SplitPane,
  StatusPill,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useTheme,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';
import { currentCourse, listCourses, modelInfo } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { tryAction } from '../../host/index.js';
import {
  formatKindLabel,
  overallLabel,
  overallTone,
  priorityLabel,
  type CoachCalibrationGetResult,
  type CoachCapabilityEvidence,
  type CoachSpec,
  type CoachStatusResult,
  type CoachTab,
  type CoachTaskFamily,
  type CompiledRequestResult,
  type CourseEvidencePoint,
  type CourseEvidenceSummaryResult,
  type MockComposeResult,
  type WrongBookEntry,
} from './types.js';
const CoachPreferencesModal = lazy(() => import('./CoachPreferencesModal.js').then((m) => ({ default: m.CoachPreferencesModal })));

const CLAIMED_KEYS = [
  '1', '2', '3', '4',
  'a', 'A', 'b', 'e', 'g', 'G', 'm', 'n', 'N', 'p', 'P', 'r', 'v', 'x', 'y', 'z',
] as const;

const TABS: readonly { id: CoachTab; num: string; zh: string; en: string }[] = [
  { id: 'calibration', num: '1', zh: '校准与考法', en: 'Calibration' },
  { id: 'variants', num: '2', zh: '变式训练', en: 'Variants' },
  { id: 'evidence', num: '3', zh: '能力证据', en: 'Evidence' },
  { id: 'mock', num: '4', zh: '组卷预检', en: 'Mock Check' },
];

export const ExamCoachView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const desktopConfig = useTuiStore((s) => s.desktopConfig);
  const binding = useTuiStore((s) => s.binding);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const activeCourse = currentCourse(snapshot);
  const knownCourses = useMemo(() => listCourses(snapshot).map((c) => c.key), [snapshot]);
  const [courseOverride, setCourseOverride] = useState<string | null>(null);
  const course = courseOverride !== null ? courseOverride : activeCourse || knownCourses[0] || '';
  const model = useMemo(() => modelInfo(desktopConfig, binding, snapshot, asciiMode), [desktopConfig, binding, snapshot, asciiMode]);

  const [tab, setTab] = useState<CoachTab>('calibration');
  const [focusPane, setFocusPane] = useState<'left' | 'right'>('left');

  const [loading, setLoading] = useState(true);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [spec, setSpec] = useState<CoachSpec | null>(null);
  const [coachEvidence, setCoachEvidence] = useState<CoachCapabilityEvidence | null>(null);
  const [courseEvidence, setCourseEvidence] = useState<CourseEvidenceSummaryResult | null>(null);
  const [coachStatus, setCoachStatus] = useState<CoachStatusResult | null>(null);
  const [wrongItems, setWrongItems] = useState<WrongBookEntry[]>([]);
  const [compiledPreview, setCompiledPreview] = useState<CompiledRequestResult | null>(null);
  const [mockReport, setMockReport] = useState<MockComposeResult | null>(null);

  const [familyIdx, setFamilyIdx] = useState(0);
  const [wrongIdx, setWrongIdx] = useState(0);
  const [pointIdx, setPointIdx] = useState(0);

  // Modals
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteField, setNoteField] = useState<'title' | 'text'>('text');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editField, setEditField] = useState<'quota' | 'priority' | 'time'>('quota');
  const [editQuota, setEditQuota] = useState('4');
  const [editPriority, setEditPriority] = useState<'high' | 'medium' | 'deferred'>('high');
  const [editTimeSec, setEditTimeSec] = useState('90');

  const [consentPromptCards, setConsentPromptCards] = useState<Array<{ deckId: string; cardId: string }> | null>(null);
  const [confirmAiAnalyze, setConfirmAiAnalyze] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState<CompiledRequestResult | null>(null);
  const [prefsModalOpen, setPrefsModalOpen] = useState(false);

  const modalOpen =
    noteModalOpen ||
    editModalOpen ||
    prefsModalOpen ||
    consentPromptCards !== null ||
    confirmAiAnalyze ||
    confirmGenerate !== null;
  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadAll = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setErrorMsg(null);
    const [calRes, evRes, stRes, wbRes] = await Promise.all([
      tryAction<CoachCalibrationGetResult>(host, 'coach.calibration.get', { course }),
      tryAction<CourseEvidenceSummaryResult>(host, 'course.evidence.summary', course ? { course } : {}),
      tryAction<CoachStatusResult>(host, 'coach.status', {}),
      tryAction<{ items?: WrongBookEntry[] }>(host, 'wrongbook', { ...(course ? { course } : {}), view: 'weak', offset: 0, limit: 30 }),
    ]);
    if (!mountedRef.current || seq !== reqSeqRef.current) return;
    if (calRes.ok && calRes.value) {
      setSpec(calRes.value.spec || null);
      setCoachEvidence(calRes.value.evidence || null);
    } else if (!calRes.ok) {
      setErrorMsg(calRes.error?.message || t(lang, '加载考法校准失败', 'Failed to load calibration'));
    }
    if (evRes.ok && evRes.value) setCourseEvidence(evRes.value);
    if (stRes.ok && stRes.value) setCoachStatus(stRes.value);
    if (wbRes.ok && wbRes.value) setWrongItems(Array.isArray(wbRes.value.items) ? wbRes.value.items : []);
    setLoading(false);
  }, [host, course, lang]);

  useEffect(() => {
    setLoading(true);
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const unsub = host.subscribeEvents(() => {
      if (mountedRef.current) void loadAll();
    });
    return unsub;
  }, [host, loadAll]);

  const families = spec?.taskFamilies ?? [];
  const selectedFamily: CoachTaskFamily | undefined = families[Math.min(familyIdx, Math.max(0, families.length - 1))];
  const selectedWrong: WrongBookEntry | undefined = wrongItems[Math.min(wrongIdx, Math.max(0, wrongItems.length - 1))];
  const evidencePoints = courseEvidence?.points ?? [];
  const selectedPoint: CourseEvidencePoint | undefined = evidencePoints[Math.min(pointIdx, Math.max(0, evidencePoints.length - 1))];

  useClaimKeys(CLAIMED_KEYS, isActive && !modalOpen);

  const hints = useMemo<KeyHint[]>(() => {
    if (tab === 'calibration') {
      return [
        { key: '1-4', label: t(lang, '标签页', 'Tabs') },
        { key: 'a/A', label: t(lang, '分析/AI深化', 'Analyze/AI') },
        { key: 'N', label: t(lang, '提交样卷笔记', 'Past Notes') },
        { key: 'v', label: t(lang, '展开样题答案', 'Reveal') },
        { key: 'x/y/z', label: t(lang, '三项确认', 'Confirm') },
        { key: 'e', label: t(lang, '编辑配额', 'Edit') },
        { key: 'p', label: t(lang, '学习偏好', 'Preferences') },
      ];
    }
    if (tab === 'variants') {
      return [
        { key: '1-4', label: t(lang, '标签页', 'Tabs') },
        { key: 'g/G', label: t(lang, '生成变式/批量', 'Variants') },
        { key: 'p/P', label: t(lang, '教练练习', 'Coach Practice') },
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
      ];
    }
    if (tab === 'evidence') {
      return [
        { key: '1-4', label: t(lang, '标签页', 'Tabs') },
        { key: 'Tab', label: t(lang, '切换栏', 'Pane') },
        { key: 'p', label: t(lang, '练习当前考点', 'Practice') },
        { key: 'P', label: t(lang, '学习偏好', 'Preferences') },
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
      ];
    }
    return [
      { key: '1-4', label: t(lang, '标签页', 'Tabs') },
      { key: 'b', label: t(lang, '编译预览', 'Preview') },
      { key: 'm', label: t(lang, '同型组卷检查', 'Mock Check') },
      { key: 'g', label: t(lang, '按校准出题', 'Generate') },
      { key: 'p', label: t(lang, '学习偏好', 'Preferences') },
    ];
  }, [tab, lang]);

  useFooterHints(hints, isActive);

  // Actions
  const runAnalyze = useCallback(async (useModel: boolean, referenceSourceIds?: string[]) => {
    if (busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(useModel ? t(lang, '正在结合 AI 分析考察方式…', 'Analyzing exam style with AI...') : t(lang, '正在分析考察方式…', 'Analyzing exam style...'));
    setErrorMsg(null);
    try {
      const res = await tryAction<{ spec?: CoachSpec; evidence?: CoachCapabilityEvidence }>(host, 'coach.calibration.analyze', {
        course,
        useModel,
        ...(referenceSourceIds?.length ? { referenceSourceIds } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setErrorMsg(res.error?.message || t(lang, '分析失败', 'Analyze failed'));
        notify(res.error?.message || t(lang, '分析失败', 'Analyze failed'), 'error');
        return;
      }
      if (res.value?.spec) setSpec(res.value.spec);
      if (res.value?.evidence) setCoachEvidence(res.value.evidence);
      setCompiledPreview(null);
      notify(t(lang, '已更新考察方式与代表样题草案', 'Calibration draft updated'), 'success');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, course, lang, notify]);

  const toggleConfirm = useCallback(async (patch: Record<string, boolean>) => {
    if (!selectedFamily || busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    try {
      const res = await tryAction<{ spec?: CoachSpec; evidence?: CoachCapabilityEvidence }>(host, 'coach.calibration.confirm', {
        course,
        familyId: selectedFamily.id,
        ...patch,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '确认失败', 'Confirm failed'), 'error');
        return;
      }
      if (res.value?.spec) setSpec(res.value.spec);
      if (res.value?.evidence) setCoachEvidence(res.value.evidence);
      if (patch.revealSampleSolution) {
        notify(t(lang, '已展开样题答案并记录解法暴露', 'Sample solution revealed & exposure recorded'), 'info');
      }
    } finally {
      busyRef.current = false;
    }
  }, [busyLabel, host, course, selectedFamily, lang, notify]);

  const saveCoachNote = useCallback(async () => {
    if (busyRef.current || busyLabel !== null) return;
    const trimmed = noteText.trim();
    if (!trimmed) {
      notify(t(lang, '请先粘贴样卷描述或考法笔记', 'Paste past-paper or exam-style notes first'), 'warning');
      return;
    }
    busyRef.current = true;
    setNoteModalOpen(false);
    setBusyLabel(t(lang, '正在保存样卷笔记…', 'Saving exam-style notes...'));
    try {
      const title = noteTitle.trim() || `${course || t(lang, '考试', 'Exam')} - ${t(lang, '考法样卷笔记', 'Past-Paper Style Notes')}`;
      const added = await tryAction<{ id: string }>(host, 'source.add', {
        title,
        text: trimmed,
        format: 'md',
        ...(course ? { courses: [course] } : {}),
      });
      if (!mountedRef.current) return;
      if (!added.ok || !added.value?.id) {
        notify(added.error?.message || t(lang, '保存样卷笔记失败', 'Failed to save notes'), 'error');
        return;
      }
      setNoteTitle('');
      setNoteText('');
      await refreshSnapshot();
      await loadAll();
      if (!mountedRef.current) return;
      notify(
        t(lang, '已保存教练笔记（如需重新 AI 分析考法，请按 [A]）', 'Coach note saved (press [A] to re-run AI analysis)'),
        'success',
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, noteText, noteTitle, course, host, lang, notify, refreshSnapshot, loadAll]);

  const saveFamilyEdits = useCallback(async () => {
    if (!spec || !selectedFamily || busyRef.current || busyLabel !== null) return;
    const quota = Math.max(0, Math.min(50, Math.floor(Number(editQuota) || 0)));
    const timeBudgetSec = Math.max(15, Math.min(3600, Math.floor(Number(editTimeSec) || 90)));
    const nextFamilies = spec.taskFamilies.map((f) =>
      f.id === selectedFamily.id ? { ...f, quota, priority: editPriority, timeBudgetSec } : f,
    );
    busyRef.current = true;
    setEditModalOpen(false);
    setBusyLabel(t(lang, '正在保存训练配置…', 'Saving training configuration...'));
    try {
      const res = await tryAction<{ spec?: CoachSpec; evidence?: CoachCapabilityEvidence }>(host, 'coach.calibration.save', {
        course,
        taskFamilies: nextFamilies,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存失败', 'Save failed'), 'error');
        return;
      }
      if (res.value?.spec) setSpec(res.value.spec);
      if (res.value?.evidence) setCoachEvidence(res.value.evidence);
      setCompiledPreview(null);
      notify(t(lang, '已保存任务族配额与时限', 'Saved task family quota & budget'), 'success');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, spec, selectedFamily, editQuota, editPriority, editTimeSec, host, course, lang, notify]);

  const queueVariants = useCallback(async (cards: Array<{ deckId: string; cardId: string }>, consent?: boolean) => {
    if (busyRef.current || busyLabel !== null) return;
    if (!cards.length) {
      notify(t(lang, '没有可生成变式的薄弱题', 'No weak cards to generate variants for'), 'warning');
      return;
    }
    busyRef.current = true;
    setBusyLabel(t(lang, '正在排队生成变式题…', 'Queueing variant generation...'));
    try {
      const res = await tryAction<{ queued?: number; needsConsent?: boolean; skipped?: unknown[]; status?: CoachStatusResult }>(host, 'coach.variants', {
        cards,
        ...(consent ? { consent: true } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '生成变式失败', 'Variant generation failed'), 'error');
        return;
      }
      if (res.value?.needsConsent) {
        setConsentPromptCards(cards);
        return;
      }
      if (res.value?.status) setCoachStatus(res.value.status);
      notify(
        t(lang, `已入队 ${res.value?.queued ?? 0} 道变式题`, `Queued ${res.value?.queued ?? 0} variant(s)`),
        'success',
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, lang, notify]);

  const startCoachPractice = useCallback(async (originCardIds?: string[]) => {
    if (busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(t(lang, '正在启动教练针对练习…', 'Starting targeted coach practice...'));
    try {
      const res = await tryAction<{ id: string }>(host, 'coach.practice', originCardIds?.length ? { originCardIds } : {});
      if (!mountedRef.current) return;
      if (!res.ok || !res.value?.id) {
        notify(res.error?.message || t(lang, '暂时没有备好的定制题', 'No ready coach variants yet'), 'warning');
        return;
      }
      await refreshSnapshot();
      navigate('review', { runId: res.value.id });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, lang, notify, refreshSnapshot, navigate]);

  const startPointPractice = useCallback(async (point: CourseEvidencePoint | undefined) => {
    if (!point || busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(t(lang, '正在启动考点练习…', 'Starting point practice...'));
    try {
      if (point.cardRefs && point.cardRefs.length > 0) {
        const res = await tryAction<{ id: string }>(host, 'review.start', { mode: 'path', scope: point.cardRefs, fresh: true });
        if (!mountedRef.current) return;
        if (res.ok && res.value?.id) {
          navigate('review', { runId: res.value.id });
          return;
        }
        notify(res.error?.message || t(lang, '无法启动练习', 'Cannot start practice'), 'error');
        return;
      }
      if (course) {
        const res = await tryAction<{ id: string }>(host, 'review.start', { mode: 'due', course, fresh: true });
        if (!mountedRef.current) return;
        if (res.ok && res.value?.id) {
          navigate('review', { runId: res.value.id });
          return;
        }
      }
      notify(t(lang, '该考点暂无关联题目，请先出题', 'No linked cards for this point yet'), 'warning');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, course, lang, navigate, notify]);

  const buildRequestPreview = useCallback(async () => {
    if (busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(t(lang, '正在编译校准出题请求…', 'Compiling calibrated request...'));
    try {
      const res = await tryAction<CompiledRequestResult>(host, 'coach.calibration.buildRequest', { course });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '请先执行「分析考法」', 'Run calibration analysis first'), 'warning');
        return;
      }
      setCompiledPreview(res.value);
      notify(t(lang, `预览就绪：共 ${res.value.totalCount} 题`, `Preview ready: ${res.value.totalCount} questions`), 'success');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, course, lang, notify]);

  const checkStrictMock = useCallback(async () => {
    if (busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(t(lang, '正在核对严格同型组卷缺口…', 'Checking strict mock composition...'));
    try {
      const activeFamilies = families.filter((f) => f.quota > 0);
      const sections = activeFamilies.length
        ? activeFamilies.map((f) => ({
            id: f.id,
            title: f.title,
            allowedKinds: f.allowFormSubstitute && f.allowedFormats?.length ? f.allowedFormats : [f.primaryFormat],
            count: Math.max(1, f.quota),
            marksPerItem: f.marksPerItem ?? 5,
            timePerItemSec: f.timeBudgetSec ?? 180,
            requiresSharedMaterial: f.quotaUnit === 'shared-material-group' || f.primaryFormat === 'case',
            subpartsCount: f.quotaUnit === 'subquestion' ? Math.max(2, f.questionsPerUnit ?? 2) : 0,
          }))
        : [{ id: 'default-quiz', title: t(lang, '基础客观题', 'Basic MCQ'), allowedKinds: ['quiz'], count: 4, marksPerItem: 5, timePerItemSec: 180 }];
      const res = await tryAction<MockComposeResult>(host, 'coach.mockPaper.compose', { course, examShape: { sections } });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '同型卷核对失败', 'Mock composition check failed'), 'error');
        return;
      }
      setMockReport(res.value);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, families, host, course, lang, notify]);

  const requestCalibratedGenerate = useCallback(async () => {
    if (busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(t(lang, '正在估算校准出题数量…', 'Estimating calibrated generation...'));
    try {
      const built = await tryAction<CompiledRequestResult>(host, 'coach.calibration.buildRequest', { course });
      if (!mountedRef.current) return;
      if (!built.ok || !built.value) {
        notify(built.error?.message || t(lang, '请先执行分析考法', 'Analyze exam style first'), 'warning');
        return;
      }
      if (built.value.totalCount <= 0) {
        notify(t(lang, '启用配额为 0，请先调整至少一项任务配额', 'All quotas are 0; set at least one non-zero quota'), 'warning');
        return;
      }
      setCompiledPreview(built.value);
      setConfirmGenerate(built.value);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, course, lang, notify]);

  const executeCalibratedGenerate = useCallback(async (built: CompiledRequestResult) => {
    if (busyRef.current || busyLabel !== null) return;
    busyRef.current = true;
    setBusyLabel(t(lang, '正在按校准方案启动出题…', 'Starting calibrated generation...'));
    try {
      const gen = await tryAction(host, 'generate', built.request);
      if (!mountedRef.current) return;
      if (!gen.ok) {
        notify(gen.error?.message || t(lang, '启动出题失败', 'Failed to start generation'), 'error');
        return;
      }
      notify(t(lang, '已启动后台校准出题，可前往「后台任务」查看', 'Started calibrated generation job'), 'success');
      navigate('tasks');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, lang, notify, navigate]);

  useInput(
    (input, key) => {
      if (modalOpen) return;
      if (input === '1') { setTab('calibration'); return; }
      if (input === '2') { setTab('variants'); return; }
      if (input === '3') { setTab('evidence'); return; }
      if (input === '4') { setTab('mock'); return; }
      if (key.tab) {
        setFocusPane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (input === 'r') {
        void loadAll();
        return;
      }

      if (tab === 'calibration') {
        if (input === 'p') { setPrefsModalOpen(true); return; }
        if (input === 'a') {
          if (busyRef.current || busyLabel !== null) return;
          void runAnalyze(false);
          return;
        }
        if (input === 'A') {
          if (busyRef.current || busyLabel !== null) return;
          setConfirmAiAnalyze(true);
          return;
        }
        if (input === 'N' || input === 'n') {
          setNoteField('text');
          setNoteModalOpen(true);
          return;
        }
        if (input === 'v' && selectedFamily) {
          void toggleConfirm({ revealSampleSolution: true });
          return;
        }
        if (input === 'x' && selectedFamily) {
          void toggleConfirm({ appearanceApproved: !selectedFamily.confirmations?.appearanceApproved });
          return;
        }
        if (input === 'y' && selectedFamily) {
          void toggleConfirm({ intentApproved: !selectedFamily.confirmations?.intentApproved });
          return;
        }
        if (input === 'z' && selectedFamily) {
          void toggleConfirm({ answerVerified: !selectedFamily.confirmations?.answerVerified });
          return;
        }
        if (input === 'e' && selectedFamily) {
          setEditQuota(String(selectedFamily.quota ?? 4));
          const p = selectedFamily.priority === 'high' || selectedFamily.priority === 'deferred' ? selectedFamily.priority : 'medium';
          setEditPriority(p);
          setEditTimeSec(String(selectedFamily.timeBudgetSec ?? 90));
          setEditField('quota');
          setEditModalOpen(true);
          return;
        }
      } else if (tab === 'variants') {
        if (input === 'g' && selectedWrong) {
          if (busyRef.current || busyLabel !== null) return;
          void queueVariants([{ deckId: selectedWrong.deckId, cardId: selectedWrong.cardId }]);
          return;
        }
        if (input === 'G' && wrongItems.length > 0) {
          if (busyRef.current || busyLabel !== null) return;
          const readyIds = new Set((coachStatus?.readyCards ?? []).map((c) => c.originCardId));
          const prepIds = new Set(coachStatus?.preparingCards ?? []);
          const todo = wrongItems
            .filter((w) => !readyIds.has(w.cardId) && !prepIds.has(w.cardId))
            .slice(0, 5)
            .map((w) => ({ deckId: w.deckId, cardId: w.cardId }));
          void queueVariants(todo);
          return;
        }
        if (input === 'p') {
          void startCoachPractice();
          return;
        }
        if (input === 'P' && selectedWrong) {
          void startCoachPractice([selectedWrong.cardId]);
          return;
        }
      } else if (tab === 'evidence') {
        if (input === 'P') {
          setPrefsModalOpen(true);
          return;
        }
        if (input === 'p' && selectedPoint) {
          void startPointPractice(selectedPoint);
          return;
        }
      } else if (tab === 'mock') {
        if (input === 'p') { setPrefsModalOpen(true); return; }
        if (input === 'b') { void buildRequestPreview(); return; }
        if (input === 'm') {
          if (busyRef.current || busyLabel !== null) return;
          void checkStrictMock();
          return;
        }
        if (input === 'g') {
          if (busyRef.current || busyLabel !== null) return;
          void requestCalibratedGenerate();
          return;
        }
      }
    },
    { isActive: isActive && !modalOpen },
  );

  // Modals input handling
  useInput(
    (input, key) => {
      if (noteModalOpen) {
        if (key.tab) {
          setNoteField((f) => (f === 'title' ? 'text' : 'title'));
          return;
        }
        if (key.ctrl && input === 's') {
          void saveCoachNote();
        }
      } else if (editModalOpen) {
        if (key.tab) {
          setEditField((f) => (f === 'quota' ? 'priority' : f === 'priority' ? 'time' : 'quota'));
          return;
        }
        if (editField === 'priority' && (key.leftArrow || key.rightArrow || input === ' ')) {
          const order: Array<'high' | 'medium' | 'deferred'> = ['high', 'medium', 'deferred'];
          const idx = order.indexOf(editPriority);
          const dir = key.leftArrow ? -1 : 1;
          setEditPriority(order[(idx + dir + order.length) % order.length]);
          return;
        }
        if (key.return || (key.ctrl && input === 's')) {
          void saveFamilyEdits();
        }
      }
    },
    { isActive: isActive && (noteModalOpen || editModalOpen) },
  );

  // Build inspector lines for Tab 1 (memoized by selectedFamily & width)
  const familyLines = useMemo(() => {
    if (!selectedFamily) return [];
    const lines: string[] = [];
    const bullet = asciiMode ? '* ' : '• ';
    const chkOn = asciiMode ? '[x]' : '☑';
    const chkOff = asciiMode ? '[ ]' : '☐';
    lines.push(`${t(lang, '任务族', 'Family')}: ${selectedFamily.title}`);
    lines.push(`${t(lang, '题型', 'Format')}: ${formatKindLabel(selectedFamily.primaryFormat, lang)}   ${t(lang, '配额', 'Quota')}: ${selectedFamily.quota}   ${t(lang, '时限', 'Budget')}: ${selectedFamily.timeBudgetSec ?? 90}s`);
    lines.push(`${t(lang, '优先级', 'Priority')}: ${priorityLabel(selectedFamily.priority, lang)}   ${t(lang, '状态', 'Status')}: ${selectedFamily.calibrated ? (asciiMode ? t(lang, '三项已确认 +', 'Calibrated +') : t(lang, '三项已确认 ✓', 'Calibrated ✓')) : t(lang, '待确认', 'Pending')}`);
    lines.push('');
    lines.push(`[x] ${selectedFamily.confirmations?.appearanceApproved ? chkOn : chkOff} ${t(lang, '外观满意', 'Appearance')}   [y] ${selectedFamily.confirmations?.intentApproved ? chkOn : chkOff} ${t(lang, '考察意图满意', 'Intent')}   [z] ${selectedFamily.confirmations?.answerVerified ? chkOn : chkOff} ${t(lang, '答案已核实', 'Answer Verified')}`);
    if (selectedFamily.defects?.length) {
      lines.push('');
      lines.push(`! ${t(lang, '待修正提醒', 'Defects')}:`);
      for (const d of selectedFamily.defects) lines.push(`  - ${d.message}`);
    }
    if (selectedFamily.reasoningSteps?.length) {
      lines.push('');
      lines.push(`${t(lang, '关键推理步骤', 'Reasoning Steps')}:`);
      selectedFamily.reasoningSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    }
    if (selectedFamily.distractorRules?.length) {
      lines.push('');
      lines.push(`${t(lang, '干扰项错因映射', 'Distractor Rules')}:`);
      for (const r of selectedFamily.distractorRules) {
        lines.push(`  ${bullet}${r.code || r.id} (${r.label || ''}): ${r.reason}`);
      }
    }
    if (selectedFamily.rubricPoints?.length) {
      lines.push('');
      lines.push(`${t(lang, '分步评分细则', 'Rubric')}:`);
      for (const r of selectedFamily.rubricPoints) {
        lines.push(`  ${bullet}${r.criterion} (${r.marks}分): ${r.condition}`);
      }
    }
    if (selectedFamily.sample?.stem) {
      lines.push('');
      lines.push(`${t(lang, '代表样题', 'Representative Sample')}:`);
      lines.push(`  ${selectedFamily.sample.stem}`);
      for (const opt of selectedFamily.sample.options ?? []) {
        const mark = !selectedFamily.sample.redacted && opt.correct ? (asciiMode ? ' [+]' : ' [✓]') : '';
        const mis = opt.misconceptionReason ? ` (${opt.misconceptionReason})` : '';
        lines.push(`  [${opt.id}] ${opt.text}${mark}${mis}`);
      }
      if (selectedFamily.sample.redacted) {
        lines.push(`  (${t(lang, '答案已折叠 — 按 v 展开核对并记录解法暴露', 'Answer hidden — press v to reveal & record exposure')})`);
      } else {
        lines.push(`  ${t(lang, '参考答案', 'Answer')}: ${selectedFamily.sample.answer || '-'}`);
        if (selectedFamily.sample.rubric) lines.push(`  ${t(lang, '评分标准', 'Rubric')}: ${selectedFamily.sample.rubric}`);
      }
    }
    return lines;
  }, [selectedFamily, lang, asciiMode]);

  // Layout dimensions
  const headerH = 3;
  const bodyH = Math.max(8, height - headerH - (errorMsg ? 1 : 0));
  const calibratedCount = families.filter((f) => f.calibrated).length;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {/* Header & Tabs */}
      <Box height={1} width={width} justifyContent="space-between" paddingX={1}>
        <Box gap={1}>
          <Text color={theme.primary} bold>
            {`${asciiMode ? 'o' : '◎'} ${t(lang, '考试教练', 'Exam Coach')}`}
          </Text>
          <Badge label={course || t(lang, '全部课程', 'All Courses')} tone="accent" variant="soft" />
          {spec ? (
            <Badge
              label={`v${spec.specVersion ?? 1} ${asciiMode ? '-' : '·'} ${calibratedCount}/${families.length}`}
              tone={calibratedCount === families.length && families.length > 0 ? 'success' : 'warning'}
              variant="outline"
            />
          ) : null}
          {spec?.crunchMode?.enabled ? <Badge label={t(lang, '压缩模式', 'Crunch')} tone="warning" variant="soft" /> : null}
        </Box>
        <Box gap={1}>
          {busyLabel ? <Spinner label={busyLabel} active={isActive} /> : null}
          <StatusPill label={`${model.provider}${model.model ? `/${truncateDisplay(model.model, 16, asciiMode ? '...' : '…')}` : ''}`} status={model.ready ? 'ok' : 'warn'} />
        </Box>
      </Box>

      {/* Tab Strip */}
      <Box height={1} width={width} paddingX={1} gap={1}>
        {TABS.map((tb) => {
          const active = tab === tb.id;
          return (
            <Text key={tb.id} backgroundColor={active ? theme.primary : theme.surface} color={active ? (theme.dark ? theme.bg : '#ffffff') : theme.muted} bold={active}>
              {` ${tb.num}:${lang === 'en' ? tb.en : tb.zh} `}
            </Text>
          );
        })}
        {knownCourses.length > 1 ? (
          <Text color={theme.dim}>{`  (${t(lang, 'c 切换课程', 'c switch course')})`}</Text>
        ) : null}
      </Box>
      <Divider width={width} />
      {errorMsg ? (
        <Box height={1} width={width} paddingX={1}>
          <Text color={theme.error}>{`${asciiMode ? '!' : '✕'} ${truncateDisplay(errorMsg, Math.max(10, width - 4), asciiMode ? '...' : '…')}`}</Text>
        </Box>
      ) : null}

      {/* Main Content */}
      {loading && !spec && !courseEvidence ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Spinner label={asciiMode ? t(lang, '正在加载考试教练...', 'Loading Exam Coach...') : t(lang, '正在加载考试教练…', 'Loading Exam Coach…')} active={isActive} />
        </Box>
      ) : tab === 'calibration' ? (
        !spec ? (
          <Box flexDirection="column" height={bodyH} width={width} padding={1}>
            <EmptyState
              icon={asciiMode ? 'o' : '◎'}
              title={t(lang, '尚未建立考法校准方案', 'No Exam Calibration Profile Yet')}
              hint={t(lang, '可基于课程资料/样卷分析考察任务族，或直接粘贴往年样卷与考法笔记。', 'Analyze course materials or submit past-paper notes to calibrate task families.')}
              actions={[
                { key: 'a', label: t(lang, '分析考察方式', 'Analyze') },
                ...(model.ready ? [{ key: 'A', label: t(lang, 'AI 深化分析', 'AI Analyze') }] : []),
                { key: 'N', label: t(lang, '提交样卷/考法笔记', 'Submit Past-Paper Notes') },
              ]}
              width={width - 2}
              height={Math.max(6, bodyH - 2)}
            />
          </Box>
        ) : (
          <SplitPane
            width={width}
            height={bodyH}
            leftWidth={0.42}
            activePane={focusPane}
            leftLabel={t(lang, '任务族列表', 'Task Families')}
            rightLabel={t(lang, '校准详情', 'Inspector')}
            left={(sz) => (
              <Panel
                title={t(lang, '考察任务族', 'Task Families')}
                badge={families.length}
                subtitle={t(lang, 'a分析 N样卷笔记', 'a:Analyze N:Notes')}
                focused={focusPane === 'left'}
                width={sz.width}
                height={sz.height}
                paddingX={0}
              >
                <VirtualList
                  items={families}
                  width={Math.max(10, sz.width - 2)}
                  height={Math.max(3, sz.height - 2)}
                  selectedIndex={familyIdx}
                  onChange={setFamilyIdx}
                  isActive={isActive && !modalOpen && focusPane === 'left'}
                  emptyText={t(lang, '暂无任务族', 'No task families')}
                  renderItem={(f, ctx) => {
                    const icon = f.calibrated ? (asciiMode ? '+' : '✓') : (asciiMode ? 'o' : '○');
                    const meta = `${formatKindLabel(f.primaryFormat, lang)}${asciiMode ? ':' : '·'}${f.quota}`;
                    const labelW = Math.max(6, ctx.width - displayWidth(meta) - 4);
                    const line = `${icon} ${padDisplay(truncateDisplay(f.title, labelW, asciiMode ? '...' : '…'), labelW)} ${meta}`;
                    return (
                      <Text color={ctx.selected ? theme.selectionFg : f.calibrated ? theme.success : theme.text} bold={ctx.selected}>
                        {truncateDisplay(line, ctx.width, asciiMode ? '...' : '…')}
                      </Text>
                    );
                  }}
                />
              </Panel>
            )}
            right={(sz) => (
              <Panel
                title={selectedFamily ? truncateDisplay(selectedFamily.title, Math.max(10, sz.width - 18), asciiMode ? '...' : '…') : t(lang, '详情', 'Details')}
                subtitle={t(lang, 'x/y/z确认 v答案 e配额', 'x/y/z v e')}
                focused={focusPane === 'right'}
                width={sz.width}
                height={sz.height}
                paddingX={1}
              >
                {selectedFamily ? (
                  <ScrollView
                    lines={familyLines}
                    width={Math.max(10, sz.width - 4)}
                    height={Math.max(3, sz.height - 2)}
                    isActive={isActive && !modalOpen && focusPane === 'right'}
                  />
                ) : (
                  <Text color={theme.muted}>{t(lang, '请选择左侧任务族', 'Select a task family')}</Text>
                )}
              </Panel>
            )}
          />
        )
      ) : tab === 'variants' ? (
        <SplitPane
          width={width}
          height={bodyH}
          leftWidth={0.55}
          activePane={focusPane}
          leftLabel={t(lang, '薄弱题变式', 'Weak Cards & Variants')}
          rightLabel={t(lang, '教练队列', 'Coach Queue')}
          left={(sz) => (
            <Panel
              title={t(lang, '错题/薄弱题变式状态', 'Weak Cards Variant Status')}
              badge={wrongItems.length}
              subtitle={t(lang, 'g单题 G批量 p开练', 'g/G:Queue p:Practice')}
              focused={focusPane === 'left'}
              width={sz.width}
              height={sz.height}
              paddingX={0}
            >
              <VirtualList
                items={wrongItems}
                width={Math.max(10, sz.width - 2)}
                height={Math.max(3, sz.height - 2)}
                selectedIndex={wrongIdx}
                onChange={setWrongIdx}
                isActive={isActive && !modalOpen && focusPane === 'left'}
                emptyText={t(lang, '当前课程暂无待巩固薄弱题', 'No weak cards in current course')}
                emptyHint={t(lang, '完成刷题后，薄弱题会自动出现在这里以生成举一反三变式。', 'Wrong or weak items appear here for variant generation.')}
                renderItem={(item, ctx) => {
                  const isReady = (coachStatus?.readyCards ?? []).some((r) => r.originCardId === item.cardId);
                  const isPrep = (coachStatus?.preparingCards ?? []).includes(item.cardId);
                  const isFail = (coachStatus?.failedCards ?? []).some((f) => f.cardId === item.cardId);
                  const tag = isReady
                    ? asciiMode
                      ? t(lang, '[+已备好]', '[+Ready]')
                      : t(lang, '[✓已备好]', '[✓Ready]')
                    : isPrep
                      ? asciiMode
                        ? t(lang, '[*生成中]', '[*Prep]')
                        : t(lang, '[⟳生成中]', '[⟳Prep]')
                      : isFail
                        ? t(lang, '[!失败]', '[!Fail]')
                        : asciiMode
                          ? t(lang, '[o未生成]', '[oIdle]')
                          : t(lang, '[○未生成]', '[○Idle]');
                  const tagW = displayWidth(tag);
                  const textW = Math.max(6, ctx.width - tagW - 2);
                  const title = truncateDisplay(String(item.prompt || item.topic || item.cardId).replace(/\s+/g, ' '), textW, asciiMode ? '...' : '…');
                  return (
                    <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                      {`${padDisplay(title, textW)} ${tag}`}
                    </Text>
                  );
                }}
              />
            </Panel>
          )}
          right={(sz) => (
            <Panel
              title={t(lang, '教练备题池', 'Prepared Variant Pool')}
              badge={coachStatus?.ready ?? 0}
              badgeTone={(coachStatus?.ready ?? 0) > 0 ? 'success' : 'muted'}
              focused={focusPane === 'right'}
              width={sz.width}
              height={sz.height}
            >
              <Box flexDirection="column" gap={1}>
                <Box gap={2}>
                  <StatusPill
                    label={coachStatus?.enabled ? t(lang, '教练模型就绪', 'Coach Ready') : t(lang, '无可用模型', 'Model Unready')}
                    status={coachStatus?.enabled ? 'ok' : 'warn'}
                  />
                  {coachStatus?.preparing ? <Spinner label={asciiMode ? t(lang, '后台生成中', 'Preparing...') : t(lang, '后台生成中', 'Preparing…')} active={isActive} /> : null}
                </Box>
                <Text color={theme.text}>{`${t(lang, '已备好变式题', 'Ready variants')}: ${coachStatus?.ready ?? 0}`}</Text>
                <Text color={theme.muted}>{`${t(lang, '授权状态', 'Consent')}: ${coachStatus?.consent ? t(lang, '已授权', 'Granted') : t(lang, '首次生成时确认', 'Prompt on first queue')}`}</Text>
                <Divider width={Math.max(8, sz.width - 4)} />
                <Text color={theme.heading} bold>{t(lang, '最近任务', 'Recent Tasks')}</Text>
                {(coachStatus?.tasks ?? []).length === 0 ? (
                  <Text color={theme.dim}>{t(lang, '暂无记录 — 按 g 为选中错题生成变式，按 p 开始教练练习。', 'Press g to queue variant, p to start coach practice.')}</Text>
                ) : (
                  (coachStatus?.tasks ?? []).slice(0, Math.max(1, sz.height - 10)).map((tk) => (
                    <Text key={tk.id} color={tk.status === 'failed' ? theme.error : tk.status === 'done' ? theme.success : theme.muted}>
                      {truncateDisplay(`${asciiMode ? '*' : '•'} [${tk.status}] ${tk.label || tk.kind || tk.id} ${tk.message || ''}`, Math.max(8, sz.width - 4), asciiMode ? '...' : '…')}
                    </Text>
                  ))
                )}
              </Box>
            </Panel>
          )}
        />
      ) : tab === 'evidence' ? (
        <SplitPane
          width={width}
          height={bodyH}
          leftWidth={0.52}
          activePane={focusPane}
          leftLabel={t(lang, '考点能力证据', 'Point Evidence')}
          rightLabel={t(lang, '三层能力核对', '3-Layer Evidence')}
          left={(sz) => (
            <Panel
              title={t(lang, '考点证据清单', 'Course Point Evidence')}
              badge={courseEvidence?.summary?.total ?? 0}
              subtitle={t(lang, 'p 练习考点', 'p:Practice')}
              focused={focusPane === 'left'}
              width={sz.width}
              height={sz.height}
              paddingX={0}
            >
              <VirtualList
                items={evidencePoints}
                width={Math.max(10, sz.width - 2)}
                height={Math.max(3, sz.height - 2)}
                selectedIndex={pointIdx}
                onChange={setPointIdx}
                isActive={isActive && !modalOpen && focusPane === 'left'}
                emptyText={t(lang, '当前课程暂无考点证据数据', 'No point evidence yet')}
                renderItem={(pt, ctx) => {
                  const badge = `[${overallLabel(pt.overall, lang)}]`;
                  const metaW = displayWidth(badge) + 1;
                  const titleW = Math.max(6, ctx.width - metaW);
                  return (
                    <Text color={ctx.selected ? theme.selectionFg : overallTone(pt.overall) === 'success' ? theme.success : overallTone(pt.overall) === 'error' ? theme.error : theme.text}>
                      {`${padDisplay(truncateDisplay(pt.title, titleW, asciiMode ? '...' : '…'), titleW)} ${badge}`}
                    </Text>
                  );
                }}
              />
            </Panel>
          )}
          right={(sz) => {
            const ce = coachEvidence;
            const summary = courseEvidence?.summary;
            return (
              <Panel
                title={t(lang, '三层能力证据与缺口', '3-Layer Capability Evidence')}
                focused={focusPane === 'right'}
                width={sz.width}
                height={sz.height}
              >
                <Box flexDirection="column">
                  {summary ? (
                    <Box gap={1} marginBottom={1}>
                      <Badge label={`${t(lang, '稳固', 'Solid')} ${summary.solid}`} tone="success" variant="soft" />
                      <Badge label={`${t(lang, '巩固', 'Prog')} ${summary.in_progress}`} tone="warning" variant="soft" />
                      <Badge label={`${t(lang, '薄弱', 'Shaky')} ${summary.shaky}`} tone="error" variant="soft" />
                      <Badge label={`${t(lang, '未学', 'New')} ${summary.unstarted}`} tone="muted" variant="soft" />
                    </Box>
                  ) : null}
                  {ce ? (
                    <>
                      <Text color={ce.capabilityEvidence.readyForExam ? theme.success : theme.warning} bold>
                        {truncateDisplay(ce.capabilityEvidence.verdict, Math.max(10, sz.width - 4), asciiMode ? '...' : '…')}
                      </Text>
                      <Box marginY={1} flexDirection="column">
                        <ProgressBar
                          ratio={ce.materialCoverage.ratio}
                          width={Math.max(12, sz.width - 4)}
                          label={t(lang, '资料覆盖', 'Materials')}
                        />
                        <Text color={theme.muted}>
                          {`${t(lang, '章节', 'Sections')}: ${ce.materialCoverage.coveredSections}/${ce.materialCoverage.totalSections}  |  ${t(lang, '纯记忆卡', 'Recall')}: ${ce.materialCoverage.recallOnlyCardCount}`}
                        </Text>
                        <Text color={theme.muted}>
                          {`${t(lang, '训练覆盖', 'Training')}: ${t(lang, '计划', 'Plan')} ${ce.trainingCoverage.planned} / ${t(lang, '可用', 'Usable')} ${ce.trainingCoverage.verifiedUsable} / ${t(lang, '已练', 'Done')} ${ce.trainingCoverage.practiced}`}
                        </Text>
                        <Text color={theme.text}>
                          {`${t(lang, '未见独立通过', 'Unseen pass')}: ${ce.capabilityEvidence.unseenIndependentPassCount}  |  ${t(lang, '隔日>=12h', '>=12h')}: ${ce.capabilityEvidence.delayedIndependent.passedFamilyCount}/${ce.capabilityEvidence.delayedIndependent.totalActiveFamilyCount}  |  ${t(lang, '限时达标', 'Timed')}: ${ce.capabilityEvidence.timedIndependent.passedCount}`}
                        </Text>
                      </Box>
                    </>
                  ) : null}
                  {selectedPoint ? (
                    <>
                      <Divider width={Math.max(8, sz.width - 4)} />
                      <Text color={theme.heading} bold>{truncateDisplay(selectedPoint.title, Math.max(10, sz.width - 4), asciiMode ? '...' : '…')}</Text>
                      <Text color={theme.muted}>
                        {`${t(lang, '保持', 'Retention')}: ${selectedPoint.retention || '-'}  |  ${t(lang, '理解', 'Comprehension')}: ${selectedPoint.comprehension || '-'}  |  ${t(lang, '迁移', 'Transfer')}: ${selectedPoint.transfer || '-'}`}
                      </Text>
                      {selectedPoint.gapHint ? (
                        <Text color={theme.warning}>{truncateDisplay(`! ${selectedPoint.gapHint}`, Math.max(10, sz.width - 4), asciiMode ? '...' : '…')}</Text>
                      ) : null}
                    </>
                  ) : null}
                </Box>
              </Panel>
            );
          }}
        />
      ) : (
        /* Tab 4: Mock Check & Build */
        <Box flexDirection="column" width={width} height={bodyH} padding={1} gap={1}>
          <Panel
            title={t(lang, '按校准配置编译出题与严格同型组卷检查', 'Compiled Calibration & Strict Mock Check')}
            subtitle={t(lang, 'b编译预览 m同型检查 g启动出题', 'b:Preview m:MockCheck g:Generate')}
            focused
            width={width - 2}
            height={Math.max(6, bodyH - 2)}
          >
            <Box flexDirection="column" gap={1}>
              <Text color={theme.muted}>
                {t(
                  lang,
                  '将当前校准的任务族配额编译为可追溯出题请求，并核对题库能否在不凑数的前提下组成同型模拟卷。',
                  'Compile calibrated family quotas into a traceable generation request and check strict mock paper coverage.',
                )}
              </Text>
              {compiledPreview ? (
                <Box flexDirection="column" borderStyle={asciiMode ? 'classic' : 'single'} borderColor={theme.border} paddingX={1}>
                  <Text color={theme.success} bold>
                    {`${t(lang, '编译预览', 'Compiled Preview')} (v${compiledPreview.coachSpecVersion ?? 1}): ${compiledPreview.totalCount} ${t(lang, '题', 'questions')}`}
                  </Text>
                  <Text color={theme.text}>
                    {Object.entries(compiledPreview.kindCounts || {})
                      .map(([k, n]) => `${formatKindLabel(k, lang)}:${n}`)
                      .join('  ') || t(lang, '0 题', '0 questions')}
                  </Text>
                  {compiledPreview.uncalibratedFamilies?.length ? (
                    <Text color={theme.warning}>
                      {t(lang, `提示：仍有 ${compiledPreview.uncalibratedFamilies.length} 项任务族未完成三项确认`, `Note: ${compiledPreview.uncalibratedFamilies.length} families not fully calibrated`)}
                    </Text>
                  ) : null}
                </Box>
              ) : null}
              {mockReport ? (
                <Box flexDirection="column" borderStyle={asciiMode ? 'classic' : 'single'} borderColor={mockReport.complete ? theme.success : theme.warning} paddingX={1}>
                  <Text color={mockReport.complete ? theme.success : theme.warning} bold>
                    {mockReport.complete
                      ? asciiMode
                        ? t(lang, '+ 可完整组成严格同型模拟卷', '+ Ready to compose full strict mock paper')
                        : t(lang, '✓ 可完整组成严格同型模拟卷', '✓ Ready to compose full strict mock paper')
                      : asciiMode
                        ? t(lang, `! 存在 ${mockReport.shortfalls?.length ?? 0} 处结构缺口`, `! ${mockReport.shortfalls?.length ?? 0} structural shortfall(s)`)
                        : t(lang, `⚠ 存在 ${mockReport.shortfalls?.length ?? 0} 处结构缺口`, `⚠ ${mockReport.shortfalls?.length ?? 0} structural shortfall(s)`)}
                    {`  (${mockReport.totalMarks}/${mockReport.targetMarks} ${t(lang, '分', 'pts')})`}
                  </Text>
                  {(mockReport.shortfalls ?? []).slice(0, 4).map((sf) => (
                    <Text key={sf.sectionId} color={theme.muted}>
                      {truncateDisplay(`${asciiMode ? '-' : '•'} ${sf.title}: ${sf.fulfilled}/${sf.requested} (${sf.reason})`, Math.max(12, width - 10), asciiMode ? '...' : '…')}
                    </Text>
                  ))}
                </Box>
              ) : null}
            </Box>
          </Panel>
        </Box>
      )}

      {/* Modal: Submit past-paper / exam-style notes */}
      {noteModalOpen ? (
        <Modal
          title={t(lang, '提交往年样卷 / 考法笔记', 'Submit Past-Paper / Exam-Style Notes')}
          subtitle={t(lang, 'Tab 切换字段 · Ctrl+S 保存', 'Tab: Switch - Ctrl+S: Save')}
          width={Math.min(76, width - 4)}
          onClose={() => setNoteModalOpen(false)}
          isActive={isActive}
          hints={[
            { key: 'Tab', label: t(lang, '切换输入框', 'Switch field') },
            { key: 'Ctrl+S', label: t(lang, '保存笔记', 'Save Note') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Box flexDirection="column" gap={1}>
            <Text color={noteField === 'title' ? theme.primary : theme.muted} bold>
              {t(lang, '笔记标题（可选）：', 'Title (optional):')}
            </Text>
            <TextInput
              value={noteTitle}
              onChange={setNoteTitle}
              placeholder={t(lang, '例如：2024 期末真题题型与考法说明', 'e.g. 2024 Final Exam Format Notes')}
              isActive={isActive && noteModalOpen && noteField === 'title'}
              width={modalContentWidth(Math.min(76, width - 4))}
              onCancel={() => setNoteModalOpen(false)}
              onSubmit={() => setNoteField('text')}
            />
            <Text color={noteField === 'text' ? theme.primary : theme.muted} bold>
              {t(lang, '样卷 / 考法说明内容：', 'Past-paper / exam-style notes:')}
            </Text>
            <TextInput
              value={noteText}
              onChange={setNoteText}
              multiline
              height={6}
              placeholder={t(lang, '粘贴老师划的题型分布、样卷例题或评分要点…', 'Paste exam format, sample questions, or grading notes...')}
              isActive={isActive && noteModalOpen && noteField === 'text'}
              width={modalContentWidth(Math.min(76, width - 4))}
              onCancel={() => setNoteModalOpen(false)}
              onSubmit={() => void saveCoachNote()}
            />
          </Box>
        </Modal>
      ) : null}

      {/* Modal: Edit selected family quota / priority / timeBudget */}
      {editModalOpen && selectedFamily ? (
        <Modal
          title={t(lang, '调整任务族训练配置', 'Edit Task Family Config')}
          subtitle={truncateDisplay(selectedFamily.title, 30, asciiMode ? '...' : '…')}
          width={Math.min(62, width - 4)}
          onClose={() => setEditModalOpen(false)}
          isActive={isActive}
          hints={[
            { key: 'Tab', label: t(lang, '下一项', 'Next') },
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Box flexDirection="column" gap={1}>
            <Text color={editField === 'quota' ? theme.primary : theme.muted} bold>
              {t(lang, '本轮配额（0-50）：', 'Quota (0-50):')}
            </Text>
            <TextInput
              value={editQuota}
              onChange={setEditQuota}
              isActive={isActive && editModalOpen && editField === 'quota'}
              width={modalContentWidth(Math.min(62, width - 4))}
              onCancel={() => setEditModalOpen(false)}
              onSubmit={() => void saveFamilyEdits()}
            />
            <Text color={editField === 'priority' ? theme.primary : theme.muted} bold>
              {asciiMode
                ? t(lang, '优先级（Left/Right/空格切换）：', 'Priority (Left/Right/Space):')
                : t(lang, '优先级（←/→/空格切换）：', 'Priority (Left/Right/Space):')}
            </Text>
            <Box gap={1}>
              {(['high', 'medium', 'deferred'] as const).map((p) => (
                <Badge key={p} label={priorityLabel(p, lang)} tone={editPriority === p ? 'primary' : 'muted'} variant={editPriority === p ? 'solid' : 'outline'} />
              ))}
            </Box>
            <Text color={editField === 'time' ? theme.primary : theme.muted} bold>
              {t(lang, '单题目标限时（秒）：', 'Time budget per item (sec):')}
            </Text>
            <TextInput
              value={editTimeSec}
              onChange={setEditTimeSec}
              isActive={isActive && editModalOpen && editField === 'time'}
              width={modalContentWidth(Math.min(62, width - 4))}
              onCancel={() => setEditModalOpen(false)}
              onSubmit={() => void saveFamilyEdits()}
            />
          </Box>
        </Modal>
      ) : null}

      {/* Confirm Dialog for AI Exam Analysis ([A]) */}
      {confirmAiAnalyze ? (
        <ConfirmDialog
          title={t(lang, '确认 AI 深化分析考法', 'Confirm AI Exam Analysis')}
          message={t(
            lang,
            `即将为「${course || '全部课程'}」调用 AI 模型（${model.provider}${model.model ? `/${model.model}` : ''}）重新分析课程资料与样卷（预计发起 1 次 AI 模型分析）。确认继续吗？`,
            `Will invoke AI model (${model.provider}${model.model ? `/${model.model}` : ''}) to re-analyze exam materials for "${course || 'All Courses'}" (~1 AI analysis call). Continue?`,
          )}
          confirmLabel={t(lang, '开始分析', 'Analyze')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onConfirm={() => {
            setConfirmAiAnalyze(false);
            void runAnalyze(true);
          }}
          onCancel={() => setConfirmAiAnalyze(false)}
        />
      ) : null}

      {/* Confirm Dialog for Calibrated Generation ([g] on Mock tab) */}
      {confirmGenerate ? (
        <ConfirmDialog
          title={t(lang, '确认按校准方案出题', 'Confirm Calibrated Generation')}
          message={(() => {
            const kindSummary = Object.entries(confirmGenerate.kindCounts || {})
              .map(([k, n]) => `${formatKindLabel(k, lang)}:${n}`)
              .join('  ');
            return t(
              lang,
              `将为「${course || '全部课程'}」按校准配额生成共 ${confirmGenerate.totalCount} 题${kindSummary ? `（${kindSummary}）` : ''}，预计发起 1 次后台 AI 出题任务。确认继续吗？`,
              `Generate ${confirmGenerate.totalCount} calibrated question(s) for "${course || 'All Courses'}"${kindSummary ? ` (${kindSummary})` : ''} (~1 AI generation job). Continue?`,
            );
          })()}
          confirmLabel={t(lang, '开始出题', 'Generate')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onConfirm={() => {
            const built = confirmGenerate;
            setConfirmGenerate(null);
            void executeCalibratedGenerate(built);
          }}
          onCancel={() => setConfirmGenerate(null)}
        />
      ) : null}

      {/* Consent Dialog for Variant Generation */}
      {consentPromptCards ? (
        <ConfirmDialog
          title={t(lang, '授权后台生成变式题', 'Authorize Variant Generation')}
          message={t(
            lang,
            '首次生成错题变式需要你的确认，后续可在设置中调整。是否同意为所选错题生成举一反三变式？',
            'Consent is required once to generate background variants for weak questions. Proceed?',
          )}
          confirmLabel={t(lang, '同意并生成', 'Agree & Queue')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onConfirm={() => {
            const cards = consentPromptCards;
            setConsentPromptCards(null);
            void queueVariants(cards, true);
          }}
          onCancel={() => setConsentPromptCards(null)}
        />
      ) : null}

      {/* Modal: Learner Profile & Study Preferences */}
      <Suspense fallback={null}>
        {prefsModalOpen ? (
          <CoachPreferencesModal
            host={host}
            isActive={isActive && prefsModalOpen}
            width={width}
            height={height}
            onClose={() => setPrefsModalOpen(false)}
          />
        ) : null}
      </Suspense>
    </Box>
  );
};
