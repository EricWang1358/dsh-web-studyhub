import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, normalizeAsciiChrome, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { displayWidth, padDisplay, truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import {
  describeUsageReportState,
  truncatePathMiddle,
  type UsageFrequencyStatusShape,
  type UsageReportPeriod,
  type UsageReportShape,
} from './workspace-model.js';

export interface UsageReportModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  actionBusy: boolean;
  period: UsageReportPeriod;
  usageStatus: UsageFrequencyStatusShape | null;
  report: UsageReportShape | null;
  error: string | null;
  lastExportPath: string | null;
  onSelectPeriod: (period: UsageReportPeriod) => void;
  onTogglePause: () => void;
  onExport: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export const UsageReportModal = memo(function UsageReportModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  actionBusy,
  period,
  usageStatus,
  report,
  error,
  lastExportPath,
  onSelectPeriod,
  onTogglePause,
  onExport,
  onRefresh,
  onClose,
}: UsageReportModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';

  useKeyScope({
    id: 'settings:workspace:usage-report',
    active: isActive,
    onKey: (input, key) => {
      if (key.escape || (isPlainKey(input, key) && input === 'q')) {
        onClose();
        return true;
      }
      if (!isPlainKey(input, key)) return false;
      if (input === '1') {
        onSelectPeriod(7);
        return true;
      }
      if (input === '2') {
        onSelectPeriod(30);
        return true;
      }
      if (input === '3') {
        onSelectPeriod('all');
        return true;
      }
      if (input === 'r') {
        onRefresh();
        return true;
      }
      if (input === 'p' && usageStatus?.enabled && !actionBusy) {
        onTogglePause();
        return true;
      }
      if (input === 'e' && !actionBusy) {
        onExport();
        return true;
      }
      return false;
    },
  });

  const stateBadge = describeUsageReportState(usageStatus, lang);
  const periodLabel =
    period === 7
      ? t(lang, '最近 7 天', 'Last 7d')
      : period === 30
        ? t(lang, '最近 30 天', 'Last 30d')
        : t(lang, '全部时间', 'All time');
  const periodOptions: ReadonlyArray<{ id: UsageReportPeriod; keyLabel: string; text: string }> = [
    { id: 7, keyLabel: '1', text: t(lang, '7天', '7d') },
    { id: 30, keyLabel: '2', text: t(lang, '30天', '30d') },
    { id: 'all', keyLabel: '3', text: t(lang, '全部', 'All') },
  ];

  const interactions = Number(report?.summary?.interactions) || 0;
  const activeDays = Number(report?.summary?.daysWithData) || 0;
  const distinctControls = Number(report?.summary?.distinctControls) || 0;
  const topRows = Array.isArray(report?.ranking) ? report.ranking.slice(0, 5) : [];
  const maxCount = Math.max(1, topRows[0]?.count || 1);
  const fillCh = asciiMode ? '#' : '█';
  const emptyCh = asciiMode ? '-' : '░';
  const barW = 10;

  const rawObs = report?.observations?.[0]?.text
    ? String(report.observations[0].text).replace(/\s+/g, ' ').trim()
    : '';
  const obsNormalized = rawObs ? normalizeAsciiChrome(rawObs, asciiMode) : '';
  const obsLines = obsNormalized
    ? wrapDisplay(obsNormalized, contentW)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .slice(0, 2)
    : [];

  const modalHints = [
    { key: '1-3', label: t(lang, '范围', 'Period') },
    ...(usageStatus?.enabled
      ? [{ key: 'p', label: usageStatus.paused ? t(lang, '继续', 'Resume') : t(lang, '暂停', 'Pause') }]
      : []),
    { key: 'e', label: t(lang, '导出', 'Export') },
    { key: 'r', label: t(lang, '刷新', 'Refresh') },
    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
  ];

  return (
    <Modal
      title={t(lang, '本地使用频率报表', 'Usage Frequency Report')}
      subtitle={periodLabel}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={modalHints}
    >
      {loading && !report ? (
        <Spinner label={t(lang, `正在汇总使用记录${ell}`, `Loading usage report${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.muted}>{t(lang, '状态:', 'Status:')}</Text>
            <Badge label={stateBadge.label} tone={stateBadge.tone} variant="soft" />
            <Text color={theme.dim}>{sep.trim()}</Text>
            {periodOptions.map((opt) => (
              <Text
                key={String(opt.id)}
                color={period === opt.id ? theme.accent : theme.muted}
                bold={period === opt.id}
              >
                {`[${opt.keyLabel}] ${opt.text}`}
              </Text>
            ))}
          </Box>

          <Text color={theme.text}>
            {truncateDisplay(
              t(
                lang,
                `互动 ${interactions} 次${sep}活跃 ${activeDays} 天${sep}控件 ${distinctControls} 个`,
                `Interactions: ${interactions}${sep}Active days: ${activeDays}${sep}Controls: ${distinctControls}`,
              ),
              contentW,
              ell,
            )}
          </Text>

          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>
              {t(lang, '最常用控件:', 'Top Controls:')}
            </Text>
            {topRows.length === 0 ? (
              <Text color={theme.dim}>
                {truncateDisplay(
                  t(lang, '（当前周期暂无使用记录）', '(No usage records in this period)'),
                  contentW,
                  ell,
                )}
              </Text>
            ) : (
              topRows.map((row) => {
                const labelText = normalizeAsciiChrome(row.name || row.key, asciiMode);
                const pct = Math.round((Number(row.share) || 0) * 100);
                const stat = `${row.count} (${pct}%)`;
                const filled = row.count > 0 ? Math.max(1, Math.round((row.count / maxCount) * barW)) : 0;
                const bar = `${fillCh.repeat(filled)}${emptyCh.repeat(Math.max(0, barW - filled))}`;
                const nameW = Math.max(10, contentW - barW - displayWidth(stat) - 3);
                const line = `${padDisplay(truncateDisplay(labelText, nameW, ell), nameW)} ${bar} ${stat}`;
                return (
                  <Text key={row.key} color={theme.text}>
                    {truncateDisplay(line, contentW, ell)}
                  </Text>
                );
              })
            )}
          </Box>

          {obsLines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {obsLines.map((line, idx) => (
                <Text key={`obs-${idx}`} color={theme.dim}>
                  {truncateDisplay(line, contentW, ell)}
                </Text>
              ))}
            </Box>
          ) : null}

          {lastExportPath ? (
            <Text color={theme.success}>
              {(() => {
                const prefix = t(lang, '已导出: ', 'Exported: ');
                const maxPathW = Math.max(10, contentW - displayWidth(prefix));
                return `${prefix}${truncatePathMiddle(lastExportPath, maxPathW, ell)}`;
              })()}
            </Text>
          ) : null}

          {error ? (
            <Text color={theme.error} wrap="wrap">
              {normalizeAsciiChrome(error, asciiMode)}
            </Text>
          ) : null}

          {loading ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在刷新报表${ell}`, `Refreshing report${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
