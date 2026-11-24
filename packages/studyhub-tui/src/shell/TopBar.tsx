import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { PAGE_REGISTRY } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { Spinner } from '../components/Badge.js';
import { useClaimedKeys } from '../components/focus.js';
import { ClickableBox } from '../components/mouse.js';
import { formatReturnHintLabel } from '../state/practice-stack.js';
import { currentCourse, dueToday, modelInfo, pageIcon, runningJobs, unreadInboxCount } from './data.js';

export interface TopBarProps {
  width: number;
}

interface Segment {
  id: string;
  /** Lower = dropped first. */
  priority: number;
  width: number;
  node: React.ReactNode;
}

const ASCII_MODEL_ICON: Record<string, string> = {
  agy: '*',
  codex: '>',
  openai: '@',
  unknown: 'o',
};

/** 1-line responsive status bar. Segments are dropped by priority until they fit. */
export const TopBar = memo(function TopBar({ width }: TopBarProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const page = useTuiStore((s) => s.page);
  const snapshot = useTuiStore((s) => s.snapshot);
  const cfg = useTuiStore((s) => s.desktopConfig);
  const binding = useTuiStore((s) => s.binding);
  const refreshing = useTuiStore((s) => s.refreshing);
  const practiceStack = useTuiStore((s) => s.practiceStack);
  const claimedKeys = useClaimedKeys();
  const courseKeyOverridden = claimedKeys.has('c');
  const paletteKeyOverridden = claimedKeys.has('/');

  const meta = PAGE_REGISTRY.find((p) => p.id === page);
  const course = currentCourse(snapshot);
  const due = dueToday(snapshot, course);
  const jobs = runningJobs(snapshot);
  const unread = unreadInboxCount(snapshot);
  const model = modelInfo(cfg, binding, snapshot);

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' - ' : ' · ';
  const mIcon = asciiMode ? (ASCII_MODEL_ICON[model.mode] ?? 'o') : model.icon;
  const pIcon = meta ? pageIcon(meta.id, asciiMode, meta.icon) : '';

  const onPrimary = theme.dark ? theme.bg : '#ffffff';
  const brand = asciiMode ? ' [SH] StudyHub ' : ' ▙▟ StudyHub ';
  const brandShort = asciiMode ? ' [SH] ' : ' ▙▟ ';
  const pageLabel = meta ? ` ${pIcon} ${t(lang, meta.labelZh, meta.labelEn)} ` : '';
  const rawCourse = course ?? t(lang, '全部课程', 'All courses');
  const rawModel = `${mIcon} ${model.provider}${model.model ? `${sep}${model.model}` : ''}`;
  const inboxText = asciiMode ? ` [I] M:${unread} ` : ` [I] ✉ ${unread} `;
  const dueText = ` ${t(lang, '今日', 'Due')} ${due} `;
  const jobsText = `  ${jobs} ${t(lang, '任务', 'jobs')} `;
  const cmdKeyLabel = paletteKeyOverridden ? '[Ctrl+K]' : '[/]';
  const helpText = ` [?] ${t(lang, '帮助', 'Help')}  ${cmdKeyLabel} ${t(lang, '命令', 'Cmd')} `;
  const returnChipLabel = formatReturnHintLabel(practiceStack, lang);
  const returnChipText = returnChipLabel ? ` ${asciiMode ? '<-' : '←'} ${returnChipLabel} [r] ` : '';

  // Dynamic budget allocation for course & model so wide terminals never truncate unnecessarily.
  const coursePrefix = courseKeyOverridden ? ' ' : ' [c] ';
  const COURSE_CHROME = displayWidth(coursePrefix) + 2; // leading space + prefix + trailing space
  const MODEL_CHROME = 3; // leading space + " " + " "
  const rawCourseW = displayWidth(rawCourse);
  const rawModelW = displayWidth(rawModel);

  const staticWidths: Array<{ id: string; priority: number; width: number }> = [
    { id: 'brand', priority: 100, width: displayWidth(brand) },
    ...(returnChipText ? [{ id: 'return', priority: 95, width: displayWidth(returnChipText) + 1 }] : []),
    { id: 'page', priority: 60, width: displayWidth(pageLabel) + 1 },
    ...(unread > 0 ? [{ id: 'inbox', priority: 55, width: displayWidth(inboxText) + 1 }] : []),
    ...(jobs > 0 || refreshing ? [{ id: 'jobs', priority: 70, width: displayWidth(jobsText) + 1 }] : []),
    { id: 'due', priority: 75, width: displayWidth(dueText) + 1 },
    { id: 'help', priority: 50, width: displayWidth(helpText) + 1 },
  ];

  const kept = new Set<string>([...staticWidths.map((s) => s.id), 'course', 'model']);
  const minCourseBudget = Math.min(rawCourseW, 18) + COURSE_CHROME;
  const minModelBudget = Math.min(rawModelW, 24) + MODEL_CHROME;
  const staticTotal = () => staticWidths.filter((s) => kept.has(s.id)).reduce((n, s) => n + s.width, 0);

  // Drop lower-priority static segments first if even comfortable course+model caps do not fit.
  const dropOrder = [...staticWidths].filter((s) => s.id !== 'brand').sort((a, b) => a.priority - b.priority);
  for (const seg of dropOrder) {
    if (staticTotal() + minCourseBudget + minModelBudget <= width - 1) break;
    kept.delete(seg.id);
  }

  // Allocate all remaining horizontal space between course and model before truncating either.
  let flexAvail = width - 1 - staticTotal() - COURSE_CHROME - MODEL_CHROME;
  if (flexAvail < 8) {
    kept.delete('course');
    flexAvail = width - 1 - staticTotal() - MODEL_CHROME;
    if (flexAvail < 4) {
      kept.delete('model');
      flexAvail = 0;
    }
  }

  let courseCap = rawCourseW;
  let modelCap = rawModelW;
  if (kept.has('course') && kept.has('model')) {
    if (rawCourseW + rawModelW > flexAvail) {
      const baseCourse = Math.max(4, Math.floor(flexAvail * 0.45));
      const baseModel = Math.max(4, flexAvail - baseCourse);
      if (rawCourseW <= baseCourse) {
        courseCap = rawCourseW;
        modelCap = Math.max(4, flexAvail - rawCourseW);
      } else if (rawModelW <= baseModel) {
        modelCap = rawModelW;
        courseCap = Math.max(4, flexAvail - rawModelW);
      } else {
        courseCap = baseCourse;
        modelCap = baseModel;
      }
    }
  } else if (kept.has('model')) {
    modelCap = Math.min(rawModelW, Math.max(4, flexAvail));
  }

  const courseLabel = truncateDisplay(rawCourse, courseCap, ell);
  const courseText = `${coursePrefix}${courseLabel} `;
  const modelLabel = truncateDisplay(rawModel, modelCap, ell);
  const modelText = ` ${modelLabel} `;

  const left: Segment[] = [
    {
      id: 'brand',
      priority: 100,
      width: displayWidth(brand),
      node: (
        <Text key="brand" backgroundColor={theme.primary} color={onPrimary} bold>
          {brand}
        </Text>
      ),
    },
    ...(returnChipText
      ? [
          {
            id: 'return',
            priority: 95,
            width: displayWidth(returnChipText) + 1,
            node: (
              <ClickableBox key="return" onClick={() => useTuiStore.getState().returnViaPracticeStack()}>
                <Text>
                  <Text> </Text>
                  <Text backgroundColor={theme.success} color={onPrimary} bold>
                    {returnChipText}
                  </Text>
                </Text>
              </ClickableBox>
            ),
          } satisfies Segment,
        ]
      : []),
    {
      id: 'page',
      priority: 60,
      width: displayWidth(pageLabel) + 1,
      node: (
        <Text key="page" color={theme.heading} bold>
          {` ${pageLabel}`}
        </Text>
      ),
    },
    {
      id: 'course',
      priority: 80,
      width: displayWidth(courseText) + 1,
      node: (
        <ClickableBox key="course" onClick={() => useTuiStore.getState().setCoursePickerOpen(true)}>
          <Text>
            <Text> </Text>
            <Text backgroundColor={theme.surface} color={course ? theme.accent : theme.muted}>
              {courseText}
            </Text>
          </Text>
        </ClickableBox>
      ),
    },
  ];
  const right: Segment[] = [
    ...(unread > 0
      ? [
          {
            id: 'inbox',
            priority: 55,
            width: displayWidth(inboxText) + 1,
            node: (
              <ClickableBox key="inbox" onClick={() => useTuiStore.getState().setInboxOpen(true)}>
                <Text>
                  <Text> </Text>
                  <Text backgroundColor={theme.surface} color={theme.primary} bold>
                    {inboxText}
                  </Text>
                </Text>
              </ClickableBox>
            ),
          } satisfies Segment,
        ]
      : []),
    ...(jobs > 0 || refreshing
      ? [
          {
            id: 'jobs',
            priority: 70,
            width: displayWidth(jobsText) + 1,
            node: (
              <ClickableBox key="jobs" onClick={() => useTuiStore.getState().navigate('tasks')}>
                <Text backgroundColor={theme.surface}>
                  <Text> </Text>
                  <Spinner tone="ai" label={undefined} />
                  <Text color={theme.ai}>{jobsText.slice(1)}</Text>
                </Text>
              </ClickableBox>
            ),
          } satisfies Segment,
        ]
      : []),
    {
      id: 'due',
      priority: 75,
      width: displayWidth(dueText) + 1,
      node: (
        <ClickableBox
          key="due"
          onClick={() => {
            const st = useTuiStore.getState();
            st.navigate('review', st.activeRunId ? { runId: st.activeRunId } : {});
          }}
        >
          <Text>
            <Text> </Text>
            <Text backgroundColor={theme.surface} color={due > 0 ? theme.warning : theme.success}>
              {dueText}
            </Text>
          </Text>
        </ClickableBox>
      ),
    },
    {
      id: 'model',
      priority: 90,
      width: displayWidth(modelText) + 1,
      node: (
        <ClickableBox key="model" onClick={() => useTuiStore.getState().navigate('settings', { mode: 'model' })}>
          <Text>
            <Text> </Text>
            <Text backgroundColor={model.ready ? theme.success : theme.warning} color={onPrimary} bold>
              {modelText}
            </Text>
          </Text>
        </ClickableBox>
      ),
    },
    {
      id: 'help',
      priority: 50,
      width: displayWidth(helpText) + 1,
      node: (
        <Box key="help" flexDirection="row">
          <ClickableBox onClick={() => useTuiStore.getState().setHelpOpen(true)}>
            <Text color={theme.muted}>{`  [?] ${t(lang, '帮助', 'Help')} `}</Text>
          </ClickableBox>
          <ClickableBox onClick={() => useTuiStore.getState().setCommandPaletteOpen(true)}>
            <Text color={theme.muted}>{` ${cmdKeyLabel} ${t(lang, '命令', 'Cmd')} `}</Text>
          </ClickableBox>
        </Box>
      ),
    },
  ];

  // Final safety pass in case any segment rounding still exceeds width - 1.
  const all = [...left, ...right];
  const total = () => all.filter((s) => kept.has(s.id)).reduce((n, s) => n + s.width, 0);
  const order = [...all].sort((a, b) => a.priority - b.priority);
  for (const seg of order) {
    if (total() <= width - 1) break;
    if (seg.id === 'brand') continue;
    kept.delete(seg.id);
  }
  let brandNode: React.ReactNode = left[0].node;
  if (total() > width - 1) {
    brandNode = (
      <Text key="brand" backgroundColor={theme.primary} color={onPrimary} bold>
        {brandShort}
      </Text>
    );
  }

  return (
    <Box width={width} height={1} overflow="hidden">
      {brandNode}
      {left.slice(1).filter((s) => kept.has(s.id)).map((s) => s.node)}
      <Box flexGrow={1} />
      {right.filter((s) => kept.has(s.id)).map((s) => s.node)}
      <Text> </Text>
    </Box>
  );
});

