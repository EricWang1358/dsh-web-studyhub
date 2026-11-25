import React, { memo, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import { ProgressBar } from '../../components/Badge.js';
import { useTheme } from '../../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { t, useTuiStore } from '../../state/store.js';
import type { UiLanguage } from '../../types/contracts.js';
import { todayFocusStats, type FocusStats } from './board-store.js';

export const FOCUS_DURATIONS = [15, 25, 45, 60] as const;
export const BREAK_DURATIONS = [5, 10] as const;
export const POMODORO_NARROW_BREAKPOINT = 84;

export type PomodoroMode = 'focus' | 'break';

export function pomodoroBarHeight(width: number): number {
  return width < POMODORO_NARROW_BREAKPOINT ? 2 : 1;
}

export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function cycleDuration(durations: readonly number[], current: number, dir: 1 | -1): number {
  const idx = durations.indexOf(current);
  if (idx === -1) return durations[0];
  return durations[(idx + dir + durations.length) % durations.length];
}

export interface PomodoroBarProps {
  width: number;
  lang: UiLanguage;
  asciiMode: boolean;
  isActive: boolean;
  selectedCardTitle?: string;
  focusStats?: FocusStats;
  onFocusComplete: (minutes: number) => void;
}

export const PomodoroBar = memo(function PomodoroBar({
  width,
  lang,
  asciiMode,
  isActive,
  selectedCardTitle,
  focusStats,
  onFocusComplete,
}: PomodoroBarProps) {
  const theme = useTheme();
  const pomodoro = useTuiStore((s) => s.pomodoro);
  const setPomodoro = useTuiStore((s) => s.setPomodoro);
  const resetPomodoro = useTuiStore((s) => s.resetPomodoro);

  const mode: PomodoroMode = pomodoro.phase === 'work' ? 'focus' : 'break';
  const durationMin = pomodoro.phase === 'work' ? pomodoro.workMinutes : pomodoro.breakMinutes;
  const { remainingSec, running, endsAt } = pomodoro;

  const onFocusCompleteRef = useRef(onFocusComplete);
  onFocusCompleteRef.current = onFocusComplete;

  // Timer interval syncs remainingSec from wall-clock endsAt while running; persists across view switches.
  useEffect(() => {
    if (!running || endsAt === null) return undefined;
    const sync = () => {
      const cur = useTuiStore.getState().pomodoro;
      if (!cur.running || cur.endsAt === null) return;
      const nextRem = Math.max(0, Math.ceil((cur.endsAt - Date.now()) / 1000));
      const curDurMin = cur.phase === 'work' ? cur.workMinutes : cur.breakMinutes;
      if (nextRem <= 0) {
        setPomodoro({ running: false, endsAt: null, remainingSec: curDurMin * 60 });
        if (cur.phase === 'work') {
          onFocusCompleteRef.current(curDurMin);
        }
        return;
      }
      if (nextRem !== cur.remainingSec) {
        setPomodoro({ remainingSec: nextRem });
      }
    };
    sync();
    const timer = setInterval(sync, 250);
    return () => clearInterval(timer);
  }, [running, endsAt, setPomodoro]);

  useInput(
    (input) => {
      if (input === ' ' || input === 'P') {
        const cur = useTuiStore.getState().pomodoro;
        const curDurMin = cur.phase === 'work' ? cur.workMinutes : cur.breakMinutes;
        if (cur.running) {
          const pausedRem = cur.endsAt !== null ? Math.max(0, Math.ceil((cur.endsAt - Date.now()) / 1000)) : cur.remainingSec;
          setPomodoro({ running: false, endsAt: null, remainingSec: pausedRem });
        } else {
          const baseSec = cur.remainingSec <= 0 ? curDurMin * 60 : cur.remainingSec;
          setPomodoro({ running: true, remainingSec: baseSec, endsAt: Date.now() + baseSec * 1000 });
        }
        return;
      }
      if (input === 'R') {
        resetPomodoro();
        return;
      }
      if (input === 'M') {
        const cur = useTuiStore.getState().pomodoro;
        const nextPhase = cur.phase === 'work' ? 'break' : 'work';
        const nextDur = nextPhase === 'work' ? cur.workMinutes : cur.breakMinutes;
        setPomodoro({ phase: nextPhase, running: false, endsAt: null, remainingSec: nextDur * 60 });
        return;
      }
      if (input === '+' || input === '-') {
        const cur = useTuiStore.getState().pomodoro;
        const durations = cur.phase === 'work' ? FOCUS_DURATIONS : BREAK_DURATIONS;
        const curDurMin = cur.phase === 'work' ? cur.workMinutes : cur.breakMinutes;
        const nextDur = cycleDuration(durations, curDurMin, input === '+' ? 1 : -1);
        setPomodoro({
          running: false,
          endsAt: null,
          remainingSec: nextDur * 60,
          ...(cur.phase === 'work' ? { workMinutes: nextDur } : { breakMinutes: nextDur }),
        });
      }
    },
    { isActive },
  );

  const ell = asciiMode ? '...' : '…';
  const totalSec = Math.max(1, durationMin * 60);
  const ratio = Math.max(0, Math.min(1, (totalSec - remainingSec) / totalSec));
  const countdown = formatCountdown(remainingSec);

  const stateGlyph = asciiMode ? (running ? '>' : '||') : running ? '▶' : '⏸';
  const modeLabel =
    mode === 'focus' ? t(lang, '专注 Focus', 'Focus') : t(lang, '短休 Break', 'Break');
  const modePill = ` ${stateGlyph} ${modeLabel} `;
  const modeColor = mode === 'focus' ? (running ? theme.success : theme.primary) : theme.accent;

  const stats = todayFocusStats(focusStats);
  const statsText = asciiMode
    ? `[P:${stats.completedPomodoros} ${stats.focusedMinutes}m]`
    : `🍅 ${stats.completedPomodoros} · ${stats.focusedMinutes}m`;

  const focusPrefix = mode === 'focus' ? t(lang, '正在专注: ', 'Focus: ') : t(lang, '休息中: ', 'Break: ');
  const linkedTitle = selectedCardTitle || t(lang, '未选择任务', 'No card selected');
  const focusLineRaw = `${focusPrefix}${linkedTitle}`;

  const twoLine = width < POMODORO_NARROW_BREAKPOINT;

  if (twoLine) {
    const barW = Math.max(6, Math.min(12, width - displayWidth(modePill) - displayWidth(countdown) - displayWidth(statsText) - 6));
    const line2Avail = Math.max(8, width - 2);
    const focusLine = truncateDisplay(focusLineRaw, line2Avail, ell);

    return (
      <Box flexDirection="column" width={width} height={2} backgroundColor={theme.surface} overflow="hidden">
        <Box width={width} height={1} overflow="hidden">
          <Text backgroundColor={modeColor} color={theme.dark ? theme.bg : '#ffffff'} bold>
            {modePill}
          </Text>
          <Text color={running ? theme.text : theme.muted} bold={running}>
            {` ${countdown} `}
          </Text>
          <ProgressBar ratio={ratio} width={barW} style="block" showPercent={false} />
          <Box flexGrow={1} />
          <Text color={theme.muted} wrap="truncate-end">
            {` ${statsText} `}
          </Text>
        </Box>
        <Box width={width} height={1} paddingLeft={1} paddingRight={1} overflow="hidden">
          <Text color={selectedCardTitle ? theme.text : theme.muted} wrap="truncate-end">
            {focusLine}
          </Text>
        </Box>
      </Box>
    );
  }

  const barW = width >= 112 ? 14 : 10;
  const fixedW = displayWidth(modePill) + displayWidth(countdown) + 2 + barW + 2 + displayWidth(statsText) + 3;
  const titleAvail = Math.max(8, width - fixedW);
  const focusLine = truncateDisplay(focusLineRaw, titleAvail, ell);

  return (
    <Box width={width} height={1} backgroundColor={theme.surface} overflow="hidden">
      <Text backgroundColor={modeColor} color={theme.dark ? theme.bg : '#ffffff'} bold>
        {modePill}
      </Text>
      <Text color={running ? theme.text : theme.muted} bold={running}>
        {` ${countdown} `}
      </Text>
      <ProgressBar ratio={ratio} width={barW} style="block" showPercent={false} />
      <Text color={selectedCardTitle ? theme.text : theme.muted} wrap="truncate-end">
        {` ${focusLine}`}
      </Text>
      <Box flexGrow={1} />
      <Text color={theme.muted} wrap="truncate-end">
        {` ${statsText} `}
      </Text>
    </Box>
  );
});
