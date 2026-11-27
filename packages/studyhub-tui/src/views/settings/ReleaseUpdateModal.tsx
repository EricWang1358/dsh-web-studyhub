import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, normalizeAsciiChrome, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import { describeUpdateStatusBadge, type UpdateViewShape } from './workspace-model.js';

export interface ReleaseUpdateModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  snoozeBusy: boolean;
  info: UpdateViewShape | null;
  error: string | null;
  onRefresh: () => void;
  onToggleSnooze: () => void;
  onClose: () => void;
}

export const ReleaseUpdateModal = memo(function ReleaseUpdateModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  snoozeBusy,
  info,
  error,
  onRefresh,
  onToggleSnooze,
  onClose,
}: ReleaseUpdateModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';

  useKeyScope({
    id: 'settings:workspace:update-modal',
    active: isActive,
    onKey: (input, key) => {
      if (key.escape || (isPlainKey(input, key) && input === 'q')) {
        onClose();
        return true;
      }
      if (!isPlainKey(input, key)) return false;
      if (input === 'r') {
        onRefresh();
        return true;
      }
      if (input === 'z' && info?.latest && info?.newer && !snoozeBusy) {
        onToggleSnooze();
        return true;
      }
      return false;
    },
  });

  const statusBadge = describeUpdateStatusBadge(info, loading, error, lang, asciiMode);
  const currentText = info?.current ? `v${info.current}` : '-';
  const latestText = info?.latest ? `v${info.latest}` : '-';
  const publishedDate = info?.publishedAt ? info.publishedAt.slice(0, 10) : '-';
  const releaseUrl = info?.url || '-';
  const rawNotes = typeof info?.notes === 'string' ? info.notes.replace(/\r\n?/g, '\n').trim() : '';
  const sanitizedNotes = rawNotes ? normalizeAsciiChrome(rawNotes, asciiMode) : '';
  const noteLines = sanitizedNotes
    ? wrapDisplay(sanitizedNotes, contentW)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .slice(0, 4)
    : [];

  const modalHints = [
    ...(info?.latest && info?.newer
      ? [{ key: 'z', label: info.snoozed ? t(lang, '取消推迟', 'Unsnooze') : t(lang, '推迟提醒', 'Snooze') }]
      : []),
    { key: 'r', label: t(lang, '重新检查', 'Recheck') },
    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
  ];

  return (
    <Modal
      title={t(lang, '检查版本更新', 'Release Update Check')}
      subtitle={info?.current ? `v${info.current}` : undefined}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={modalHints}
    >
      {loading && !info ? (
        <Spinner label={t(lang, `正在检查最新版本${ell}`, `Checking latest release${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.muted}>{t(lang, '当前:', 'Current:')}</Text>
            <Text color={theme.text} bold>
              {currentText}
            </Text>
            <Text color={theme.muted}>{t(lang, '最新:', 'Latest:')}</Text>
            <Text color={info?.newer ? theme.accent : theme.text} bold>
              {latestText}
            </Text>
            <Badge label={statusBadge.label} tone={statusBadge.tone} variant="soft" />
          </Box>
          <Text color={theme.muted}>
            {truncateDisplay(
              `${t(lang, '发布日期:', 'Published:')} ${publishedDate}${sep}${t(lang, '自动检查:', 'Auto:')} ${
                info?.autoCheck === false ? t(lang, '关', 'Off') : t(lang, '开', 'On')
              }`,
              contentW,
              ell,
            )}
          </Text>
          <Text color={theme.dim}>{truncateDisplay(`${t(lang, '发布页:', 'URL:')} ${releaseUrl}`, contentW, ell)}</Text>

          {info?.pendingRestart ? (
            <Text color={theme.accent}>
              {truncateDisplay(
                t(lang, `新版本 v${info.pendingRestart} 已安装，重启后生效。`, `v${info.pendingRestart} is installed; restart to activate.`),
                contentW,
                ell,
              )}
            </Text>
          ) : null}

          {info?.error ? (
            <Text color={theme.warning}>
              {truncateDisplay(
                info.error === 'network'
                  ? t(lang, '网络不可达或处于离线状态；稍后可按 [r] 重试。', 'Offline or network unreachable; press [r] to retry later.')
                  : t(lang, `检查返回异常 (${info.error})；稍后可按 [r] 重试。`, `Check warning (${info.error}); press [r] to retry later.`),
                contentW,
                ell,
              )}
            </Text>
          ) : null}

          {error ? (
            <Text color={theme.error} wrap="wrap">
              {normalizeAsciiChrome(error, asciiMode)}
            </Text>
          ) : null}

          {noteLines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.muted} bold>
                {t(lang, '更新说明:', 'Release Notes:')}
              </Text>
              {noteLines.map((line, idx) => (
                <Text key={`note-${idx}`} color={theme.text}>
                  {truncateDisplay(line, contentW, ell)}
                </Text>
              ))}
            </Box>
          ) : null}

          {loading ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在重新检查${ell}`, `Rechecking${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
