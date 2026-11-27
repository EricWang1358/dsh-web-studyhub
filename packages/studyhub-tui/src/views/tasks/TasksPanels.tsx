import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { KeyScope } from '../../input/hooks.js';
import type { UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { Badge, EmptyState, ProgressBar, Spinner, StatusPill, type PillStatus } from '../../components/Badge.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { ChromeLabel, LAYOUT_BP, ScrollArea, computeFilterBarLayout } from '../../layout/index.js';
import { useTheme } from '../../theme/tokens.js';
import { truncateDisplay } from '../../render/cjk.js';
import { renderStatTable } from '../../render/charts.js';
import {
  ACTIVE_STATUSES,
  formatElapsed,
  pillStatusFor,
  type FilterTab,
  type JobRecord,
} from './tasks-model.js';

export interface TasksHeaderBarProps {
  width: number;
  topBarH: number;
  lang: UiLanguage;
  asciiMode: boolean;
  isActive: boolean;
  filterTab: FilterTab;
  runningCount: number;
  allCount: number;
  archivedCount: number;
  hasActiveJobs: boolean;
  controlTarget: JobRecord | null;
  queuePillLabel: string;
  queuePillStatus: PillStatus;
  showFilterBar: boolean;
  filterEditing: boolean;
  filterQuery: string;
  filteredCount: number;
  tabTotalCount: number;
  onFilterChange: (value: string) => void;
  onFilterSubmit: (value: string) => void;
  onFilterCancel: () => void;
}

export const TasksHeaderBar = memo(function TasksHeaderBar({
  width,
  topBarH,
  lang,
  asciiMode,
  isActive,
  filterTab,
  runningCount,
  allCount,
  archivedCount,
  hasActiveJobs,
  controlTarget,
  queuePillLabel,
  queuePillStatus,
  showFilterBar,
  filterEditing,
  filterQuery,
  filteredCount,
  tabTotalCount,
  onFilterChange,
  onFilterSubmit,
  onFilterCancel,
}: TasksHeaderBarProps) {
  const theme = useTheme();
  const narrowBar = width < LAYOUT_BP.SPLIT_COMPACT;
  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' | ' : ' · ';
  const filterBadge = `[${filterEditing ? t(lang, '筛选', 'Filter') : t(lang, '已筛选', 'Filtered')} ${filteredCount}/${tabTotalCount}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(
    width,
    filterBadge,
    lang,
    filterEditing,
  );

  return (
    <>
      <Box height={topBarH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center" width={Math.max(10, width - 2)}>
          <Box flexShrink={0}>
            <Badge
              label={`1. ${t(lang, '运行中', 'Running')} (${runningCount})`}
              tone={filterTab === 'running' ? 'accent' : 'muted'}
              variant={filterTab === 'running' ? 'solid' : 'outline'}
            />
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            <Badge
              label={`2. ${t(lang, '全部', 'All')} (${allCount})`}
              tone={filterTab === 'all' ? 'primary' : 'muted'}
              variant={filterTab === 'all' ? 'solid' : 'outline'}
            />
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            <Badge
              label={`3. ${t(lang, '已归档', 'Archived')} (${archivedCount})`}
              tone={filterTab === 'archived' ? 'info' : 'muted'}
              variant={filterTab === 'archived' ? 'solid' : 'outline'}
            />
          </Box>
          <Box flexGrow={1} />
          <Box flexShrink={0} flexDirection="row" alignItems="center">
            <StatusPill label={queuePillLabel} status={queuePillStatus} />
            {controlTarget?.concurrency !== null && controlTarget?.concurrency !== undefined ? (
              <>
                <Text> </Text>
                <Badge
                  label={`${controlTarget.concurrency}x`}
                  tone={controlTarget.setAvailable ? 'info' : 'muted'}
                  variant="outline"
                />
              </>
            ) : null}
          </Box>
          {hasActiveJobs ? (
            <Box flexShrink={0} marginLeft={1}>
              <Spinner
                label={
                  narrowBar
                    ? ''
                    : asciiMode
                      ? t(lang, '实时刷新中...', 'Live...')
                      : t(lang, '实时刷新中…', 'Live…')
                }
              />
            </Box>
          ) : width >= LAYOUT_BP.AI_DRAWER_SIDE ? (
            <Box flexShrink={0} marginLeft={1}>
              <ChromeLabel
                text={t(
                  lang,
                  `Tab 筛选${sep}w 历史流${sep}v 轨迹`,
                  `Tab filter${sep}w Flows${sep}v Trace`,
                )}
                maxWidth={Math.max(8, width - 72)}
                color={theme.dim}
                ascii={asciiMode}
              />
            </Box>
          ) : null}
        </Box>
        <ChromeLabel
          text={
            width < LAYOUT_BP.COMPACT
              ? t(
                  lang,
                  '任务：[R]恢复 [p]暂停 [+/-]并发 [e]导出 [D]清轨迹 [o]输出 [m]补充 [w]流',
                  'Jobs: [R]Rec [p]Pause [+/-]Conc [e]Exp [D]Purge [o]Out [m]Msg [w]Flow',
                )
              : t(
                  lang,
                  `监控后台任务；[R] 恢复${sep}[p] 暂停${sep}[+/-] 并发${sep}[e] 导出${sep}[D] 清轨迹${sep}[o] 输出${sep}[m] 补充${sep}[w] 流`,
                  `Monitor jobs; [R] Recover${sep}[p] Pause${sep}[+/-] Concur${sep}[e] Export${sep}[D] Purge${sep}[o] Out${sep}[m] Msg${sep}[w] Flows`,
                )
          }
          maxWidth={Math.max(10, width - 2)}
          color={theme.dim}
          ascii={asciiMode}
        />
      </Box>

      {showFilterBar ? (
        <KeyScope id="tasks:filter" opaque active={isActive && filterEditing}>
          <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
            <Text color={filterEditing ? theme.primary : theme.accent} bold>
              {filterBadge}
            </Text>
            <Box flexGrow={1} overflow="hidden">
              <TextInput
                value={filterQuery}
                onChange={onFilterChange}
                onSubmit={onFilterSubmit}
                onCancel={onFilterCancel}
                isActive={isActive && filterEditing}
                width={filterInputW}
                prompt="/"
                placeholder={t(
                  lang,
                  `标题/类型/状态/课程/阶段/ID${ell}`,
                  `title/type/status/course/stage/id${ell}`,
                )}
                maxLength={120}
              />
            </Box>
            {filterRightHint ? (
              <Text color={theme.dim} wrap="truncate">
                {filterRightHint}
              </Text>
            ) : null}
          </Box>
        </KeyScope>
      ) : null}
    </>
  );
});

export interface TasksListPanelProps {
  width: number;
  height: number;
  lang: UiLanguage;
  asciiMode: boolean;
  pageActive: boolean;
  filterQuery: string;
  filteredJobs: JobRecord[];
  selectedIndex: number;
  onSelectIndex: (idx: number) => void;
  onActivateJob: (job: JobRecord) => void;
}

export const TasksListPanel = memo(function TasksListPanel({
  width,
  height,
  lang,
  asciiMode,
  pageActive,
  filterQuery,
  filteredJobs,
  selectedIndex,
  onSelectIndex,
  onActivateJob,
}: TasksListPanelProps) {
  const theme = useTheme();
  const ell = asciiMode ? '...' : '…';
  const metaSep = asciiMode ? ' - ' : ' · ';

  return (
    <Panel
      title={t(lang, '后台任务', 'Background Jobs')}
      badge={filteredJobs.length}
      width={width}
      height={height}
      focused={pageActive}
    >
      {filteredJobs.length === 0 ? (
        <EmptyState
          title={
            filterQuery.trim()
              ? t(lang, '未找到匹配的任务', 'No matching jobs')
              : t(lang, '当前筛选下无任务', 'No jobs in this filter')
          }
          hint={
            filterQuery.trim()
              ? t(lang, '按 Esc 清除筛选条件，或切换标签页', 'Press Esc to clear filter, or switch tabs')
              : t(lang, '前往「创建题组」或「音频转写」启动任务', 'Start a task from Generate or Audio')
          }
          width={Math.max(12, width - 4)}
          height={Math.max(4, height - 2)}
        />
      ) : (
        <VirtualList
          items={filteredJobs}
          height={Math.max(1, height - 2)}
          width={Math.max(12, width - 4)}
          selectedIndex={selectedIndex}
          onChange={onSelectIndex}
          onSelect={onActivateJob}
          isActive={pageActive}
          keyExtractor={(j) => `${j.archived ? 'arch-' : ''}${j.id}`}
          renderItem={(job, ctx) => {
            const active = ACTIVE_STATUSES.has(job.status);
            const pct = `${Math.round(job.progress * 100)}%`;
            const elapsed = formatElapsed(job.startedAt, job.finishedAt, asciiMode);
            const meta = `${pct}${metaSep}${elapsed}`;
            const titleMax = Math.max(8, ctx.width - meta.length - 8);
            return (
              <Box flexDirection="row" width={ctx.width}>
                <Text color={ctx.selected ? theme.primary : theme.muted}>
                  {ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}
                </Text>
                <Text color={active ? theme.accent : theme.muted}>
                  {active ? (asciiMode ? '* ' : '⟳ ') : asciiMode ? '- ' : '• '}
                </Text>
                <Text color={theme.text} bold={ctx.selected}>
                  {truncateDisplay(job.title, titleMax, ell)}
                </Text>
                <Box flexGrow={1} />
                <Text color={theme.dim}>{meta}</Text>
              </Box>
            );
          }}
        />
      )}
    </Panel>
  );
});

export interface TasksDetailPanelProps {
  width: number;
  height: number;
  lang: UiLanguage;
  asciiMode: boolean;
  selectedJob: JobRecord | undefined;
  detailMode: 'output' | 'trace';
  activeLogLines: string[];
  runningCount: number;
  allCount: number;
  archivedCount: number;
}

export const TasksDetailPanel = memo(function TasksDetailPanel({
  width,
  height,
  lang,
  asciiMode,
  selectedJob,
  detailMode,
  activeLogLines,
  runningCount,
  allCount,
  archivedCount,
}: TasksDetailPanelProps) {
  const theme = useTheme();
  const sep = asciiMode ? ' | ' : ' · ';

  return (
    <Panel
      title={selectedJob ? selectedJob.title : t(lang, '任务详情', 'Job Detail')}
      subtitle={
        detailMode === 'output'
          ? t(lang, '实时输出 (<=200行)', asciiMode ? 'Output (<=200)' : 'Output (≤200)')
          : t(lang, '调用轨迹', 'Trace')
      }
      width={width}
      height={height}
    >
      {!selectedJob ? (
        <Box flexDirection="column" width={Math.max(12, width - 4)} height={Math.max(4, height - 2)}>
          {height >= 12 ? (
            <Box flexDirection="column" marginBottom={1}>
              {renderStatTable(
                [
                  { key: 'queue', label: t(lang, '任务队列', 'Queue'), align: 'left', minWidth: 8 },
                  { key: 'count', label: t(lang, '数量', 'Count'), align: 'right', minWidth: 5 },
                ],
                [
                  { queue: t(lang, '运行中', 'Running'), count: runningCount },
                  { queue: t(lang, '全部任务', 'All Jobs'), count: allCount },
                  { queue: t(lang, '已归档', 'Archived'), count: archivedCount },
                ],
                Math.max(18, width - 4),
                theme,
                { ascii: asciiMode },
              ).map((line, idx) => (
                <Text key={`tq-${idx}`}>{line}</Text>
              ))}
            </Box>
          ) : null}
          <EmptyState
            title={t(lang, '选择一个任务查看详情', 'Select a job')}
            width={Math.max(12, width - 4)}
            height={Math.max(4, height - (height >= 12 ? 8 : 2))}
          />
        </Box>
      ) : (
        <Box flexDirection="column" width={Math.max(12, width - 4)} height={Math.max(2, height - 2)}>
          <Box flexDirection="row" alignItems="center" flexWrap="wrap">
            <StatusPill label={selectedJob.status} status={pillStatusFor(selectedJob.status)} />
            <Text> </Text>
            <Badge label={selectedJob.type} tone="info" variant="soft" />
            {selectedJob.concurrency !== null ? (
              <>
                <Text> </Text>
                <Badge
                  label={`${selectedJob.concurrency}x`}
                  tone={selectedJob.setAvailable ? 'info' : 'muted'}
                  variant="outline"
                />
              </>
            ) : null}
            <Text> </Text>
            <Text color={theme.dim}>{formatElapsed(selectedJob.startedAt, selectedJob.finishedAt, asciiMode)}</Text>
            {selectedJob.draftId ? (
              <>
                <Text> </Text>
                <Badge label={t(lang, 'Enter 打开草稿', 'Enter: Draft')} tone="success" variant="outline" />
              </>
            ) : null}
          </Box>

          <Box marginTop={1}>
            <ProgressBar ratio={selectedJob.progress} width={Math.max(14, Math.min(36, width - 8))} />
          </Box>

          {selectedJob.phase ? (
            <Text color={theme.muted}>{`${t(lang, '阶段: ', 'Phase: ')}${selectedJob.phase}`}</Text>
          ) : null}
          {selectedJob.error ? (
            <Text color={theme.error}>{`${t(lang, '错误: ', 'Error: ')}${selectedJob.error}`}</Text>
          ) : null}

          <Box marginTop={1} flexDirection="row">
            <Badge
              label={t(lang, '实时输出', 'Output')}
              tone={detailMode === 'output' ? 'primary' : 'muted'}
              variant={detailMode === 'output' ? 'solid' : 'outline'}
            />
            <Text> </Text>
            <Badge
              label={t(lang, '调用轨迹', 'Trace')}
              tone={detailMode === 'trace' ? 'primary' : 'muted'}
              variant={detailMode === 'trace' ? 'solid' : 'outline'}
            />
            <ChromeLabel
              text={t(
                lang,
                `  [v] 切换${sep}[e] 导出${sep}[D] 清空`,
                `  [v] Switch${sep}[e] Export${sep}[D] Purge`,
              )}
              maxWidth={Math.max(8, width - 28)}
              color={theme.dim}
              ascii={asciiMode}
            />
          </Box>

          <ScrollArea
            lines={activeLogLines}
            width={Math.max(12, width - 4)}
            height={Math.max(2, height - 10)}
            follow={detailMode === 'output' && ACTIVE_STATUSES.has(selectedJob.status)}
            isActive={false}
            ascii={asciiMode}
          />
        </Box>
      )}
    </Panel>
  );
});
