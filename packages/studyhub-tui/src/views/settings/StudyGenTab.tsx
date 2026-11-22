import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction } from '../../host/index.js';
import { useShellActions } from '../../shell/index.js';
import { Panel, Spinner, useClaimKeys, useTheme } from '../../components/index.js';
import { padDisplay } from '../../render/index.js';

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

interface FullSettingsShape {
  request_retention: number;
  maximum_interval: number;
  practice?: Partial<PracticeSettingsShape>;
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

type SettingRowId =
  | 'roundSize'
  | 'newCardOrder'
  | 'autopilot'
  | 'debrief'
  | 'rereadMarks'
  | 'request_retention'
  | 'maximum_interval'
  | 'gen_kind'
  | 'gen_count'
  | 'gen_difficulty'
  | 'gen_coverageLevel'
  | 'gen_language'
  | 'recap_automatic'
  | 'recap_tone';

const ROW_IDS: readonly SettingRowId[] = Object.freeze([
  'roundSize',
  'newCardOrder',
  'autopilot',
  'debrief',
  'rereadMarks',
  'request_retention',
  'maximum_interval',
  'gen_kind',
  'gen_count',
  'gen_difficulty',
  'gen_coverageLevel',
  'gen_language',
  'recap_automatic',
  'recap_tone',
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

  const mountedRef = useRef(true);
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

  const practice: PracticeSettingsShape = {
    autopilot: Boolean(settings?.practice?.autopilot),
    roundSize: Number(settings?.practice?.roundSize ?? 20) || 20,
    newCardOrder: (settings?.practice?.newCardOrder as PracticeSettingsShape['newCardOrder']) ?? 'reading',
    debrief: settings?.practice?.debrief !== false,
    rereadMarks: settings?.practice?.rereadMarks !== false,
  };
  const generation: GenerationSettingsShape = {
    kind: String(settings?.generation?.kind ?? 'quiz'),
    count: Number(settings?.generation?.count ?? 10) || 10,
    difficulty: (settings?.generation?.difficulty as GenerationSettingsShape['difficulty']) ?? 'mixed',
    coverageLevel: (settings?.generation?.coverageLevel as GenerationSettingsShape['coverageLevel']) ?? 'standard',
    language: (settings?.generation?.language as GenerationSettingsShape['language']) ?? 'auto',
  };
  const dailyRecap: DailyRecapSettingsShape = {
    automatic: Boolean(settings?.dailyRecap?.automatic),
    tone: (settings?.dailyRecap?.tone as DailyRecapSettingsShape['tone']) ?? 'friendly',
    timeZone: String(settings?.dailyRecap?.timeZone ?? 'Asia/Shanghai'),
  };
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
      }
    },
    [dailyRecap, generation, maxInterval, practice, retention, saveGeneralPatch, savePracticePatch],
  );

  const claimed = useMemo(() => ['j', 'k', 'h', 'l', 'r', ' '], []);
  useClaimKeys(claimed, isActive);

  useInput(
    (input, key) => {
      if (input === 'r') {
        void loadSettings();
        return;
      }
      if (key.upArrow || input === 'k') {
        setCursor((c) => (c - 1 + ROW_IDS.length) % ROW_IDS.length);
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => (c + 1) % ROW_IDS.length);
        return;
      }
      if (key.leftArrow || input === 'h') {
        adjustRow(ROW_IDS[cursor], -1);
        return;
      }
      if (key.rightArrow || input === 'l' || key.return || input === ' ') {
        adjustRow(ROW_IDS[cursor], 1);
      }
    },
    { isActive },
  );

  const onOff = (v: boolean) => (v ? (asciiMode ? t(lang, '开启 +', 'On +') : t(lang, '开启 ✓', 'On ✓')) : t(lang, '关闭', 'Off'));
  const orderLabel = (v: PracticeSettingsShape['newCardOrder']) =>
    v === 'reading' ? t(lang, '按讲义顺序', 'Reading order') : v === 'focus' ? t(lang, '考纲优先', 'Focus first') : t(lang, '随机穿插', 'Shuffle');

  const arrowHint = asciiMode ? 'Left/Right' : '←/→';
  const rows: Array<{ id: SettingRowId; group: string; label: string; value: string; hint: string }> = [
    { id: 'roundSize', group: t(lang, '复习', 'Review'), label: t(lang, '每轮题数 / 每日目标', 'Round Size / Daily Goal'), value: `${practice.roundSize} ${t(lang, '题', 'cards')}`, hint: `5–50 (${arrowHint} ±5)` },
    { id: 'newCardOrder', group: t(lang, '复习', 'Review'), label: t(lang, '新题出场顺序', 'New Card Order'), value: orderLabel(practice.newCardOrder), hint: 'reading / focus / shuffle' },
    { id: 'autopilot', group: t(lang, '复习', 'Review'), label: t(lang, '答对自动下一题', 'Autopilot Advance'), value: onOff(practice.autopilot), hint: t(lang, '答对后自动倒计时切题', 'Auto-advance on pass') },
    { id: 'debrief', group: t(lang, '复习', 'Review'), label: t(lang, '本轮 AI 点评', 'Round AI Debrief'), value: onOff(practice.debrief), hint: t(lang, '结轮后生成轻量点评', 'Brief summary after round') },
    { id: 'rereadMarks', group: t(lang, '复习', 'Review'), label: t(lang, '薄弱段重读提示', 'Reread Marks'), value: onOff(practice.rereadMarks), hint: t(lang, '在学习库提示薄弱讲义段落', 'Highlight weak source sections') },
    { id: 'request_retention', group: 'FSRS-6', label: t(lang, '目标记忆保留率', 'Target Retention'), value: `${Math.round(retention * 100)}%`, hint: '80%–95%' },
    { id: 'maximum_interval', group: 'FSRS-6', label: t(lang, '最大复习间隔', 'Max Interval'), value: `${maxInterval} ${t(lang, '天', 'days')}`, hint: '180 / 365 / 3650 / 36500' },
    { id: 'gen_kind', group: t(lang, '出题', 'Gen'), label: t(lang, '默认题型', 'Default Kind'), value: generation.kind, hint: 'quiz / multi / flashcard / mixed' },
    { id: 'gen_count', group: t(lang, '出题', 'Gen'), label: t(lang, '默认生成题量', 'Default Count'), value: `${generation.count}`, hint: `5–30 (${arrowHint} ±5)` },
    { id: 'gen_difficulty', group: t(lang, '出题', 'Gen'), label: t(lang, '默认难度', 'Difficulty'), value: generation.difficulty, hint: 'mixed / foundation / application / advanced' },
    { id: 'gen_coverageLevel', group: t(lang, '出题', 'Gen'), label: t(lang, '覆盖强度', 'Coverage Level'), value: generation.coverageLevel, hint: 'lean / standard / full' },
    { id: 'gen_language', group: t(lang, '出题', 'Gen'), label: t(lang, '出题语言', 'Gen Language'), value: generation.language, hint: 'auto / 中文 / English / 中英双语' },
    { id: 'recap_automatic', group: t(lang, '复盘', 'Recap'), label: t(lang, '自动生成每日复盘', 'Auto Daily Recap'), value: onOff(dailyRecap.automatic), hint: t(lang, '每日自动总结学习记录', 'Automatic daily recap note') },
    { id: 'recap_tone', group: t(lang, '复盘', 'Recap'), label: t(lang, '每日复盘口吻', 'Recap Tone'), value: dailyRecap.tone === 'friendly' ? t(lang, '亲切 (friendly)', 'Friendly') : t(lang, '专业 (professional)', 'Professional'), hint: 'friendly / professional' },
  ];

  const maxVisible = Math.max(4, height - 4);
  const startIdx = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, rows.length - maxVisible)));
  const visibleRows = rows.slice(startIdx, startIdx + maxVisible);
  const ell = asciiMode ? '...' : '…';

  return (
    <Panel
      title={t(lang, '复习调度、出题默认与每日复盘', 'Review, Generation & Daily Recap Settings')}
      subtitle={saving ? t(lang, `保存中${ell}`, `Saving${ell}`) : loading ? t(lang, `加载中${ell}`, `Loading${ell}`) : t(lang, `${arrowHint} 或 Enter 调整并即时保存`, `${arrowHint} or Enter to adjust`)}
      focused={isActive}
      width={width}
      height={height}
    >
      {loading && !settings ? (
        <Spinner label={t(lang, `读取设置${ell}`, `Loading settings${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column">
          {visibleRows.map((row, i) => {
            const idx = startIdx + i;
            const selected = idx === cursor;
            return (
              <Box
                key={row.id}
                flexDirection="row"
                height={1}
                backgroundColor={selected ? theme.selectionBg : undefined}
              >
                <Text color={selected ? theme.primary : theme.dim}>{selected ? (asciiMode ? '> ' : '❯ ') : '  '}</Text>
                <Text color={theme.accent}>{padDisplay(`[${row.group}]`, 9)}</Text>
                <Text color={selected ? theme.selectionFg : theme.text} bold={selected}>
                  {padDisplay(row.label, 26)}
                </Text>
                <Text color={selected ? theme.accent : theme.primary} bold>
                  {padDisplay(`< ${row.value} >`, 20)}
                </Text>
                <Text color={theme.muted}>{row.hint}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Panel>
  );
});
