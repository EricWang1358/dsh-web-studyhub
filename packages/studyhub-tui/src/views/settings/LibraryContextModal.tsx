import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { normalizeAsciiChrome, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { truncatePathMiddle, type LibraryContextShape } from './workspace-model.js';

export interface LibraryContextModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  actionBusy: boolean;
  contextData: LibraryContextShape | null;
  fallbackRoot: string;
  error: string | null;
  lastExportPath: string | null;
  onRefresh: () => void;
  onExport: () => void;
  onClose: () => void;
}

export const LibraryContextModal = memo(function LibraryContextModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  actionBusy,
  contextData,
  fallbackRoot,
  error,
  lastExportPath,
  onRefresh,
  onExport,
  onClose,
}: LibraryContextModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';
  const bullet = asciiMode ? '- ' : '• ';

  useKeyScope({
    id: 'settings:workspace:library-context',
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
      if (input === 'e' && !actionBusy) {
        onExport();
        return true;
      }
      return false;
    },
  });

  const rootText = contextData?.library || fallbackRoot || '-';
  const todayText = contextData?.today || '-';
  const tzText = contextData?.timeZone || '-';
  const focusCourse = contextData?.focus?.course ? normalizeAsciiChrome(contextData.focus.course, asciiMode) : '-';
  const focusRole = contextData?.focus?.role ? normalizeAsciiChrome(contextData.focus.role, asciiMode) : '-';
  const sourcesCount = Number(contextData?.counts?.sources) || 0;
  const decksCount = Number(contextData?.counts?.decks) || 0;
  const archivedDecksCount = Number(contextData?.counts?.archivedDecks) || 0;
  const draftsCount = Number(contextData?.counts?.drafts) || 0;
  const cardsCount = Number(contextData?.counts?.cards) || 0;
  const allCourses = Array.isArray(contextData?.courses) ? contextData.courses : [];
  const totalCourses = Number(contextData?.coursesPage?.total ?? allCourses.length) || 0;
  const shownCourses = allCourses.slice(0, 4);
  const extraCourses = Math.max(0, totalCourses - shownCourses.length);
  const areasList = Array.isArray(contextData?.areas) ? contextData.areas : [];
  const areasText = areasList.length > 0 ? areasList.join(', ') : '-';

  const rootPrefix = t(lang, '学习库: ', 'Library: ');
  const rootMaxW = Math.max(10, contentW - displayWidth(rootPrefix));

  const modalHints = [
    { key: 'e', label: t(lang, '导出 JSON', 'Export JSON') },
    { key: 'r', label: t(lang, '刷新', 'Refresh') },
    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
  ];

  return (
    <Modal
      title={t(lang, '学习库上下文总览', 'Library Context Overview')}
      subtitle={contextData?.today || undefined}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={modalHints}
    >
      {loading && !contextData ? (
        <Spinner label={t(lang, `正在读取学习库上下文${ell}`, `Loading library context${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.primary} bold>
            {`${rootPrefix}${truncatePathMiddle(rootText, rootMaxW, ell)}`}
          </Text>
          <Text color={theme.muted}>
            {truncateDisplay(
              t(lang, `日期: ${todayText}${sep}时区: ${tzText}`, `Date: ${todayText}${sep}TimeZone: ${tzText}`),
              contentW,
              ell,
            )}
          </Text>
          <Text color={theme.text}>
            {truncateDisplay(
              t(
                lang,
                `当前焦点: ${focusCourse}${sep}角色: ${focusRole}`,
                `Focus: ${focusCourse}${sep}Role: ${focusRole}`,
              ),
              contentW,
              ell,
            )}
          </Text>
          <Text color={theme.text}>
            {truncateDisplay(
              t(
                lang,
                `资料 ${sourcesCount}${sep}题组 ${decksCount} (+${archivedDecksCount} 归档)${sep}草稿 ${draftsCount}${sep}卡片 ${cardsCount}`,
                `Sources ${sourcesCount}${sep}Decks ${decksCount} (+${archivedDecksCount} archived)${sep}Drafts ${draftsCount}${sep}Cards ${cardsCount}`,
              ),
              contentW,
              ell,
            )}
          </Text>

          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>
              {t(lang, `课程分布 (${totalCourses}):`, `Courses (${totalCourses}):`)}
            </Text>
            {shownCourses.length === 0 ? (
              <Text color={theme.dim}>
                {truncateDisplay(t(lang, '（暂无课程）', '(No courses)'), contentW, ell)}
              </Text>
            ) : (
              shownCourses.map((courseName, idx) => {
                const label = courseName
                  ? normalizeAsciiChrome(courseName, asciiMode)
                  : t(lang, '(未分类)', '(Uncategorized)');
                return (
                  <Text key={`${courseName}-${idx}`} color={theme.text}>
                    {truncateDisplay(`${bullet}${label}`, contentW, ell)}
                  </Text>
                );
              })
            )}
            {extraCourses > 0 ? (
              <Text color={theme.dim}>
                {truncateDisplay(t(lang, `+${extraCourses} 更多课程`, `+${extraCourses} more`), contentW, ell)}
              </Text>
            ) : null}
          </Box>

          <Box marginTop={1}>
            <Text color={theme.muted}>
              {truncateDisplay(
                t(lang, `可用上下文域: ${areasText}`, `Areas: ${areasText}`),
                contentW,
                ell,
              )}
            </Text>
          </Box>

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
              <Spinner label={t(lang, `正在刷新上下文${ell}`, `Refreshing context${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
