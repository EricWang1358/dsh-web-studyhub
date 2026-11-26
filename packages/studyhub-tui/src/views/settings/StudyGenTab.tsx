import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import type { HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction } from '../../host/sample-actions.js';
import { useShellActions } from '../../shell/actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Panel } from '../../components/Panel.js';
import {
  nextScrollOffset,
  pageStep,
  parseSgrWheelDelta,
  scrollbarThumb,
  useSgrMouseWheel,
} from '../../components/VirtualList.js';
import { padDisplay, truncateDisplay } from '../../render/cjk.js';

export interface StudyGenTabProps {
  host: HostClient;
  width: number;
  height: number;
  isActive: boolean;
}

interface PracticeSettingsShape {
  autopilot: boolean;
  roundSize: number;
  newCardOrder: 'reading' | 'focus' | 'shuffle';
  debrief: boolean;
  rereadMarks: boolean;
}

interface GenerationSettingsShape {
  kind: string;
  count: number;
  difficulty: 'mixed' | 'foundation' | 'application' | 'advanced';
  coverageLevel: 'lean' | 'standard' | 'full';
  language: 'auto' | '中文' | 'English' | '中英双语';
}

interface DailyRecapSettingsShape {
  automatic: boolean;
  tone: 'friendly' | 'professional';
  timeZone: string;
}

interface BookSettingsShape {
  qaToBook: 'manual' | 'auto';
  pageLimit?: number;
  crunchWindowDays?: number;
  crunchMinutes?: number;
  coverage?: 'brief' | 'standard' | 'full';
  inlinePractice?: boolean;
  confusableDrill?: boolean;
}

interface ExamPrepSettingsShape {
  autoRoles: boolean;
  paperWords: string[];
  language: 'auto' | 'zh' | 'en';
  showOtherCourses: boolean;
  enabled: boolean;
}

interface FullSettingsShape {
  request_retention: number;
  maximum_interval: number;
  practice?: Partial<PracticeSettingsShape>;
  book?: Partial<BookSettingsShape>;
  examPrep?: Partial<ExamPrepSettingsShape>;
  generation?: Partial<GenerationSettingsShape>;
  dailyRecap?: Partial<DailyRecapSettingsShape>;
}

const NEW_CARD_ORDERS = ['reading', 'focus', 'shuffle'] as const;
const RETENTIONS = [0.8, 0.85, 0.9, 0.92, 0.95] as const;
const MAX_INTERVALS = [180, 365, 3650, 36500] as const;
const GEN_KINDS = ['quiz', 'multi', 'flashcard', 'mixed'] as const;
const GEN_DIFFICULTIES = ['mixed', 'foundation', 'application', 'advanced'] as const;
const GEN_COVERAGES = ['lean', 'standard', 'full'] as const;
const GEN_LANGS = ['auto', '中文', 'English', '中英双语'] as const;
const BOOK_COVERAGES = ['brief', 'standard', 'full'] as const;

type SettingRowId =
  | 'roundSize'
  | 'newCardOrder'
  | 'autopilot'
  | 'debrief'
  | 'rereadMarks'
  | 'book_qaToBook'
  | 'practice_reset'
  | 'examprep_reset'
  | 'request_retention'
  | 'maximum_interval'
  | 'gen_kind'
  | 'gen_count'
  | 'gen_difficulty'
  | 'gen_coverageLevel'
  | 'gen_language'
  | 'recap_automatic'
  | 'recap_tone'
  | 'book_coverage'
  | 'book_inlinePractice'
  | 'book_confusableDrill'
  | 'examprep_autoRoles'
  | 'examprep_showOtherCourses';

const ROW_IDS: readonly SettingRowId[] = Object.freeze([
  'roundSize',
  'newCardOrder',
  'autopilot',
  'debrief',
  'rereadMarks',
  'book_qaToBook',
  'practice_reset',
  'examprep_reset',
  'request_retention',
  'maximum_interval',
  'gen_kind',
  'gen_count',
  'gen_difficulty',
  'gen_coverageLevel',
  'gen_language',
  'recap_automatic',
  'recap_tone',
  'book_coverage',
  'book_inlinePractice',
  'book_confusableDrill',
  'examprep_autoRoles',
  'examprep_showOtherCourses',
]);

function cycleOf<T>(arr: readonly T[], current: T, dir: 1 | -1): T {
  const idx = arr.indexOf(current);
  const start = idx >= 0 ? idx : 0;
  return arr[(start + dir + arr.length) % arr.length];
}

export const StudyGenTab: React.FC<StudyGenTabProps> = memo(function StudyGenTab({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const [settings, setSettings] = useState<FullSettingsShape | null>(
    () => (snapshot?.settings as FullSettingsShape | undefined) ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [confirmResetPractice, setConfirmResetPractice] = useState(false);
  const [confirmResetExamPrep, setConfirmResetExamPrep] = useState(false);

  const mountedRef = useRef(true);
  const scrollOffsetRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    const res = await tryAction<FullSettingsShape>(host, 'settings', {});
    if (!mountedRef.current) return;
    setLoading(false);
    if (res.ok && res.value) setSettings(res.value);
  }, [host]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const practice: PracticeSettingsShape = useMemo(
    () => ({
      autopilot: Boolean(settings?.practice?.autopilot),
      roundSize: Number(settings?.practice?.roundSize ?? 20) || 20,
      newCardOrder: (settings?.practice?.newCardOrder as PracticeSettingsShape['newCardOrder']) ?? 'reading',
      debrief: settings?.practice?.debrief !== false,
      rereadMarks: settings?.practice?.rereadMarks !== false,
    }),
    [settings?.practice],
  );
  const generation: GenerationSettingsShape = useMemo(
    () => ({
      kind: String(settings?.generation?.kind ?? 'quiz'),
      count: Number(settings?.generation?.count ?? 10) || 10,
      difficulty: (settings?.generation?.difficulty as GenerationSettingsShape['difficulty']) ?? 'mixed',
      coverageLevel: (settings?.generation?.coverageLevel as GenerationSettingsShape['coverageLevel']) ?? 'standard',
      language: (settings?.generation?.language as GenerationSettingsShape['language']) ?? 'auto',
    }),
    [settings?.generation],
  );
  const dailyRecap: DailyRecapSettingsShape = useMemo(
    () => ({
      automatic: Boolean(settings?.dailyRecap?.automatic),
      tone: (settings?.dailyRecap?.tone as DailyRecapSettingsShape['tone']) ?? 'friendly',
      timeZone: String(settings?.dailyRecap?.timeZone ?? 'Asia/Shanghai'),
    }),
    [settings?.dailyRecap],
  );
  const bookSrc = settings?.book ?? (snapshot?.settings as FullSettingsShape | undefined)?.book;
  const bookQaToBook: 'manual' | 'auto' = bookSrc?.qaToBook === 'auto' ? 'auto' : 'manual';
  const bookCoverage: 'brief' | 'standard' | 'full' = BOOK_COVERAGES.includes(
    bookSrc?.coverage as (typeof BOOK_COVERAGES)[number],
  )
    ? (bookSrc?.coverage as (typeof BOOK_COVERAGES)[number])
    : 'standard';
  const bookInlinePractice = bookSrc?.inlinePractice === true;
  const bookConfusableDrill = bookSrc?.confusableDrill === true;
  const examPrepSrc = settings?.examPrep ?? (snapshot?.settings as FullSettingsShape | undefined)?.examPrep;
  const examPrepAutoRoles = examPrepSrc?.autoRoles !== false;
  const examPrepShowOtherCourses = examPrepSrc?.showOtherCourses === true;
  const retention = Number(settings?.request_retention ?? 0.9) || 0.9;
  const maxInterval = Number(settings?.maximum_interval ?? 36500) || 36500;

  const savePracticePatch = useCallback(
    async (patch: Partial<PracticeSettingsShape>) => {
      setSaving(true);
      const res = await tryAction<PracticeSettingsShape>(host, 'settings.practice.set', { patch });
      if (!mountedRef.current) return;
      setSaving(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存练习设置失败', 'Failed to save practice settings'), 'error');
        return;
      }
      setSettings((prev) => ({ ...(prev ?? { request_retention: 0.9, maximum_interval: 36500 }), practice: res.value }));
      void refreshSnapshot();
    },
    [host, lang, notify, refreshSnapshot],
  );

  const saveBookPatch = useCallback(
    async (patch: Partial<BookSettingsShape>) => {
      setSaving(true);
      const res = await tryAction<BookSettingsShape>(host, 'settings.book.set', { patch });
      if (!mountedRef.current) return;
      setSaving(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存复习全书设置失败', 'Failed to save review book settings'), 'error');
        return;
      }
      setSettings((prev) => ({ ...(prev ?? { request_retention: 0.9, maximum_interval: 36500 }), book: res.value }));
      void refreshSnapshot();
    },
    [host, lang, notify, refreshSnapshot],
  );

  const saveExamPrepPatch = useCallback(
    async (patch: Partial<ExamPrepSettingsShape>) => {
      setSaving(true);
      const res = await tryAction<ExamPrepSettingsShape>(host, 'settings.examPrep.set', { patch });
      if (!mountedRef.current) return;
      setSaving(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存备考补习设置失败', 'Failed to save ExamPrep settings'), 'error');
        return;
      }
      setSettings((prev) => ({ ...(prev ?? { request_retention: 0.9, maximum_interval: 36500 }), examPrep: res.value }));
      void refreshSnapshot();
    },
    [host, lang, notify, refreshSnapshot],
  );

  const handleResetPractice = useCallback(async () => {
    setConfirmResetPractice(false);
    setSaving(true);
    const res = await tryAction<PracticeSettingsShape>(host, 'settings.practice.reset', {});
    if (!mountedRef.current) return;
    setSaving(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '恢复练习默认设置失败', 'Failed to reset practice defaults'), 'error');
      return;
    }
    setSettings((prev) => ({ ...(prev ?? { request_retention: 0.9, maximum_interval: 36500 }), practice: res.value }));
    void refreshSnapshot();
    notify(t(lang, '已恢复练习默认设置（修题短语已保留）', 'Practice defaults reset (saved fixPhrases kept)'), 'success');
  }, [host, lang, notify, refreshSnapshot]);

  const handleResetExamPrep = useCallback(async () => {
    setConfirmResetExamPrep(false);
    setSaving(true);
    const res = await tryAction<ExamPrepSettingsShape>(host, 'settings.examPrep.reset', {});
    if (!mountedRef.current) return;
    setSaving(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '恢复备考补习默认设置失败', 'Failed to reset ExamPrep defaults'), 'error');
      return;
    }
    setSettings((prev) => ({ ...(prev ?? { request_retention: 0.9, maximum_interval: 36500 }), examPrep: res.value }));
    void refreshSnapshot();
    notify(
      t(lang, '已恢复备考补习默认设置（页面开关已保留）', 'ExamPrep defaults reset (page switch kept)'),
      'success',
    );
  }, [host, lang, notify, refreshSnapshot]);

  const saveGeneralPatch = useCallback(
    async (patch: Record<string, unknown>) => {
      setSaving(true);
      const res = await tryAction<FullSettingsShape>(host, 'settings', patch);
      if (!mountedRef.current) return;
      setSaving(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存设置失败', 'Failed to save settings'), 'error');
        return;
      }
      if (res.value) setSettings(res.value);
      void refreshSnapshot();
    },
    [host, lang, notify, refreshSnapshot],
  );

  const adjustRow = useCallback(
    (rowId: SettingRowId, dir: 1 | -1) => {
      switch (rowId) {
        case 'roundSize': {
          const next = Math.max(5, Math.min(50, practice.roundSize + dir * 5));
          if (next !== practice.roundSize) void savePracticePatch({ roundSize: next });
          return;
        }
        case 'newCardOrder':
          void savePracticePatch({ newCardOrder: cycleOf(NEW_CARD_ORDERS, practice.newCardOrder, dir) });
          return;
        case 'autopilot':
          void savePracticePatch({ autopilot: !practice.autopilot });
          return;
        case 'debrief':
          void savePracticePatch({ debrief: !practice.debrief });
          return;
        case 'rereadMarks':
          void savePracticePatch({ rereadMarks: !practice.rereadMarks });
          return;
        case 'book_qaToBook':
          void saveBookPatch({ qaToBook: bookQaToBook === 'auto' ? 'manual' : 'auto' });
          return;
        case 'practice_reset':
          if (dir === 1) setConfirmResetPractice(true);
          return;
        case 'examprep_reset':
          if (dir === 1) setConfirmResetExamPrep(true);
          return;
        case 'request_retention': {
          const nearest = RETENTIONS.reduce((best, r) => (Math.abs(r - retention) < Math.abs(best - retention) ? r : best), RETENTIONS[2]);
          void saveGeneralPatch({ request_retention: cycleOf(RETENTIONS, nearest, dir) });
          return;
        }
        case 'maximum_interval': {
          const nearest = MAX_INTERVALS.reduce((best, r) => (Math.abs(r - maxInterval) < Math.abs(best - maxInterval) ? r : best), MAX_INTERVALS[3]);
          void saveGeneralPatch({ maximum_interval: cycleOf(MAX_INTERVALS, nearest, dir) });
          return;
        }
        case 'gen_kind': {
          const cur = (GEN_KINDS.includes(generation.kind as never) ? generation.kind : 'quiz') as (typeof GEN_KINDS)[number];
          void saveGeneralPatch({ generation: { kind: cycleOf(GEN_KINDS, cur, dir) } });
          return;
        }
        case 'gen_count': {
          const next = Math.max(5, Math.min(30, generation.count + dir * 5));
          if (next !== generation.count) void saveGeneralPatch({ generation: { count: next } });
          return;
        }
        case 'gen_difficulty':
          void saveGeneralPatch({ generation: { difficulty: cycleOf(GEN_DIFFICULTIES, generation.difficulty, dir) } });
          return;
        case 'gen_coverageLevel':
          void saveGeneralPatch({ generation: { coverageLevel: cycleOf(GEN_COVERAGES, generation.coverageLevel, dir) } });
          return;
        case 'gen_language':
          void saveGeneralPatch({ generation: { language: cycleOf(GEN_LANGS, generation.language, dir) } });
          return;
        case 'recap_automatic':
          void saveGeneralPatch({ dailyRecap: { automatic: !dailyRecap.automatic } });
          return;
        case 'recap_tone':
          void saveGeneralPatch({ dailyRecap: { tone: dailyRecap.tone === 'friendly' ? 'professional' : 'friendly' } });
          return;
        case 'book_coverage':
          void saveBookPatch({ coverage: cycleOf(BOOK_COVERAGES, bookCoverage, dir) });
          return;
        case 'book_inlinePractice':
          void saveBookPatch({ inlinePractice: !bookInlinePractice });
          return;
        case 'book_confusableDrill':
          void saveBookPatch({ confusableDrill: !bookConfusableDrill });
          return;
        case 'examprep_autoRoles':
          void saveExamPrepPatch({ autoRoles: !examPrepAutoRoles });
          return;
        case 'examprep_showOtherCourses':
          void saveExamPrepPatch({ showOtherCourses: !examPrepShowOtherCourses });
          return;
      }
    },
    [
      bookConfusableDrill,
      bookCoverage,
      bookInlinePractice,
      bookQaToBook,
      dailyRecap,
      examPrepAutoRoles,
      examPrepShowOtherCourses,
      generation,
      maxInterval,
      practice,
      retention,
      saveBookPatch,
      saveExamPrepPatch,
      saveGeneralPatch,
      savePracticePatch,
    ],
  );

  const maxVisible = Math.max(4, height - 4);
  const dialogOpen = confirmResetPractice || confirmResetExamPrep;
  const claimed = useMemo(() => ['j', 'k', 'h', 'l', ' ', 'g', 'G'], []);

  useSgrMouseWheel(isActive && !dialogOpen, (wheelDelta) => {
    setCursor((c) => Math.max(0, Math.min(ROW_IDS.length - 1, c + wheelDelta)));
  });

  useKeyScope({
    id: 'settings:study-gen',
    active: isActive && !dialogOpen,
    keys: claimed,
    onKey: (input, key) => {
      const wheelDelta = parseSgrWheelDelta(input);
      if (wheelDelta !== 0) {
        setCursor((c) => Math.max(0, Math.min(ROW_IDS.length - 1, c + wheelDelta)));
        return true;
      }
      if (key.ctrl && !key.meta && input === 'r') {
        void loadSettings();
        return false;
      }
      const plain = isPlainKey(input, key);
      if (key.upArrow || (plain && input === 'k')) {
        setCursor((c) => (c - 1 + ROW_IDS.length) % ROW_IDS.length);
        return true;
      }
      if (key.downArrow || (plain && input === 'j')) {
        setCursor((c) => (c + 1) % ROW_IDS.length);
        return true;
      }
      if (key.pageDown || (key.ctrl && !key.meta && input === 'f')) {
        setCursor((c) => Math.min(ROW_IDS.length - 1, c + pageStep(maxVisible, 'full')));
        return true;
      }
      if (key.pageUp || (key.ctrl && !key.meta && input === 'b')) {
        setCursor((c) => Math.max(0, c - pageStep(maxVisible, 'full')));
        return true;
      }
      if (key.ctrl && !key.meta && input === 'd') {
        setCursor((c) => Math.min(ROW_IDS.length - 1, c + pageStep(maxVisible, 'half')));
        return true;
      }
      if (key.ctrl && !key.meta && input === 'u') {
        setCursor((c) => Math.max(0, c - pageStep(maxVisible, 'half')));
        return true;
      }
      if (key.home || (plain && input === 'g')) {
        setCursor(0);
        return true;
      }
      if (key.end || (plain && input === 'G')) {
        setCursor(ROW_IDS.length - 1);
        return true;
      }
      if (key.leftArrow || (plain && input === 'h')) {
        adjustRow(ROW_IDS[cursor], -1);
        return true;
      }
      if (key.rightArrow || (!key.ctrl && !key.meta && key.return) || (plain && (input === 'l' || input === ' '))) {
        adjustRow(ROW_IDS[cursor], 1);
        return true;
      }
      return false;
    },
  });

  const onOff = (v: boolean) => (v ? (asciiMode ? t(lang, '开启 +', 'On +') : t(lang, '开启 ✓', 'On ✓')) : t(lang, '关闭', 'Off'));
  const orderLabel = (v: PracticeSettingsShape['newCardOrder']) =>
    v === 'reading' ? t(lang, '按讲义顺序', 'Reading order') : v === 'focus' ? t(lang, '考纲优先', 'Focus first') : t(lang, '随机穿插', 'Shuffle');

  const arrowHint = asciiMode ? 'Left/Right' : '←/→';
  const rows: Array<{ id: SettingRowId; group: string; label: string; value: string; hint: string; isAction?: boolean }> = [
    { id: 'roundSize', group: t(lang, '复习', 'Review'), label: t(lang, '每轮题数 / 每日目标', 'Round Size / Daily Goal'), value: `${practice.roundSize} ${t(lang, '题', 'cards')}`, hint: `5–50 (${arrowHint} ±5)` },
    { id: 'newCardOrder', group: t(lang, '复习', 'Review'), label: t(lang, '新题出场顺序', 'New Card Order'), value: orderLabel(practice.newCardOrder), hint: 'reading / focus / shuffle' },
    { id: 'autopilot', group: t(lang, '复习', 'Review'), label: t(lang, '答对自动下一题', 'Autopilot Advance'), value: onOff(practice.autopilot), hint: t(lang, '答对后自动倒计时切题', 'Auto-advance on pass') },
    { id: 'debrief', group: t(lang, '复习', 'Review'), label: t(lang, '本轮 AI 点评', 'Round AI Debrief'), value: onOff(practice.debrief), hint: t(lang, '结轮后生成轻量点评', 'Brief summary after round') },
    { id: 'rereadMarks', group: t(lang, '复习', 'Review'), label: t(lang, '薄弱段重读提示', 'Reread Marks'), value: onOff(practice.rereadMarks), hint: t(lang, '在学习库提示薄弱讲义段落', 'Highlight weak source sections') },
    {
      id: 'book_qaToBook',
      group: t(lang, '全书', 'Book'),
      label: t(lang, '追问自动加入全书', 'Auto-add Q&A to Book'),
      value: bookQaToBook === 'auto' ? (asciiMode ? t(lang, '自动 +', 'Auto +') : t(lang, '自动 ✓', 'Auto ✓')) : t(lang, '手动', 'Manual'),
      hint: t(lang, '练习追问/弄懂自动写入全书', 'Auto-add practice Q&A to book'),
    },
    {
      id: 'practice_reset',
      group: t(lang, '复习', 'Review'),
      label: t(lang, '恢复练习默认设置', 'Reset Practice Defaults'),
      value: t(lang, '恢复默认', 'Reset'),
      hint: t(lang, '重置练习默认值，保留 fixPhrases', 'Resets defaults, keeps fixPhrases'),
      isAction: true,
    },
    {
      id: 'examprep_reset',
      group: t(lang, '备考', 'Exam'),
      label: t(lang, '恢复备考补习默认设置', 'Reset ExamPrep Defaults'),
      value: t(lang, '恢复默认', 'Reset'),
      hint: t(lang, '重置个人默认，保留页面开关', 'Resets defaults, keeps switch'),
      isAction: true,
    },
    { id: 'request_retention', group: 'FSRS-6', label: t(lang, '目标记忆保留率', 'Target Retention'), value: `${Math.round(retention * 100)}%`, hint: '80%–95%' },
    { id: 'maximum_interval', group: 'FSRS-6', label: t(lang, '最大复习间隔', 'Max Interval'), value: `${maxInterval} ${t(lang, '天', 'days')}`, hint: '180 / 365 / 3650 / 36500' },
    { id: 'gen_kind', group: t(lang, '出题', 'Gen'), label: t(lang, '默认题型', 'Default Kind'), value: generation.kind, hint: 'quiz / multi / flashcard / mixed' },
    { id: 'gen_count', group: t(lang, '出题', 'Gen'), label: t(lang, '默认生成题量', 'Default Count'), value: `${generation.count}`, hint: `5–30 (${arrowHint} ±5)` },
    { id: 'gen_difficulty', group: t(lang, '出题', 'Gen'), label: t(lang, '默认难度', 'Difficulty'), value: generation.difficulty, hint: 'mixed / foundation / application / advanced' },
    { id: 'gen_coverageLevel', group: t(lang, '出题', 'Gen'), label: t(lang, '覆盖强度', 'Coverage Level'), value: generation.coverageLevel, hint: 'lean / standard / full' },
    { id: 'gen_language', group: t(lang, '出题', 'Gen'), label: t(lang, '出题语言', 'Gen Language'), value: generation.language, hint: 'auto / 中文 / English / 中英双语' },
    { id: 'recap_automatic', group: t(lang, '复盘', 'Recap'), label: t(lang, '自动生成每日复盘', 'Auto Daily Recap'), value: onOff(dailyRecap.automatic), hint: t(lang, '每日自动总结学习记录', 'Automatic daily recap note') },
    { id: 'recap_tone', group: t(lang, '复盘', 'Recap'), label: t(lang, '每日复盘口吻', 'Recap Tone'), value: dailyRecap.tone === 'friendly' ? t(lang, '亲切 (friendly)', 'Friendly') : t(lang, '专业 (professional)', 'Professional'), hint: 'friendly / professional' },
    {
      id: 'book_coverage',
      group: t(lang, '全书', 'Book'),
      label: t(lang, '全书详略', 'Book coverage'),
      value: bookCoverage === 'brief' ? t(lang, '精简', 'brief') : bookCoverage === 'full' ? t(lang, '详尽', 'full') : t(lang, '标准', 'standard'),
      hint: 'brief / standard / full',
    },
    {
      id: 'book_inlinePractice',
      group: t(lang, '全书', 'Book'),
      label: t(lang, '全书内嵌练习', 'Book inline practice'),
      value: onOff(bookInlinePractice),
      hint: t(lang, '章节末合书自测与薄弱段标注', 'In-book checkpoint & weak lens'),
    },
    {
      id: 'book_confusableDrill',
      group: t(lang, '全书', 'Book'),
      label: t(lang, '易混对比专练', 'Confusable drill'),
      value: onOff(bookConfusableDrill),
      hint: t(lang, '易混概念遮盖自测专练', 'Concept masking drill in lookup'),
    },
    {
      id: 'examprep_autoRoles',
      group: t(lang, '备考', 'Exam'),
      label: t(lang, '备考自动识别岗位', 'ExamPrep auto roles'),
      value: onOff(examPrepAutoRoles),
      hint: t(lang, '按文件名与大小判别资料用途', 'Guess material role automatically'),
    },
    {
      id: 'examprep_showOtherCourses',
      group: t(lang, '备考', 'Exam'),
      label: t(lang, '备考显示其他课程', 'ExamPrep other courses'),
      value: onOff(examPrepShowOtherCourses),
      hint: t(lang, '选材列表中显示其他课程资料', 'Show other courses in pickers'),
    },
  ];

  const startIdx = nextScrollOffset(cursor, scrollOffsetRef.current, maxVisible, rows.length, 1);
  scrollOffsetRef.current = startIdx;
  const visibleRows = rows.slice(startIdx, startIdx + maxVisible);
  const scrollable = rows.length > maxVisible;
  const thumb = scrollable ? scrollbarThumb(rows.length, maxVisible, startIdx) : [];
  const thumbChar = asciiMode ? '#' : '┃';
  const trackChar = asciiMode ? '|' : '│';
  const ell = asciiMode ? '...' : '…';
  const compact = width < 76;
  const groupW = compact ? 8 : 9;
  const labelW = compact ? 21 : 26;
  const valueW = compact ? 16 : 20;
  const contentW = Math.max(20, width - 4);
  const rowW = Math.max(19, contentW - (scrollable ? 1 : 0));
  const hintW = Math.max(0, rowW - 2 - groupW - labelW - valueW);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel
        title={t(lang, '复习调度、出题默认与每日复盘', 'Review, Generation & Daily Recap Settings')}
        badge={`${cursor + 1}/${rows.length}`}
        subtitle={saving ? t(lang, `保存中${ell}`, `Saving${ell}`) : loading ? t(lang, `加载中${ell}`, `Loading${ell}`) : t(lang, `${arrowHint} 或 Enter 调整并即时保存`, `${arrowHint} or Enter to adjust`)}
        focused={isActive && !dialogOpen}
        width={width}
        height={height}
      >
        {loading && !settings ? (
          <Spinner label={t(lang, `读取设置${ell}`, `Loading settings${ell}`)} active={isActive} />
        ) : (
          <Box flexDirection="row" width={contentW} height={visibleRows.length}>
            <Box flexDirection="column" width={rowW} height={visibleRows.length} overflow="hidden">
              {visibleRows.map((row, i) => {
                const idx = startIdx + i;
                const selected = idx === cursor;
                const valueDisplay = row.isAction ? `[ ${row.value} ]` : `< ${row.value} >`;
                return (
                  <Box
                    key={row.id}
                    flexDirection="row"
                    height={1}
                    overflow="hidden"
                    backgroundColor={selected ? theme.selectionBg : undefined}
                  >
                    <Text color={selected ? theme.primary : theme.dim}>{selected ? (asciiMode ? '> ' : '❯ ') : '  '}</Text>
                    <Text color={theme.accent}>{padDisplay(`[${row.group}]`, groupW)}</Text>
                    <Text color={selected ? theme.selectionFg : theme.text} bold={selected}>
                      {padDisplay(truncateDisplay(row.label, labelW - 1, ell), labelW)}
                    </Text>
                    <Text color={selected ? theme.accent : row.isAction ? theme.warning : theme.primary} bold>
                      {padDisplay(truncateDisplay(valueDisplay, valueW - 1, ell), valueW)}
                    </Text>
                    {hintW >= 6 ? (
                      <Text color={theme.muted}>
                        {truncateDisplay(row.hint, hintW, ell)}
                      </Text>
                    ) : null}
                  </Box>
                );
              })}
            </Box>
            {scrollable ? (
              <Box flexDirection="column" width={1} height={visibleRows.length}>
                {thumb.map((on, i) => (
                  <Text key={i} color={on ? (isActive ? theme.primary : theme.muted) : theme.border}>
                    {on ? thumbChar : trackChar}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        )}
      </Panel>

      {confirmResetPractice ? (
        <ConfirmDialog
          title={t(lang, '恢复练习默认设置', 'Reset Practice Defaults')}
          message={t(
            lang,
            '确定将自定义练习默认设置（每轮题数、新题顺序、自动切题、AI 点评、重读提示）恢复为默认值吗？你保存的修题常用短语 (fixPhrases) 会完整保留。',
            'Reset custom practice defaults (round size, card order, autopilot, AI debrief, reread marks) back to defaults? Your saved fixPhrases will remain intact.',
          )}
          confirmLabel={t(lang, '恢复默认', 'Reset')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          width={Math.min(62, Math.max(40, width - 6))}
          onConfirm={() => void handleResetPractice()}
          onCancel={() => setConfirmResetPractice(false)}
          isActive={isActive}
        />
      ) : null}

      {confirmResetExamPrep ? (
        <ConfirmDialog
          title={t(lang, '恢复备考补习默认设置', 'Reset ExamPrep Defaults')}
          message={t(
            lang,
            '确定将自定义备考补习个人默认值（自动识别用途、样卷关键词、清单语言、显示其他课程资料）恢复为默认值吗？备考补习页面的开启/关闭开关会保持不变。',
            'Reset custom ExamPrep personal defaults (auto roles, paper words, list language, show other courses) back to defaults? The ExamPrep page on/off switch will remain unchanged.',
          )}
          confirmLabel={t(lang, '恢复默认', 'Reset')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          width={Math.min(62, Math.max(40, width - 6))}
          onConfirm={() => void handleResetExamPrep()}
          onCancel={() => setConfirmResetExamPrep(false)}
          isActive={isActive}
        />
      ) : null}
    </Box>
  );
});
