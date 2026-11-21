import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { PAGE_REGISTRY } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/index.js';
import { Spinner } from '../components/Badge.js';
import { currentCourse, dueToday, modelInfo, runningJobs } from './data.js';

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

/** 1-line responsive status bar. Segments are dropped by priority until they fit. */
export const TopBar = memo(function TopBar({ width }: TopBarProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const page = useTuiStore((s) => s.page);
  const snapshot = useTuiStore((s) => s.snapshot);
  const cfg = useTuiStore((s) => s.desktopConfig);
  const binding = useTuiStore((s) => s.binding);
  const refreshing = useTuiStore((s) => s.refreshing);

  const meta = PAGE_REGISTRY.find((p) => p.id === page);
  const course = currentCourse(snapshot);
  const due = dueToday(snapshot);
  const jobs = runningJobs(snapshot);
  const model = modelInfo(cfg, binding, snapshot);

  const onPrimary = theme.dark ? theme.bg : '#ffffff';
  const brand = ' ▙▟ StudyHub ';
  const brandShort = ' ▙▟ ';
  const pageLabel = meta ? ` ${meta.icon} ${t(lang, meta.labelZh, meta.labelEn)} ` : '';
  const courseLabel = truncateDisplay(course ?? t(lang, '全部课程', 'All courses'), 18);
  const courseText = ` [c] ${courseLabel} `;
  const modelLabel = truncateDisplay(`${model.icon} ${model.provider}${model.model ? ` · ${model.model}` : ''}`, 30);
  const modelText = ` ${modelLabel} `;
  const dueText = ` ${t(lang, '今日', 'Due')} ${due} `;
  const jobsText = `  ${jobs} ${t(lang, '任务', 'jobs')} `;
  const helpText = ` [?] ${t(lang, '帮助', 'Help')}  [/] ${t(lang, '命令', 'Cmd')} `;

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
        <Text key="course">
          <Text> </Text>
          <Text backgroundColor={theme.surface} color={course ? theme.accent : theme.muted}>
            {courseText}
          </Text>
        </Text>
      ),
    },
  ];
  const right: Segment[] = [
    ...(jobs > 0 || refreshing
      ? [
          {
            id: 'jobs',
            priority: 70,
            width: displayWidth(jobsText) + 1,
            node: (
              <Text key="jobs" backgroundColor={theme.surface}>
                <Text> </Text>
                <Spinner tone="ai" label={undefined} />
                <Text color={theme.ai}>{jobsText.slice(1)}</Text>
              </Text>
            ),
          } satisfies Segment,
        ]
      : []),
    {
      id: 'due',
      priority: 75,
      width: displayWidth(dueText) + 1,
      node: (
        <Text key="due">
          <Text> </Text>
          <Text backgroundColor={theme.surface} color={due > 0 ? theme.warning : theme.success}>
            {dueText}
          </Text>
        </Text>
      ),
    },
    {
      id: 'model',
      priority: 90,
      width: displayWidth(modelText) + 1,
      node: (
        <Text key="model">
          <Text> </Text>
          <Text backgroundColor={model.ready ? theme.success : theme.warning} color={onPrimary} bold>
            {modelText}
          </Text>
        </Text>
      ),
    },
    {
      id: 'help',
      priority: 50,
      width: displayWidth(helpText) + 1,
      node: (
        <Text key="help" color={theme.muted}>
          {` ${helpText}`}
        </Text>
      ),
    },
  ];

  // Drop lowest-priority segments until the bar fits.
  const all = [...left, ...right];
  const kept = new Set(all.map((s) => s.id));
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

